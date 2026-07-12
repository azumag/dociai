// Orchestrates Twitch's public-client Device Code Grant flow end to end: request a device code,
// show the user a code + verification URL (optionally opening it via #41's OS-browser-open
// action), poll the token endpoint no faster than the server-specified interval, and hand the
// resulting token off to whatever consumes `onTokenObtained` (issue #84's SecretStore
// persistence/validate/refresh) — this file never itself persists a token.
//
// State machine: signed_out -> starting -> awaiting_user -> exchanging -> {ready, error}
//                                              ^_____________|      (authorization_pending/slow_down loop back to awaiting_user)
// See twitch-auth-state.ts for the transition guard and the Renderer-safe DTO projection, and
// auth-request-registry.ts for why a second start() while one is in flight is rejected outright.
import { ServiceError, normalizeServiceError } from "../../service-error";
import { retryWithPolicy } from "../../retry-policy";
import type { RetryPolicy } from "../../retry-policy";
import { AuthRequestRegistry } from "./auth-request-registry";
import type { DeviceTokenSuccess, TwitchOAuthClient } from "./twitch-oauth-client";
import { assertAuthStateTransition, computeScopeFingerprint, initialAuthState, normalizeScopes, toPublicAuthState } from "./twitch-auth-state";
import type { TwitchAuthInternalState } from "./twitch-auth-state";
import type { RequestHandle } from "../../../../shared/services/service-contract";
import type { TwitchAuthErrorCode, TwitchAuthErrorShape, TwitchAuthPublicState, TwitchAuthStartInput } from "../../../../shared/twitch/auth-contract";

const SERVICE_ID = "twitch:auth";
/** RFC 8628 §3.5's suggested backoff when the server returns `slow_down`: add 5s to the interval
 * every time it happens (rather than e.g. doubling), since these responses are meant to be rare
 * corrections, not a sign the client should back off aggressively. */
const SLOW_DOWN_INCREMENT_MS = 5_000;
const DEFAULT_MAX_TRANSIENT_FAILURES = 5;
const MIN_INTERVAL_SECONDS = 1;
/** #68's retry-policy.ts, reused for the one-shot device-code request (a transient network blip
 * fetching the device_code shouldn't fail the whole auth attempt outright). The poll loop itself
 * intentionally does NOT use this — its retry cadence is dictated by the server's `interval`/
 * `slow_down` protocol, not exponential backoff, so it drives #pollUntilSettled's own loop
 * instead (see below). */
const DEVICE_CODE_REQUEST_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4_000, jitterRatio: 0.2 };

/** Internal control-flow error for the poll loop's own terminal classifications
 * (access_denied/expired_token/exhausted-transient-retries) — kept separate from ServiceError so
 * device-code-flow.ts, not service-error.ts's generic HTTP-status taxonomy, owns exactly which
 * TwitchAuthErrorCode each poll outcome maps to. Never leaves this file. */
class TwitchAuthFlowError extends Error {
  constructor(readonly code: TwitchAuthErrorCode, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "TwitchAuthFlowError";
  }
}

/** Raw token handoff for issue #84 — Main-process-internal only, never serialized to
 * TwitchAuthPublicState/TwitchAuthProgressEvent and never routed over IPC. */
export type TwitchAuthTokenHandoff = {
  requestId: string;
  generation: number;
  accessToken: string;
  refreshToken: string;
  scope: string[];
  tokenType: string;
  obtainedAt: string;
};

export type DeviceCodeFlowDeps = {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  maxTransientFailures?: number;
  /** Should be `(url) => openAllowedExternalUrl(url).then(() => ({ opened: true }))` in
   * production (electron/main/security/navigation.ts, issue #41) — kept injectable so this file
   * never itself imports "electron" (which would break the plain-Node unit-test bundle) and so
   * tests can assert exactly when/with-what-URL it gets called. Leaving it unset is safe: the
   * flow simply skips opening a browser window and still exposes verificationUri for a UI to
   * render/link manually. */
  openVerificationUri?: (url: string) => Promise<{ opened: boolean }>;
  /** Main-process-internal handoff for the raw token (see TwitchAuthTokenHandoff). */
  onTokenObtained?: (token: TwitchAuthTokenHandoff) => void;
  emitProgress?: (event: { requestId: string | null; generation: number; publicState: TwitchAuthPublicState }) => void;
};

export class DeviceCodeFlow {
  readonly #registry = new AuthRequestRegistry();
  #state: TwitchAuthInternalState;
  #activeRequestId: string | null = null;
  #pending: Promise<void> | undefined;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #maxTransientFailures: number;
  readonly #openVerificationUriDep?: (url: string) => Promise<{ opened: boolean }>;
  readonly #onTokenObtained: (token: TwitchAuthTokenHandoff) => void;
  readonly #emitProgress: (event: { requestId: string | null; generation: number; publicState: TwitchAuthPublicState }) => void;

