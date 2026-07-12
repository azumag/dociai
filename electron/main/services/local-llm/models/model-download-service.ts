// Downloads a remote GGUF file with progress/cancel/retry/resume (#76), and only ever hands the
// result to model-installer.ts (which re-validates hash + GGUF header) — this file never itself
// declares a download "installed". See local-import.ts for the sibling local-file version of the
// same "never trust unverified bytes" discipline this mirrors.
//
// State machine: queued -> downloading -> verifying -> installing -> completed
//                             |               |
//                             +-> paused (cancelled, kept partial; or recovered at restart)
//                             +-> failed (terminal until retry())
//                             +-> cancelled (partial discarded, terminal)
//
// DownloadJobStore (see download-job-store.ts) is the single source of truth for job state across
// attempts and across app restarts; every mutation this file makes is persisted there before the
// in-memory picture is trusted again on the next retry attempt.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import dns from "node:dns";
import { ServiceError, errorFromHttpStatus, normalizeServiceError } from "../../service-error";
import { retryWithPolicy } from "../../retry-policy";
import type { RetryPolicy } from "../../retry-policy";
import { ServiceRuntime } from "../../service-runtime";
import { MODEL_DIR_NAMES, modelsSubdir, sanitizeIdSegment } from "./model-paths";
import { installVerifiedDownload } from "./model-installer";
import type { DownloadJobStore } from "./download-job-store";
import { createGuardedLookup, isPublicAddress, resolveDownloadSourceUrl } from "./model-source-resolver";
import type { AddressPolicy, DnsLookupOne } from "./model-source-resolver";
import { ProgressTracker, createThrottledEmitter } from "./download-progress";
import { DEFAULT_DOWNLOAD_OVERHEAD_BYTES, getDiskSpace, hasSufficientSpace } from "./disk-space";
import type { InstalledRegistry } from "./installed-registry";
import { parseSecretKey } from "../../../secrets/secret-keys";
import type { SecretStore } from "../../../../shared/secret-contract";
import type {
  DownloadJobRecord,
  DownloadJobSource,
  DownloadJobState,
  DownloadProgressEvent,
  ModelLicense,
} from "../../../../shared/local-llm/model-contract";

const SERVICE_ID = "local-llm:download";
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;
/** Secret key resolved from #42's SecretStore for gated Hugging Face repos. Not user-facing UI —
 * out of scope here — but the settings UI (out of scope for #76) is expected to `secrets.set`
 * this same key. */
export const HUGGING_FACE_TOKEN_SECRET_KEY = "local-llm.huggingface-token";
const ACTIVE_STATES: readonly DownloadJobState[] = ["queued", "downloading", "verifying", "installing"];
const RETRYABLE_FROM_STATES: readonly DownloadJobState[] = ["failed", "paused", "cancelled"];

function mapStreamError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  const err = error as (NodeJS.ErrnoException & { name?: string }) | undefined;
  if (err?.code === "EADDRBLOCKED") return new ServiceError("BAD_REQUEST", err.message ?? "refusing to connect to a disallowed address", { serviceId: SERVICE_ID, retryable: false });
  if (err?.name === "AbortError" || err?.code === "ABORT_ERR") return new ServiceError("CANCELLED", "download cancelled", { serviceId: SERVICE_ID, retryable: false });
  return new ServiceError("NETWORK", err?.message ?? "network error", { serviceId: SERVICE_ID, retryable: true });
}

function parseRetryAfterMs(value: string | string[] | undefined): number | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const parsedDate = Date.parse(raw);
  return Number.isNaN(parsedDate) ? undefined : Math.max(0, parsedDate - Date.now());
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

/** Unifies http.request/https.request's slightly different (but call-compatible for our
 * purposes) overload signatures behind one shape, so #singleRequest can pick either transport at
 * runtime by URL protocol without fighting Node's overload resolution. */
type RequestFn = (url: URL, options: Record<string, unknown>, callback: (response: http.IncomingMessage) => void) => http.ClientRequest;

