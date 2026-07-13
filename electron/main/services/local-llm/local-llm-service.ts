// Public entry point for the Local LLM inference service (#45) — implements the exact
// `LocalLlmService` contract (electron/shared/local-llm/contract.ts). This is the single place
// that owns the state machine (local-llm-state.ts), the native module handle (native-loader.ts),
// the resident model runtime (model-runtime.ts), and the generation queue (generation-queue.ts) —
// "model/context/sessionの所有権をLocalLlmServiceへ集約する".
//
// Cancellation design note: `cancel(requestId)` does NOT rely on owning/aborting the
// caller-supplied `RequestContext.signal` (the public interface lets callers construct their own
// context, so this service cannot assume it owns that AbortController). Instead: a *pending*
// request is cancelled by removing it from generation-queue.ts's FIFO array; the *active* request
// is cancelled by calling model-runtime.ts's own `cancelActiveGeneration()`, which aborts an
// AbortController model-runtime creates internally for every generate() call (itself chained to
// forward an abort from the caller-supplied `context.signal`, so external cancellation via the
// caller's own controller still works too — see model-runtime.ts's generate()).
import fs from "node:fs/promises";
import type { RequestContext } from "../../../shared/services/service-contract";
import type { GenerateInput, LoadModelInput, LoadPhase, LoadedModelSummary, LocalLlmCapabilities, LocalLlmState, LocalLlmService as LocalLlmServiceInterface } from "../../../shared/local-llm/contract";
import type { GenerationEvent, LoadProgressEvent } from "../../../shared/local-llm/events";
import { validateGenerateInput, validateLoadModelInput } from "../../../shared/local-llm/schemas";
import { readGgufHeader } from "./models/gguf-metadata-reader";
import { NativeLoader } from "./native-loader";
import type { LlamaLike, LlamaModuleApi, NativeLoaderDeps } from "./native-loader";
import { ModelRuntime } from "./model-runtime";
import { GenerationQueue } from "./generation-queue";
import { adaptMessages } from "./message-adapter";
import { LocalLlmError, isCancellation, logLocalLlmError, normalizeLocalLlmError } from "./local-llm-errors";
import { assertLocalLlmTransition } from "./local-llm-state";
import type { LocalLlmStatus } from "../../../shared/local-llm/contract";

export type InstalledModelLookup = { id: string; displayName: string; architecture?: string; sizeBytes: number };

/** The narrow slice of #75/#76's ModelRepository this service actually needs — kept as a
 * structural interface so tests can inject a fake registry instead of a real ModelRepository. */
export type LocalLlmModelRepository = {
  resolveInstalledModelPath(modelId: string): Promise<string>;
  getInstalled(modelId: string): Promise<InstalledModelLookup | null>;
};

export type LocalLlmServiceDeps = {
  modelRepository: LocalLlmModelRepository;
  nativeLoader?: NativeLoader;
  nativeLoaderDeps?: NativeLoaderDeps;
  now?: () => number;
  maxPending?: number;
  createModelRuntime?: (llama: LlamaLike, module: LlamaModuleApi) => ModelRuntime;
  /** "各phaseをprogress eventで通知" — load()'s public signature is a single Promise (fixed by the
   * issue's contract), so phase-by-phase progress is delivered out-of-band through this
   * constructor-injected emitter instead, mirroring ModelRepositoryOptions.emitDownloadProgress's
   * identical role for #76's download service. */
  emitLoadProgress?: (event: LoadProgressEvent) => void;
};

const SERVICE_ID = "local-llm";

function errorEvent(requestId: string, error: LocalLlmError, at: number): GenerationEvent {
  return { type: "error", requestId, error: error.toJSON(), at };
}

/** Bridges model-runtime.ts's callback-based token streaming (`onTextChunk`) into the
 * AsyncIterable<GenerationEvent> generate() must return, without buffering the whole response
 * before the caller sees anything. A minimal push queue: `push()` feeds a token either straight to
 * a waiting consumer or onto an internal buffer; `finish()` ends the stream. */