  constructor(private readonly oauthClient: TwitchOAuthClient, private readonly clientId: string, deps: DeviceCodeFlowDeps = {}) {
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#maxTransientFailures = deps.maxTransientFailures ?? DEFAULT_MAX_TRANSIENT_FAILURES;
    this.#openVerificationUriDep = deps.openVerificationUri;
    this.#onTokenObtained = deps.onTokenObtained ?? (() => {});
    this.#emitProgress = deps.emitProgress ?? (() => {});
    this.#state = initialAuthState(this.#iso());
  }

  get publicState(): TwitchAuthPublicState {
    return toPublicAuthState(this.#state);
  }

  /** Number of requests tracked by the underlying registry — 0 once every in-flight poll/timer
   * has been cleaned up (terminal state, cancel, reload, or dispose). */
  get registrySize(): number {
    return this.#registry.size;
  }

  get generation(): number {
    return this.#registry.generation;
  }

  /** Starts a new Device Code Grant attempt. Rejects outright (ServiceError "CONFLICT") if one is
   * already in flight — see auth-request-registry.ts for why this is a reject, not a coalesce. */
  async start(input: TwitchAuthStartInput): Promise<TwitchAuthPublicState> {
    const scopes = normalizeScopes(input?.scopes ?? []);
    if (scopes.length === 0) throw new ServiceError("BAD_REQUEST", "at least one scope is required", { serviceId: SERVICE_ID, retryable: false });

    const handle = this.#registry.begin("twitch-auth");
    const requestId = handle.context.requestId;
    const generation = handle.context.generation;
    this.#activeRequestId = requestId;
    this.#transition({ ...initialAuthState(this.#iso(), generation), state: "starting", requestId, scopes, scopeFingerprint: computeScopeFingerprint(scopes) });

    const promise = this.#run(handle, scopes).catch((error) => {
      // #run converts every internal failure into a persisted terminal (or signed_out) state —
      // this .catch is only a last-resort safety net, same role as model-download-service.ts's
      // #run(): an unexpected throw here must never become an unhandled rejection.
      console.error(`[dociai:twitch-auth] unexpected failure for request ${requestId}`, error);
    });
    this.#pending = promise;
    void promise.finally(() => {
      if (this.#pending === promise) this.#pending = undefined;
    });
    return this.publicState;
  }

  /** Test/internal seam: resolves once the current auth attempt (if any) reaches a terminal or
   * signed_out state. Not part of any future IPC surface. */
  async waitForSettled(): Promise<TwitchAuthPublicState> {
    await this.#pending;
    return this.publicState;
  }

  cancel(reason: Parameters<RequestHandle["cancel"]>[0] = "cancelled"): boolean {
    const cancelled = this.#registry.cancelCurrent(reason);
    if (cancelled) {
      this.#activeRequestId = null;
      this.#transition({ ...initialAuthState(this.#iso()), generation: this.#registry.generation });
    }
    return cancelled;
  }

  /** Aborts any in-flight request/poll and bumps the generation (mirroring ServiceRuntime.reload)
   * so a late in-flight write from the superseded attempt is recognizable as stale. */
  reload(): void {
    this.#registry.reload();
    this.#activeRequestId = null;
    this.#transition({ ...initialAuthState(this.#iso()), generation: this.#registry.generation });
  }

  dispose(): void {
    this.#registry.dispose();
    this.#activeRequestId = null;
    this.#state = initialAuthState(this.#iso(), this.#registry.generation);
  }