export type ModelDownloadDeps = {
  now?: () => number;
  randomId?: () => string;
  isAddressAllowed?: AddressPolicy;
  dnsLookup?: DnsLookupOne;
  diskSpace?: (targetPath: string) => Promise<{ freeBytes: number; totalBytes: number }>;
  overheadBytes?: number;
  progressIntervalMs?: number;
  maxRedirects?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Test-only escape hatch: allows a `kind: "url"` source to resolve to a plain-http URL so
   * tests can hit a real local mock server without standing up self-signed TLS. Never set by the
   * shipped default construction in electron/main/index.ts — see resolveDownloadSourceUrl. */
  allowInsecureSources?: boolean;
  /** Hostnames the resolved HF token (#42's SecretStore) may be attached to. Keyed by hostname
   * rather than by DownloadJobSource.kind, since a catalog (`kind: "url"`) entry can just as
   * legitimately point at a gated huggingface.co file as an ad-hoc `kind: "huggingface"` request
   * — the token belongs on the request, not on one particular way of describing the source.
   * Defaults to huggingface.co; tests override this to point at their own mock server instead of
   * ever needing a real connection to huggingface.co. */
  gatedHosts?: string[];
  httpRequest?: typeof http.request;
  httpsRequest?: typeof https.request;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type DownloadServiceStartInput = {
  source: DownloadJobSource;
  displayName: string;
  fileName: string;
  expectedSizeBytes: number;
  expectedSha256?: string;
  license: ModelLicense;
  catalogModelId?: string;
};

export class ModelDownloadService {
  readonly runtime = new ServiceRuntime(SERVICE_ID);
  #now: () => number;
  #randomId: () => string;
  #isAddressAllowed: AddressPolicy;
  #dnsLookup: DnsLookupOne | undefined;
  #diskSpace: (targetPath: string) => Promise<{ freeBytes: number; totalBytes: number }>;
  #overheadBytes: number;
  #maxRedirects: number;
  #maxAttempts: number;
  #retryBaseDelayMs: number;
  #retryMaxDelayMs: number;
  #connectTimeoutMs: number;
  #idleTimeoutMs: number;
  #progressIntervalMs: number;
  #allowInsecureSources: boolean;
  #gatedHosts: Set<string>;
  #sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  #httpRequest: typeof http.request;
  #httpsRequest: typeof https.request;
  #pending = new Map<string, Promise<void>>();
  #cancelIntents = new Map<string, { deletePartial: boolean }>();

  constructor(
    private readonly modelsDir: string,
    private readonly jobStore: DownloadJobStore,
    private readonly registry: InstalledRegistry,
    private readonly secretStore: SecretStore,
    private readonly emitProgressEvent: (event: DownloadProgressEvent) => void = () => {},
    deps: ModelDownloadDeps = {},
  ) {
    this.#now = deps.now ?? (() => Date.now());
    this.#randomId = deps.randomId ?? (() => crypto.randomUUID());
    this.#isAddressAllowed = deps.isAddressAllowed ?? isPublicAddress;
    this.#dnsLookup = deps.dnsLookup;
    this.#diskSpace = deps.diskSpace ?? getDiskSpace;
    this.#overheadBytes = deps.overheadBytes ?? DEFAULT_DOWNLOAD_OVERHEAD_BYTES;
    this.#maxRedirects = deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.#maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#retryBaseDelayMs = deps.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.#retryMaxDelayMs = deps.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.#connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#progressIntervalMs = deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.#allowInsecureSources = deps.allowInsecureSources ?? false;
    this.#gatedHosts = new Set(deps.gatedHosts ?? ["huggingface.co"]);
    this.#httpRequest = deps.httpRequest ?? http.request;
    this.#httpsRequest = deps.httpsRequest ?? https.request;
    this.#sleep = deps.sleep;
  }

  // -------------------------------------------------------------------------------------------
  // Public API (backs the start/cancel/retry/status IPC surface)
  // -------------------------------------------------------------------------------------------

  async start(input: DownloadServiceStartInput): Promise<DownloadJobRecord> {
    if (!input.fileName || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.gguf$/i.test(input.fileName)) {
      throw new ServiceError("BAD_REQUEST", "fileName must be a bare .gguf file name", { serviceId: SERVICE_ID, retryable: false });
    }
    if (!input.displayName) throw new ServiceError("BAD_REQUEST", "displayName is required", { serviceId: SERVICE_ID, retryable: false });
    if (!Number.isFinite(input.expectedSizeBytes) || input.expectedSizeBytes <= 0) throw new ServiceError("BAD_REQUEST", "expectedSizeBytes must be a positive number", { serviceId: SERVICE_ID, retryable: false });
    if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.expectedSha256)) throw new ServiceError("BAD_REQUEST", "expectedSha256 must be a 64-character hex string", { serviceId: SERVICE_ID, retryable: false });
    if (!input.license?.id || !input.license.name) throw new ServiceError("BAD_REQUEST", "license is required", { serviceId: SERVICE_ID, retryable: false });
    // Fails fast on a malformed source (bad HF repo/revision/filename, non-https URL, embedded
    // credentials, ...) before any job record is even created.
    resolveDownloadSourceUrl(input.source, { allowInsecure: this.#allowInsecureSources });

    const disk = await this.#diskSpace(this.modelsDir);
    if (!hasSufficientSpace(disk.freeBytes, input.expectedSizeBytes, this.#overheadBytes)) {
      throw new ServiceError("UNAVAILABLE", `insufficient disk space: need ${input.expectedSizeBytes + this.#overheadBytes} bytes, ${disk.freeBytes} bytes free`, { serviceId: SERVICE_ID, retryable: false });
    }

    const nowIso = this.#iso();
    const job: DownloadJobRecord = {
      id: this.#randomId(),
      ...(input.catalogModelId ? { catalogModelId: input.catalogModelId } : {}),
      displayName: input.displayName,
      fileName: input.fileName,
      source: input.source,
      expectedSizeBytes: input.expectedSizeBytes,
      ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256.toLowerCase() } : {}),
      license: input.license,
      licenseAcceptedAt: nowIso,
      state: "queued",
      bytesDownloaded: 0,
      attempt: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const persisted = await this.#persist(job);
    this.#run(persisted);
    return persisted;
  }

  /** `deletePartial` defaults to true (a UI "Cancel" action means "stop and discard"); pass
   * `false` to keep the partial file + resume validator so a later retry() can resume instead of
   * restarting from scratch. Returns false when the job does not exist or is already terminal
   * with nothing to cancel. */
  async cancel(jobId: string, options: { deletePartial?: boolean } = {}): Promise<boolean> {
    const deletePartial = options.deletePartial ?? true;
    this.#cancelIntents.set(jobId, { deletePartial });
    if (this.runtime.registry.cancel(jobId, "cancelled")) return true;
    // No active in-flight *download* request for this job. Either it is already idle (the abort
    // signal above will never fire, so consume the intent synchronously below), or it is past the
    // downloading phase (verifying/installing — a short, non-resumable window with no cancel path,
    // matching local-import.ts's commitImport, which is likewise not cancellable mid-flight).
    this.#cancelIntents.delete(jobId);
    if (this.#pending.has(jobId)) return false;
    const existing = await this.jobStore.get(jobId);
    if (!existing || !ACTIVE_STATES.includes(existing.state)) return false;
    if (deletePartial) {
      await fsp.rm(this.#partialAbsolutePath(existing), { force: true }).catch(() => {});
      await this.#persist({ ...existing, state: "cancelled", bytesDownloaded: 0, partialRelativePath: undefined, resumeValidator: undefined, updatedAt: this.#iso() });
    } else {
      await this.#persist({ ...existing, state: "paused", updatedAt: this.#iso() });
    }
    return true;
  }

  async retry(jobId: string): Promise<DownloadJobRecord> {
    const existing = await this.jobStore.get(jobId);
    if (!existing) throw new ServiceError("BAD_REQUEST", "download job was not found", { serviceId: SERVICE_ID, retryable: false });
    if (!RETRYABLE_FROM_STATES.includes(existing.state)) throw new ServiceError("CONFLICT", `cannot retry a job in state "${existing.state}"`, { serviceId: SERVICE_ID, retryable: false });
    if (this.#pending.has(jobId)) throw new ServiceError("CONFLICT", "download job is already active", { serviceId: SERVICE_ID, retryable: false });

    const remaining = Math.max(0, existing.expectedSizeBytes - existing.bytesDownloaded);
    const disk = await this.#diskSpace(this.modelsDir);
    if (!hasSufficientSpace(disk.freeBytes, remaining, this.#overheadBytes)) {
      throw new ServiceError("UNAVAILABLE", `insufficient disk space to resume: need ${remaining + this.#overheadBytes} bytes, ${disk.freeBytes} bytes free`, { serviceId: SERVICE_ID, retryable: false });
    }
    const requeued = await this.#persist({ ...existing, state: "queued", error: undefined, updatedAt: this.#iso() });
    this.#run(requeued);
    return requeued;
  }

  async status(jobId: string): Promise<DownloadJobRecord | null> {
    return this.jobStore.get(jobId);
  }

  async list(): Promise<DownloadJobRecord[]> {
    const { jobs } = await this.jobStore.list();
    return jobs;
  }

  /** Test/internal seam: resolves once the given job reaches a terminal or paused state. Not
   * part of the IPC surface — callers over IPC poll status()/subscribe to progress events
   * instead, since a real multi-GB download must never block an IPC round-trip. */
  async waitForSettled(jobId: string): Promise<DownloadJobRecord | null> {
    await this.#pending.get(jobId);
    return this.jobStore.get(jobId);
  }

  /** Reclassifies every job left in a non-terminal state by an unclean shutdown (no in-memory
   * controller survives a restart) into either "paused" (resumable: a partial file and resume
   * validator both survived) or "failed" (cleanup candidate: partial removed, must restart from
   * scratch). Call once at startup before serving any IPC request. */
  async recoverOnStartup(): Promise<{ resumed: string[]; failed: string[]; reconciled: string[] }> {
    const { jobs } = await this.jobStore.list();
    const resumed: string[] = [];
    const failed: string[] = [];
    const reconciled: string[] = [];
    for (const job of jobs) {
      if (!ACTIVE_STATES.includes(job.state)) continue;
      if (job.expectedSha256) {
        const existing = await this.registry.findByHash(job.expectedSha256);
        if (existing) {
          await this.#persist({ ...job, state: "completed", installedModelId: existing.id, bytesDownloaded: job.expectedSizeBytes, partialRelativePath: undefined, resumeValidator: undefined, error: undefined, updatedAt: this.#iso() });
          reconciled.push(job.id);
          continue;
        }
      }
      const partialPath = this.#partialAbsolutePath(job);
      const partialExists = await fsp.access(partialPath).then(() => true, () => false);
      if (partialExists && job.resumeValidator && job.bytesDownloaded > 0) {
        await this.#persist({ ...job, state: "paused", error: { code: "INTERRUPTED", message: "interrupted by an app restart; resumable", retryable: true }, updatedAt: this.#iso() });
        resumed.push(job.id);
      } else {
        if (partialExists) await fsp.rm(partialPath, { force: true }).catch(() => {});
        await this.#persist({ ...job, state: "failed", bytesDownloaded: 0, partialRelativePath: undefined, resumeValidator: undefined, error: { code: "INTERRUPTED", message: "interrupted by an app restart before enough data was saved to resume", retryable: false }, updatedAt: this.#iso() });
        failed.push(job.id);
      }
    }
    return { resumed, failed, reconciled };
  }

  dispose(): void {
    this.runtime.dispose();
  }

  // -------------------------------------------------------------------------------------------
  // Background job runner
  // -------------------------------------------------------------------------------------------

  #run(initialJob: DownloadJobRecord): void {
    // #execute() is designed to always resolve (every internal failure is caught and turned into
    // a persisted job state) — this .catch is only a last-resort safety net so a truly unexpected
    // failure (e.g. the job store itself becoming unwritable) can never surface as an unhandled
    // rejection or wedge waitForSettled() forever.
    const promise = this.#execute(initialJob).catch((error) => {
      console.error(`[dociai:local-llm-download] unexpected failure for job ${initialJob.id}`, error);
    });
    this.#pending.set(initialJob.id, promise);
    void promise.finally(() => {
      if (this.#pending.get(initialJob.id) === promise) this.#pending.delete(initialJob.id);
    });
  }

  async #execute(initialJob: DownloadJobRecord): Promise<void> {
    let current = await this.#persist({ ...initialJob, state: "downloading", partialRelativePath: this.#partialRelativePath(initialJob), updatedAt: this.#iso() });
    const handle = this.runtime.createRequest({ ownerId: "local-llm", requestId: current.id });
    try {
      current = await this.#downloadWithRetry(current, handle.context.signal);
      handle.complete(current);

      current = await this.#persist({ ...current, state: "verifying", updatedAt: this.#iso() });
      this.#emitProgress(current);

      const huggingFace = current.source.kind === "huggingface" ? { repo: current.source.repo, revision: current.source.revision, filename: current.source.filename } : undefined;
      current = await this.#persist({ ...current, state: "installing", updatedAt: this.#iso() });
      this.#emitProgress(current);
      const result = await installVerifiedDownload({
        modelsDir: this.modelsDir,
        registry: this.registry,
        partialPath: this.#partialAbsolutePath(current),
        job: current,
        sourceUrl: resolveDownloadSourceUrl(current.source, { allowInsecure: this.#allowInsecureSources }).toString(),
        huggingFace,
      });

      if (result.status === "installed" || result.status === "duplicate") {
        const model = result.status === "installed" ? result.model : result.existing;
        current = await this.#persist({ ...current, state: "completed", bytesDownloaded: current.expectedSizeBytes, installedModelId: model.id, partialRelativePath: undefined, resumeValidator: undefined, error: undefined, updatedAt: this.#iso() });
        this.runtime.health.report({ type: "completed", serviceId: SERVICE_ID, requestId: current.id, at: this.#now() });
        this.#emitProgress(current);
        return;
      }

      // Verification failed: never retried automatically (bad bytes need a fresh download, not a
      // tight retry loop) — the job lands in "failed" and an explicit retry() starts over. Still
      // propagate the installer's own retryable assessment (e.g. a hash mismatch is plausibly a
      // transient transfer corruption worth retrying; an invalid GGUF from a bad catalog URL is
      // not) so a future UI can decide whether to suggest retry() at all.
      const error = { code: "BAD_REQUEST" as const, message: result.reason, retryable: result.retryable };
      current = await this.#persist({ ...current, state: "failed", bytesDownloaded: 0, partialRelativePath: undefined, resumeValidator: undefined, error, updatedAt: this.#iso() });
      this.runtime.health.report({ type: "failed", serviceId: SERVICE_ID, requestId: current.id, at: this.#now(), error });
      this.#emitProgress(current);
    } catch (error) {
      handle.fail(error instanceof Error ? error : new Error(String(error)));
      const normalized = normalizeServiceError(error, { serviceId: SERVICE_ID, signal: handle.context.signal });
      // `current` here is stale: it was last reassigned either at #execute's very start or after
      // #downloadWithRetry *succeeds* — on a throw, #attemptStream had already been persisting
      // real progress (bytesDownloaded, resumeValidator, attempt) straight to the job store
      // throughout the download, so that (not the stale local variable) is the source of truth
      // for whatever terminal state we write next.
      const latest = (await this.jobStore.get(current.id)) ?? current;
      if (normalized.code === "CANCELLED") {
        const intent = this.#cancelIntents.get(current.id);
        this.#cancelIntents.delete(current.id);
        // No intent recorded means this was an *external* abort (service disposed / app
        // quitting), not a user-requested cancel — default to keeping the partial file so it is
        // resumable on the next launch, exactly like recoverOnStartup() would find it.
        const deletePartial = intent?.deletePartial ?? false;
        if (deletePartial) {
          await fsp.rm(this.#partialAbsolutePath(latest), { force: true }).catch(() => {});
          current = await this.#persist({ ...latest, state: "cancelled", bytesDownloaded: 0, partialRelativePath: undefined, resumeValidator: undefined, error: undefined, updatedAt: this.#iso() });
        } else {
          current = await this.#persist({ ...latest, state: "paused", error: undefined, updatedAt: this.#iso() });
        }
        this.#emitProgress(current);
        return;
      }
      const shape = normalized.toJSON();
      current = await this.#persist({ ...latest, state: "failed", error: { code: shape.code, message: shape.message, retryable: shape.retryable }, updatedAt: this.#iso() });
      this.runtime.health.report({ type: "failed", serviceId: SERVICE_ID, requestId: current.id, at: this.#now(), error: shape });
      this.#emitProgress(current);
    }
  }

  async #downloadWithRetry(initialJob: DownloadJobRecord, signal: AbortSignal): Promise<DownloadJobRecord> {
    const policy: RetryPolicy = { maxAttempts: this.#maxAttempts, baseDelayMs: this.#retryBaseDelayMs, maxDelayMs: this.#retryMaxDelayMs, jitterRatio: 0.2 };
    const context = { requestId: initialJob.id, serviceId: SERVICE_ID, generation: 0, ownerId: "local-llm", signal, startedAt: this.#now() };
    await retryWithPolicy(async (attempt) => {
      const latest = (await this.jobStore.get(initialJob.id)) ?? initialJob;
      const current = await this.#persist({ ...latest, state: "downloading", attempt, updatedAt: this.#iso() });
      await this.#attemptStream(current, signal);
    }, policy, context, this.#sleep ? { sleep: this.#sleep } : {});
    const finalJob = await this.jobStore.get(initialJob.id);
    if (!finalJob) throw new ServiceError("UNKNOWN", "download job disappeared during download", { serviceId: SERVICE_ID, retryable: false });
    return finalJob;
  }

  // -------------------------------------------------------------------------------------------
  // Single attempt: resolves the URL, follows redirects (bounded, https-only, credential
  // stripped cross-host), handles Range resume, and streams the response to the partial file.
  // -------------------------------------------------------------------------------------------

  async #attemptStream(job: DownloadJobRecord, signal: AbortSignal): Promise<void> {
    const initialUrl = resolveDownloadSourceUrl(job.source, { allowInsecure: this.#allowInsecureSources });
    const partialPath = this.#partialAbsolutePath(job);
    await fsp.mkdir(path.dirname(partialPath), { recursive: true, mode: 0o700 });

    const authorization = await this.#authorizationHeader(initialUrl);
    let currentUrl = initialUrl;
    let attachAuthorization = Boolean(authorization);
    let redirectCount = 0;
    let sendRange = job.bytesDownloaded > 0 && Boolean(job.resumeValidator);
    let workingJob = job;

    for (;;) {
      if (signal.aborted) throw new ServiceError("CANCELLED", "download cancelled", { serviceId: SERVICE_ID, retryable: false });
      const headers: Record<string, string> = { "User-Agent": "dociai-local-llm/1", Accept: "*/*" };
      if (attachAuthorization && authorization && currentUrl.host === initialUrl.host) headers.Authorization = authorization;
      if (sendRange) {
        headers.Range = `bytes=${workingJob.bytesDownloaded}-`;
        const validatorValue = workingJob.resumeValidator?.etag ?? workingJob.resumeValidator?.lastModified;
        if (validatorValue) headers["If-Range"] = validatorValue;
      }

      const response = await this.#singleRequest(currentUrl, headers, signal);
      const status = response.statusCode ?? 0;

      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        redirectCount += 1;
        if (redirectCount > this.#maxRedirects) throw new ServiceError("BAD_REQUEST", "too many redirects", { serviceId: SERVICE_ID, retryable: false });
        const nextUrl = new URL(response.headers.location, currentUrl);
        if (currentUrl.protocol === "https:" && nextUrl.protocol !== "https:") throw new ServiceError("BAD_REQUEST", "refusing to follow an https to http redirect (downgrade)", { serviceId: SERVICE_ID, retryable: false });
        if (nextUrl.host !== currentUrl.host) attachAuthorization = false;
        currentUrl = nextUrl;
        continue;
      }

      if (status === 416) {
        response.resume();
        // Stored resume offset is no longer valid server-side (resource changed/shrank): drop it
        // and restart this attempt from scratch rather than failing the whole job.
        await fsp.rm(partialPath, { force: true }).catch(() => {});
        workingJob = await this.#persist({ ...workingJob, bytesDownloaded: 0, resumeValidator: undefined, updatedAt: this.#iso() });
        sendRange = false;
        continue;
      }

      if (status < 200 || status >= 300) {
        const retryAfterMs = parseRetryAfterMs(response.headers["retry-after"]);
        response.resume();
        throw errorFromHttpStatus(status, { serviceId: SERVICE_ID, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
      }

      // Only trust a 206 as "resume honored" when we actually asked for a range; a stray 206 to a
      // plain GET (malformed server) must not be treated as an append-in-place.
      const rangeHonored = sendRange && status === 206;
      if (sendRange && !rangeHonored) {
        // Server ignored Range/If-Range and is resending the full body: restart from scratch.
        await fsp.rm(partialPath, { force: true }).catch(() => {});
        workingJob = await this.#persist({ ...workingJob, bytesDownloaded: 0, resumeValidator: undefined, updatedAt: this.#iso() });
      }

      const contentLength = headerString(response.headers["content-length"]);
      const declaredBytes = contentLength !== undefined ? Number(contentLength) : undefined;
      const totalDeclared = rangeHonored && declaredBytes !== undefined ? workingJob.bytesDownloaded + declaredBytes : declaredBytes;
      if (totalDeclared !== undefined && totalDeclared > workingJob.expectedSizeBytes) {
        response.resume();
        throw new ServiceError("BAD_REQUEST", `declared content length (${totalDeclared}) exceeds the expected size (${workingJob.expectedSizeBytes})`, { serviceId: SERVICE_ID, retryable: false });
      }

      const etag = headerString(response.headers.etag);
      const lastModified = headerString(response.headers["last-modified"]);
      if (etag || lastModified) {
        workingJob = await this.#persist({ ...workingJob, resumeValidator: { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) }, updatedAt: this.#iso() });
      }

      await this.#streamToFile(response, partialPath, workingJob, rangeHonored, signal);
      return;
    }
  }

  #streamToFile(response: http.IncomingMessage, partialPath: string, job: DownloadJobRecord, resumed: boolean, signal: AbortSignal): Promise<void> {
    const startOffset = resumed ? job.bytesDownloaded : 0;
    const tracker = new ProgressTracker(5000, this.#now);
    const emitThrottled = createThrottledEmitter<DownloadProgressEvent>(this.#progressIntervalMs, this.emitProgressEvent, this.#now);
    const persistThrottled = createThrottledEmitter<DownloadJobRecord>(this.#progressIntervalMs, (record) => { void this.jobStore.upsert(record); }, this.#now);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => { if (settled) return; settled = true; fn(); };

      const openAndStream = async () => {
        if (!resumed) await fsp.rm(partialPath, { force: true }).catch(() => {});
        const writeStream = fs.createWriteStream(partialPath, resumed ? { flags: "r+", start: startOffset } : { flags: "w" });
        let bytesDownloaded = startOffset;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => response.destroy(new Error("stalled: no data received within the idle timeout")), this.#idleTimeoutMs);
        };
        const onAbort = () => response.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
        signal.addEventListener("abort", onAbort, { once: true });
        const cleanup = () => { if (idleTimer) clearTimeout(idleTimer); signal.removeEventListener("abort", onAbort); };
        let endedNormally = false;

        resetIdleTimer();
        response.on("data", (chunk: Buffer) => {
          resetIdleTimer();
          bytesDownloaded += chunk.length;
          if (bytesDownloaded > job.expectedSizeBytes) {
            cleanup();
            response.destroy();
            writeStream.destroy();
            settle(() => reject(new ServiceError("BAD_REQUEST", `downloaded content exceeds the expected size (${job.expectedSizeBytes} bytes)`, { serviceId: SERVICE_ID, retryable: false })));
            return;
          }
          const snapshot = tracker.snapshot(bytesDownloaded, job.expectedSizeBytes);
          emitThrottled({ jobId: job.id, state: "downloading", bytesDownloaded, totalBytes: job.expectedSizeBytes, bytesPerSecond: snapshot.bytesPerSecond, etaSeconds: snapshot.etaSeconds, percent: snapshot.percent, at: this.#iso() });
          persistThrottled({ ...job, bytesDownloaded, state: "downloading", updatedAt: this.#iso() });
          if (!writeStream.write(chunk)) response.pause();
        });
        writeStream.on("drain", () => response.resume());

        response.on("error", (error) => { cleanup(); writeStream.destroy(); settle(() => reject(mapStreamError(error))); });
        response.on("aborted", () => { cleanup(); writeStream.destroy(); settle(() => reject(new ServiceError("NETWORK", "connection was aborted mid-download", { serviceId: SERVICE_ID, retryable: true }))); });
        writeStream.on("error", (error) => { cleanup(); response.destroy(); settle(() => reject(mapStreamError(error))); });
        // Node's 'aborted' event on IncomingMessage is deprecated in favor of 'close'; a server
        // that destroys its socket mid-response does not reliably emit 'error' either. Treat any
        // 'close' that arrives before a clean 'end' as a dropped connection (retryable) — this is
        // the primary signal the mid-stream-disconnect tests below rely on.
        response.on("close", () => {
          if (endedNormally) return;
          cleanup();
          writeStream.destroy();
          settle(() => reject(new ServiceError("NETWORK", "connection closed before the download finished", { serviceId: SERVICE_ID, retryable: true })));
        });

        response.on("end", () => {
          endedNormally = true;
          cleanup();
          writeStream.end(() => {
            (async () => {
              try {
                const handle = await fsp.open(partialPath, "r+");
                try { await handle.sync(); } catch { /* fsync is best-effort */ } finally { await handle.close(); }
              } catch { /* the installer will still hash/validate the file next */ }
              const finalEvent: DownloadProgressEvent = { jobId: job.id, state: "downloading", bytesDownloaded, totalBytes: job.expectedSizeBytes, bytesPerSecond: 0, percent: job.expectedSizeBytes ? Math.min(100, (bytesDownloaded / job.expectedSizeBytes) * 100) : undefined, at: this.#iso() };
              emitThrottled(finalEvent, true);
              await this.#persist({ ...job, bytesDownloaded, state: "downloading", updatedAt: this.#iso() });
              if (bytesDownloaded !== job.expectedSizeBytes) {
                settle(() => reject(new ServiceError("NETWORK", `stream ended at ${bytesDownloaded} bytes, expected ${job.expectedSizeBytes}`, { serviceId: SERVICE_ID, retryable: true })));
                return;
              }
              settle(() => resolve());
            })().catch((error) => settle(() => reject(mapStreamError(error))));
          });
        });
      };

      openAndStream().catch((error) => settle(() => reject(mapStreamError(error))));
    });
  }

  #singleRequest(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      // Node's http/https client only ever invokes a custom `lookup` option for *hostnames* it
      // actually has to resolve — a URL whose host is already a literal IP address (the most
      // common real SSRF payload: `http://127.0.0.1/...`, `http://169.254.169.254/...`) connects
      // directly, silently bypassing createGuardedLookup below entirely. So literal IPs must be
      // classified and rejected *here*, before a socket is ever opened, and the DNS-hook only
      // needs to cover the remaining case: a hostname that resolves to a private/loopback address.
      const literalHost = url.hostname.replace(/^\[|\]$/g, "");
      const literalFamily = net.isIP(literalHost);
      if (literalFamily !== 0 && !this.#isAddressAllowed(literalHost, literalFamily as 4 | 6)) {
        reject(new ServiceError("BAD_REQUEST", `refusing to connect to a disallowed address (${literalHost})`, { serviceId: SERVICE_ID, retryable: false }));
        return;
      }
      const transport = (url.protocol === "https:" ? this.#httpsRequest : this.#httpRequest) as unknown as RequestFn;
      const lookup = createGuardedLookup(this.#isAddressAllowed, this.#dnsLookup ?? (dns.lookup as unknown as DnsLookupOne));
      const request = transport(url, { method: "GET", headers, lookup, timeout: this.#connectTimeoutMs, signal }, (response) => resolve(response));
      request.on("timeout", () => request.destroy(Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" })));
      request.on("error", (error) => reject(mapStreamError(error)));
      request.end();
    });
  }

  async #authorizationHeader(url: URL): Promise<string | undefined> {
    if (!this.#gatedHosts.has(url.hostname)) return undefined;
    try {
      const token = await this.secretStore.getForService(parseSecretKey(HUGGING_FACE_TOKEN_SECRET_KEY));
      return token ? `Bearer ${token}` : undefined;
    } catch {
      return undefined;
    }
  }

  #partialRelativePath(job: Pick<DownloadJobRecord, "id">): string {
    return path.posix.join(MODEL_DIR_NAMES.staging, `${sanitizeIdSegment(job.id)}.partial`);
  }

  #partialAbsolutePath(job: Pick<DownloadJobRecord, "id">): string {
    return path.join(modelsSubdir(this.modelsDir, MODEL_DIR_NAMES.staging), `${sanitizeIdSegment(job.id)}.partial`);
  }

  async #persist(job: DownloadJobRecord): Promise<DownloadJobRecord> {
    await this.jobStore.upsert(job);
    return job;
  }

  #emitProgress(job: DownloadJobRecord): void {
    this.emitProgressEvent({
      jobId: job.id,
      state: job.state,
      bytesDownloaded: job.bytesDownloaded,
      totalBytes: job.expectedSizeBytes,
      bytesPerSecond: 0,
      percent: job.expectedSizeBytes ? Math.min(100, (job.bytesDownloaded / job.expectedSizeBytes) * 100) : undefined,
      at: this.#iso(),
    });
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
}