class AsyncEventChannel<T> {
  #buffer: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | null = null;
  #done = false;

  push(value: T): void {
    if (this.#done) return;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value, done: false });
    } else {
      this.#buffer.push(value);
    }
  }

  finish(): void {
    if (this.#done) return;
    this.#done = true;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.#buffer.length > 0) {
        yield this.#buffer.shift() as T;
        continue;
      }
      if (this.#done) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.#waiting = resolve;
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

export class LocalLlmService implements LocalLlmServiceInterface {
  #state: LocalLlmState = { status: "idle" };
  #capabilities: LocalLlmCapabilities;
  readonly #nativeLoader: NativeLoader;
  readonly #modelRepository: LocalLlmModelRepository;
  readonly #now: () => number;
  readonly #queue: GenerationQueue;
  readonly #createModelRuntime: (llama: LlamaLike, module: LlamaModuleApi) => ModelRuntime;
  readonly #emitLoadProgress: (event: LoadProgressEvent) => void;
  #modelRuntime: ModelRuntime | null = null;
  #llamaHandle: { llama: LlamaLike; module: LlamaModuleApi } | null = null;
  #generation = 0;
  #requestSequence = 0;
  #disposed = false;
  #initPromise: Promise<LocalLlmCapabilities> | undefined;

  constructor(deps: LocalLlmServiceDeps) {
    this.#modelRepository = deps.modelRepository;
    this.#nativeLoader = deps.nativeLoader ?? new NativeLoader(deps.nativeLoaderDeps);
    this.#now = deps.now ?? (() => Date.now());
    this.#queue = new GenerationQueue({ maxPending: deps.maxPending });
    this.#createModelRuntime = deps.createModelRuntime ?? ((llama, module) => new ModelRuntime(llama, module, { clock: { now: this.#now } }));
    this.#emitLoadProgress = deps.emitLoadProgress ?? (() => {});
    this.#capabilities = { available: false, reason: "not initialized", platform: process.platform, arch: process.arch };
  }

  // -----------------------------------------------------------------------------------------
  // Capability probe
  // -----------------------------------------------------------------------------------------

  /** "initializeを多重実行しても同じPromiseを返す" (native-loader.ts's own memoization already
   * guarantees this at the module-load level; mirrored here too so a second initialize() call
   * never re-derives capabilities from a second, redundant native-loader round trip). */
  async initialize(): Promise<LocalLlmCapabilities> {
    if (this.#initPromise) return this.#initPromise;
    this.#initPromise = this.#initializeOnce();
    return this.#initPromise;
  }

  async #initializeOnce(): Promise<LocalLlmCapabilities> {
    const result = await this.#nativeLoader.load();
    if (this.#disposed) {
      // dispose() raced ahead of this initialize() call while the native probe was in flight and
      // already committed its own terminal state/capabilities — never resurrect `available: true`
      // (or any handle) over that. dispose() itself already called nativeLoader.dispose(), so there
      // is nothing further to release here even if the probe above just reported success.
      this.#capabilities = { available: false, reason: "the local LLM service has been disposed", platform: result.diagnostics.platform, arch: result.diagnostics.arch };
      return this.#capabilities;
    }
    if (!result.available) {
      this.#capabilities = { available: false, reason: result.reason, platform: result.diagnostics.platform, arch: result.diagnostics.arch };
      // The very first capability determination is a *branch selection*, not a transition between
      // two already-meaningful states — the constructor's provisional `{status:"idle"}` was never
      // itself a real "the native module is available" claim. This is the one place in this
      // service that assigns `#state` without going through assertLocalLlmTransition(); every
      // other state change in this file goes through #setState() below.
      if (this.#state.status === "idle") this.#state = { status: "unavailable", reason: result.reason };
      return this.#capabilities;
    }
    this.#llamaHandle = { llama: result.llama, module: result.module };
    this.#capabilities = {
      available: true,
      backend: result.diagnostics.backend ?? undefined,
      packageVersion: result.diagnostics.packageVersion ?? undefined,
      platform: result.diagnostics.platform,
      arch: result.diagnostics.arch,
      supportsGpuOffload: result.llama.gpu !== false,
    };
    // state stays "idle" (its provisional constructor value already matches "available, nothing
    // loaded yet") — no transition needed.
    return this.#capabilities;
  }

  getState(): LocalLlmState {
    return this.#state;
  }

  getCapabilities(): LocalLlmCapabilities {
    return this.#capabilities;
  }

  get generation(): number {
    return this.#generation;
  }

  /** Convenience for callers (tests, and any future caller) that don't need their own externally
   * abortable controller — see this file's header comment for why cancel(requestId) doesn't depend
   * on this signal being the "real" one. A caller that DOES want external abort support should
   * construct its own RequestContext with its own AbortController instead; it will still be
   * honored (forwarded into model-runtime.ts's generate()). */
  createRequestContext(ownerId = "app", requestId?: string): RequestContext {
    return {
      requestId: requestId ?? `${SERVICE_ID}-${this.#now()}-${++this.#requestSequence}`,
      serviceId: SERVICE_ID,
      generation: this.#generation,
      ownerId,
      signal: new AbortController().signal,
      startedAt: this.#now(),
    };
  }

  // -----------------------------------------------------------------------------------------
  // Load / switch / unload
  // -----------------------------------------------------------------------------------------

  async load(input: LoadModelInput, context: RequestContext): Promise<LoadedModelSummary> {
    this.#assertNotDisposed();
    const validated = validateLoadModelInput(input);
    if (!validated.ok) throw new LocalLlmError("INVALID_REQUEST", validated.failure.reason, { retryable: false });
    if (this.#state.status === "unavailable" || !this.#capabilities.available || !this.#llamaHandle) {
      throw new LocalLlmError("NATIVE_UNAVAILABLE", this.#capabilities.reason ?? "the local model backend is not available", { retryable: false });
    }
    if (this.#state.status === "loading" || this.#state.status === "unloading") {
      throw new LocalLlmError("BUSY", `the local model service is currently ${this.#state.status}`, { retryable: true });
    }
    if (this.#state.status === "generating" && !input.force) {
      throw new LocalLlmError("BUSY", "a generation is already in progress; retry with force=true to switch models anyway", { retryable: true });
    }

    // "モデル切替の状態遷移はready → unloading → idle → loadingを正とする" — walk through the
    // intermediate states rather than jumping straight from ready/generating to loading, even
    // though the transition table would technically permit ready -> loading directly.
    if (this.#state.status === "ready" || this.#state.status === "generating") {
      await this.#unloadCurrent(this.#currentModelId() ?? input.modelId);
      this.#assertNotDisposed(); // dispose() may have raced in while #unloadCurrent was in flight
    }

    const requestId = context.requestId;
    this.#setState({ status: "loading", modelId: input.modelId, requestId, phase: "resolving" });
    const onPhase = (phase: LoadPhase) => {
      if (this.#state.status === "loading" && this.#state.requestId === requestId) this.#state = { ...this.#state, phase };
      this.#emitLoadProgress({ requestId, modelId: input.modelId, phase, at: this.#now() });
    };

    // Captured locally (not read back from `this.#modelRuntime`) so cleanup below is correct even
    // if a concurrent dispose() call already reassigned/nulled the instance field out from under
    // this call — see this method's catch block and the "disposed mid-load" branch below.
    let runtime: ModelRuntime | null = null;
    try {
      onPhase("resolving");
      const installed = await this.#modelRepository.getInstalled(input.modelId);
      if (!installed) throw new LocalLlmError("MODEL_NOT_INSTALLED", `model "${input.modelId}" is not installed`, { retryable: false });

      onPhase("validating_path");
      let modelPath: string;
      try {
        modelPath = await this.#modelRepository.resolveInstalledModelPath(input.modelId);
      } catch (error) {
        throw new LocalLlmError("MODEL_NOT_FOUND", "the installed model's file could not be resolved", { cause: error, retryable: false });
      }

      onPhase("verifying_file");
      // TODO(#47): #47 (not yet implemented) is expected to add full install-status/trust
      // verification here. Until then this only performs a cheap existence check plus the
      // existing GGUF header/magic-bytes validation from #75/#76's gguf-metadata-reader.ts — never
      // a full re-hash of a possibly-multi-gigabyte file on every load.
      const stat = await fs.stat(modelPath).catch(() => null);
      if (!stat || !stat.isFile()) throw new LocalLlmError("MODEL_NOT_FOUND", "the installed model's file is missing on disk", { retryable: false });
      const header = await readGgufHeader(modelPath);
      if (!header.valid) throw new LocalLlmError("INVALID_GGUF", `the model file failed GGUF validation: ${header.reason}`, { retryable: false });

      onPhase("initializing_backend");
      if (!this.#llamaHandle) throw new LocalLlmError("NATIVE_UNAVAILABLE", "the local model backend is not available", { retryable: false });
      runtime = this.#createModelRuntime(this.#llamaHandle.llama, this.#llamaHandle.module);
      this.#modelRuntime = runtime;

      const summary = await runtime.load({
        modelId: input.modelId,
        displayName: installed.displayName,
        modelPath,
        architecture: installed.architecture,
        sizeBytes: stat.size,
        contextSize: input.contextSize,
        onPhase,
        signal: context.signal,
      });

      if (this.#disposed) {
        // dispose() raced ahead while the native load itself was running. It could only dispose
        // whatever `this.#modelRuntime` pointed to *at that time* — this call's own `runtime`
        // local is the only thing that knows the native load JUST succeeded, so cleanup here is
        // this call's responsibility, not dispose()'s.
        await runtime.unload().catch(() => {});
        throw new LocalLlmError("NATIVE_UNAVAILABLE", "the local LLM service was disposed while loading", { retryable: false });
      }

      this.#setState({ status: "ready", model: summary });
      this.#generation += 1;
      this.#queue.cancelStaleGeneration(this.#generation);
      return summary;
    } catch (error) {
      const normalized = normalizeLocalLlmError(error, "BACKEND_INIT_FAILED");
      logLocalLlmError(normalized, { modelId: input.modelId, requestId, phase: "load" });
      if (runtime) {
        await runtime.unload().catch(() => {});
        if (this.#modelRuntime === runtime) this.#modelRuntime = null;
      }
      // dispose() (if it raced in) already committed its own terminal state — attempting another
      // transition on top of that would throw InvalidLocalLlmTransitionError and mask `normalized`
      // with a completely unrelated, uncaught error instead of the real failure reason.
      if (!this.#disposed) this.#setState({ status: "error", error: normalized.toJSON(), recoverable: true });
      throw normalized;
    }
  }

  async unload(input: { force?: boolean }, context: RequestContext): Promise<void> {
    void context;
    this.#assertNotDisposed();
    if (this.#state.status === "unavailable" || this.#state.status === "idle") return;
    if (this.#state.status === "loading") throw new LocalLlmError("BUSY", "cannot unload while a model load is in progress", { retryable: true });
    if (this.#state.status === "unloading") return; // already in progress; treat as idempotent
    if (this.#state.status === "generating" && !input.force) throw new LocalLlmError("BUSY", "a generation is already in progress; retry with force=true", { retryable: true });
    if (this.#state.status === "error" && !this.#modelRuntime) {
      if (!this.#disposed) this.#setState({ status: "idle" });
      return;
    }

    const modelId = this.#currentModelId() ?? "unknown";
    await this.#unloadCurrent(modelId);
  }

  /** Shared by load() (model switch) and unload(): walks ready|generating|error -> unloading ->
   * idle, running model-runtime.ts's own dispose sequence and bumping the config generation
   * ("config generation変更時active/pending全cancel"). Throws DISPOSE_FAILED (after still
   * transitioning to "error", never leaving state stuck in "unloading") if any underlying
   * dispose step failed. */
  async #unloadCurrent(modelId: string): Promise<void> {
    this.#setState({ status: "unloading", modelId });
    this.#queue.cancelAllPending("the model is being unloaded");
    const runtime = this.#modelRuntime;
    this.#modelRuntime = null;
    const errors = runtime ? (await runtime.unload()).errors : [];
    this.#generation += 1;
    for (const error of errors) logLocalLlmError(error, { modelId, phase: "unload" });
    if (this.#disposed) {
      // dispose() already committed its own terminal state (and, since this call already disposed
      // `runtime` above using its own local reference, dispose()'s concurrent cleanup pass had
      // nothing left to do either — no double-free, no leak). Attempting a transition on top of
      // that would throw InvalidLocalLlmTransitionError uncaught out of this method; the caller
      // (load()'s switch-model path, or unload() itself) is expected to notice via its own
      // `#assertNotDisposed()`/disposed check right after awaiting this.
      return;
    }
    if (errors.length > 0) {
      this.#setState({ status: "error", error: errors[0].toJSON(), recoverable: true });
      throw errors[0];
    }
    this.#setState({ status: "idle" });
  }

  #currentModelId(): string | null {
    if (this.#state.status === "ready" || this.#state.status === "generating") return this.#state.model.modelId;
    return null;
  }

  #currentModelSummary(): LoadedModelSummary | null {
    if (this.#state.status === "ready" || this.#state.status === "generating") return this.#state.model;
    return null;
  }

  // -----------------------------------------------------------------------------------------
  // Generate
  // -----------------------------------------------------------------------------------------

  async *generate(input: GenerateInput, context: RequestContext): AsyncIterable<GenerationEvent> {
    this.#assertNotDisposed();
    const modelSummaryAtEntry = this.#currentModelSummary();
    const validated = validateGenerateInput(input, { maxContextTokens: modelSummaryAtEntry?.contextSize });
    if (!validated.ok) {
      // Mirrors adaptMessages()'s own UNSUPPORTED_CAPABILITY-vs-INVALID_REQUEST split below — an
      // image-content rejection must report the same code whether it's caught here (pre-flight) or
      // later in adaptMessages() (see ValidationFailure.capability's doc comment in schemas.ts).
      const code = validated.failure.capability ? "UNSUPPORTED_CAPABILITY" : "INVALID_REQUEST";
      yield errorEvent(context.requestId, new LocalLlmError(code, validated.failure.reason, { retryable: false }), this.#now());
      return;
    }
    if (!modelSummaryAtEntry || modelSummaryAtEntry.modelId !== input.modelId) {
      yield errorEvent(context.requestId, new LocalLlmError("MODEL_NOT_READY", `model "${input.modelId}" is not the currently loaded model`, { retryable: false }), this.#now());
      return;
    }
    if (context.generation !== this.#generation) {
      yield errorEvent(context.requestId, new LocalLlmError("CANCELLED", "request generation is stale", { retryable: false }), this.#now());
      return;
    }

    let ticket;
    try {
      ticket = this.#queue.enqueue({ requestId: context.requestId, generation: context.generation });
    } catch (error) {
      yield errorEvent(context.requestId, normalizeLocalLlmError(error, "QUEUE_FULL"), this.#now());
      return;
    }

    try {
      await ticket.waitForTurn();
    } catch (error) {
      yield { type: "cancelled", requestId: context.requestId, at: this.#now() };
      return;
    }

    if (context.signal.aborted || this.#state.status === "unloading" || this.#state.status === "error" || this.#state.status === "unavailable") {
      this.#queue.settleActive(context.requestId);
      yield { type: "cancelled", requestId: context.requestId, at: this.#now() };
      return;
    }

    const modelSummary = this.#currentModelSummary();
    if (!modelSummary || !this.#modelRuntime || modelSummary.modelId !== input.modelId) {
      this.#queue.settleActive(context.requestId);
      yield errorEvent(context.requestId, new LocalLlmError("MODEL_NOT_READY", "the model was switched before this request's turn", { retryable: true }), this.#now());
      return;
    }

    const adapted = adaptMessages(input.messages);
    if (!adapted.ok) {
      this.#queue.settleActive(context.requestId);
      const code = adapted.capability ? "UNSUPPORTED_CAPABILITY" : "INVALID_REQUEST";
      yield errorEvent(context.requestId, new LocalLlmError(code, adapted.reason, { retryable: false }), this.#now());
      return;
    }

    this.#setState({ status: "generating", model: modelSummary, requestId: context.requestId, startedAt: this.#now() });

    const channel = new AsyncEventChannel<GenerationEvent>();
    let settled = false;
    const runtime = this.#modelRuntime;
    const runPromise = runtime
      .generate({
        requestId: context.requestId,
        history: adapted.value.history,
        prompt: adapted.value.prompt,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        signal: context.signal,
        onTextChunk: (text) => channel.push({ type: "token", requestId: context.requestId, text, at: this.#now() }),
      })
      .then((result) => {
        settled = true;
        channel.push({ type: "done", requestId: context.requestId, text: result.text, metrics: result.metrics, at: this.#now() });
        channel.finish();
      })
      .catch((error) => {
        settled = true;
        const normalized = normalizeLocalLlmError(error, "GENERATION_FAILED");
        if (isCancellation(normalized)) {
          channel.push({ type: "cancelled", requestId: context.requestId, at: this.#now() });
        } else {
          logLocalLlmError(normalized, { requestId: context.requestId, modelId: input.modelId, phase: "generate" });
          channel.push(errorEvent(context.requestId, normalized, this.#now()));
        }
        channel.finish();
      });

    try {
      for await (const event of channel) {
        yield event;
      }
    } finally {
      if (!settled) runtime.cancelActiveGeneration();
      await runPromise.catch(() => {});
      this.#queue.settleActive(context.requestId);
      if (this.#state.status === "generating" && this.#state.requestId === context.requestId) {
        this.#setState({ status: "ready", model: modelSummary });
      }
    }
  }

  // -----------------------------------------------------------------------------------------
  // Cancel / dispose
  // -----------------------------------------------------------------------------------------

  cancel(requestId: string): boolean {
    const removedFromQueue = this.#queue.cancel(requestId);
    if (removedFromQueue) return true;
    if (this.#queue.activeRequestId === requestId && this.#modelRuntime) {
      return this.#modelRuntime.cancelActiveGeneration();
    }
    return false;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queue.cancelAllPending("the local LLM service is disposing");
    if (this.#modelRuntime) {
      const { errors } = await this.#modelRuntime.unload();
      for (const error of errors) logLocalLlmError(error, { phase: "dispose" });
      this.#modelRuntime = null;
    }
    this.#nativeLoader.dispose();
    this.#llamaHandle = null;
    // Not routed through #setState()/assertLocalLlmTransition(): dispose() is a terminal,
    // outside-the-state-machine operation (matches eventsub-session.ts's own idempotent close()
    // precedent) rather than a state a live service could ever be asked to transition back out of.
    this.#state = { status: "unavailable", reason: "the local LLM service has been disposed" };
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new LocalLlmError("NATIVE_UNAVAILABLE", "the local LLM service has been disposed", { retryable: false });
  }

  #setState(next: LocalLlmState): void {
    assertLocalLlmTransition(this.#state.status as LocalLlmStatus, next.status);
    this.#state = next;
  }
}