  /** Re-issues the OS-browser-open action for the current awaiting_user verification_uri (e.g.
   * the user closed the tab). No-op when no opener was injected, or once the attempt that
   * verificationUri belonged to has already reached a terminal state (ready/error/signed_out) —
   * `this.#state` carries the last-known verificationUri through those terminal states purely for
   * display, and re-opening it there would open an already-consumed or expired URL. */
  async openVerificationUri(): Promise<{ opened: boolean }> {
    if (this.#state.state !== "awaiting_user" && this.#state.state !== "exchanging") return { opened: false };
    return this.#openVerification(this.#state.verificationUri);
  }

  async #openVerification(url: string | null): Promise<{ opened: boolean }> {
    if (!this.#openVerificationUriDep || !url) return { opened: false };
    try {
      return await this.#openVerificationUriDep(url);
    } catch {
      return { opened: false };
    }
  }

  async #run(handle: RequestHandle, scopes: string[]): Promise<void> {
    const { signal, requestId, generation } = handle.context;
    try {
      const deviceCode = await retryWithPolicy(
        () => this.oauthClient.requestDeviceCode({ clientId: this.clientId, scopes }, signal),
        DEVICE_CODE_REQUEST_RETRY_POLICY,
        handle.context,
        { sleep: this.#sleep },
      );
      if (signal.aborted) throw new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false });

      const expiresAt = new Date(this.#now() + deviceCode.expiresInSeconds * 1000).toISOString();
      this.#transitionFor(requestId, { ...this.#state, state: "awaiting_user", deviceCode: deviceCode.deviceCode, userCode: deviceCode.userCode, verificationUri: deviceCode.verificationUri, expiresAt, intervalSeconds: deviceCode.intervalSeconds, error: null });
      if (this.#activeRequestId === requestId) void this.#openVerification(deviceCode.verificationUri);

      const token = await this.#pollUntilSettled(handle, deviceCode.deviceCode, Math.max(MIN_INTERVAL_SECONDS, deviceCode.intervalSeconds) * 1000, expiresAt);
      handle.complete(token);
      this.#onTokenObtained({ requestId, generation, accessToken: token.accessToken, refreshToken: token.refreshToken, scope: token.scope, tokenType: token.tokenType, obtainedAt: this.#iso() });
      this.#transitionFor(requestId, { ...this.#state, state: "ready", deviceCode: null, error: null });
    } catch (error) {
      const normalized = normalizeServiceError(error, { serviceId: SERVICE_ID, signal });
      if (normalized.code === "CANCELLED") {
        // cancel()/reload()/dispose() already settled the registry handle and (for cancel/reload)
        // already wrote the signed_out reset synchronously; this branch only matters for the
        // "config reload raced ahead of this catch" ordering, and #transitionFor's guard makes it
        // a no-op whenever a newer start() has since taken over.
        this.#transitionFor(requestId, { ...initialAuthState(this.#iso()), generation: this.#registry.generation });
      } else {
        handle.fail(error instanceof Error ? error : new Error(String(error)));
        const shape: TwitchAuthErrorShape = error instanceof TwitchAuthFlowError
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : (({ code, message, retryable }) => ({ code, message, retryable }))(normalized.toJSON());
        this.#transitionFor(requestId, { ...this.#state, state: "error", deviceCode: null, error: shape });
      }
    } finally {
      this.#registry.end(requestId);
    }
  }

  async #pollUntilSettled(handle: RequestHandle, deviceCode: string, initialIntervalMs: number, expiresAtIso: string): Promise<DeviceTokenSuccess> {
    const { signal, requestId } = handle.context;
    const expiresAtMs = Date.parse(expiresAtIso);
    let intervalMs = initialIntervalMs;
    let transientFailures = 0;

    for (;;) {
      if (this.#now() >= expiresAtMs) throw new TwitchAuthFlowError("EXPIRED", "device code expired before authorization completed", false);

      await this.#sleep(intervalMs, signal);
      if (signal.aborted) throw new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false });

      this.#transitionFor(requestId, { ...this.#state, state: "exchanging" });
      // `deviceCode` is captured from #run's local variable, not read back from `this.#state`:
      // if this run has been superseded (a newer start() began mid-poll), `this.#state` may
      // already belong to that newer run — polling must keep using *this* run's own device_code
      // regardless, both for correctness and so a superseded run can never poll with someone
      // else's device_code.
      const result = await this.oauthClient.pollToken({ clientId: this.clientId, deviceCode }, signal);
      if (signal.aborted) throw new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false });

      if (result.ok) return result.token;

      switch (result.errorCode) {
        case "authorization_pending":
          this.#transitionFor(requestId, { ...this.#state, state: "awaiting_user" });
          continue;
        case "slow_down":
          intervalMs = Math.max(intervalMs + SLOW_DOWN_INCREMENT_MS, result.retryAfterMs ?? 0);
          this.#transitionFor(requestId, { ...this.#state, state: "awaiting_user" });
          continue;
        case "expired_token":
          throw new TwitchAuthFlowError("EXPIRED", "device code expired", false);
        case "access_denied":
          throw new TwitchAuthFlowError("ACCESS_DENIED", "authorization was denied", false);
        default: {
          // Transient (rate_limited / network / server / unknown): retried a bounded number of
          // times before the whole auth attempt is failed outright — an unbounded retry here
          // would mean a flaky network never lets the user see anything went wrong.
          transientFailures += 1;
          if (transientFailures > this.#maxTransientFailures) {
            const code: TwitchAuthErrorCode = result.errorCode === "rate_limited" ? "RATE_LIMIT" : result.errorCode === "network" ? "NETWORK" : "SERVER";
            throw new TwitchAuthFlowError(code, result.message, true);
          }
          if (result.retryAfterMs) intervalMs = Math.max(intervalMs, result.retryAfterMs);
          this.#transitionFor(requestId, { ...this.#state, state: "awaiting_user" });
          continue;
        }
      }
    }
  }

  /** Applies `next` only if `requestId` still owns the flow's writes — i.e. no newer start() has
   * begun since this run started. Prevents a superseded (already-cancelled-and-replaced) run's
   * late resumption from clobbering a subsequent attempt's state; see #run's CANCELLED branch. */
  #transitionFor(requestId: string, next: TwitchAuthInternalState): void {
    if (this.#activeRequestId !== requestId) return;
    this.#transition(next);
  }

  #transition(next: TwitchAuthInternalState): void {
    if (next.state !== this.#state.state) assertAuthStateTransition(this.#state.state, next.state);
    this.#state = { ...next, updatedAt: this.#iso() };
    this.#emitProgress({ requestId: this.#state.requestId, generation: this.#state.generation, publicState: this.publicState });
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false }));
    }, { once: true });
  });
}
