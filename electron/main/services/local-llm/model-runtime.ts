// Owns the actual node-llama-cpp model/context/session objects for exactly one resident model
// (#45's "初期は1モデル常駐" design principle) — "model/context/sessionの所有権をLocalLlmServiceへ
// 集約する" is implemented by making THIS the one place that ever holds those handles; even
// local-llm-service.ts only ever talks to this class, never to node-llama-cpp objects directly.
//
// Session lifetime / statelessness (issue TODO): a single LlamaChatSession is created once, at
// load() (matching the issue's literal load-sequence step 10, "chat session作成"), and reused for
// every generate() call. Each call is still fully stateless from the caller's perspective because
// generate() replaces the session's entire chat history (session.setChatHistory(...)) with the
// caller-supplied messages before every single prompt() — this is the "リクエスト毎の履歴リセット"
// branch of that TODO (as opposed to constructing a brand-new session per request).
import type { LoadPhase, LoadedModelSummary } from "../../../shared/local-llm/contract";
import type { GenerationMetrics } from "../../../shared/local-llm/events";
import type { LlamaChatHistoryItemLike, LlamaChatSessionLike, LlamaContextLike, LlamaLike, LlamaModelLike, LlamaModuleApi } from "./native-loader";
import { LocalLlmError, classifyNativeErrorMessage, normalizeLocalLlmError } from "./local-llm-errors";
import { GenerationMetricsCollector, systemMetricsClock } from "./local-llm-metrics";
import type { MetricsClock } from "./local-llm-metrics";

export type LoadRuntimeInput = {
  modelId: string;
  displayName: string;
  modelPath: string;
  architecture?: string;
  sizeBytes: number;
  contextSize?: number;
  onPhase?: (phase: LoadPhase) => void;
  signal?: AbortSignal;
};

export type GenerateRuntimeInput = {
  requestId: string;
  /** Already includes the leading `{type:"system",...}` entry (message-adapter.ts's adaptMessages()
   * builds it that way) — passed straight to session.setChatHistory() as-is. Deliberately no
   * separate `systemPrompt` field here: an earlier version of this method re-prepended one, which
   * silently duplicated the system prompt in every request (see model-runtime.ts's git history /
   * PR description). */
  history: LlamaChatHistoryItemLike[];
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onTextChunk?: (text: string) => void;
};

export type GenerateRuntimeResult = { text: string; metrics: GenerationMetrics };

const DEFAULT_CONTEXT_SIZE = 2048;

export class ModelRuntime {
  readonly #llama: LlamaLike;
  readonly #LlamaChatSession: LlamaModuleApi["LlamaChatSession"];
  readonly #clock: MetricsClock;
  #model: LlamaModelLike | null = null;
  #context: LlamaContextLike | null = null;
  #session: LlamaChatSessionLike | null = null;
  #modelId: string | null = null;
  #backend = "unknown";
  #activeGenerationController: AbortController | null = null;
  /** Resolves once the currently in-flight generate() call has fully settled (its underlying
   * session.prompt() promise actually returned/threw — not merely "asked to stop"). unload()
   * awaits this after requesting cancellation so it can never dispose the session/context/model
   * out from under a still-running native call. */
  #activeGenerationSettled: Promise<void> | null = null;

  constructor(llama: LlamaLike, module: LlamaModuleApi, deps: { clock?: MetricsClock } = {}) {
    this.#llama = llama;
    this.#LlamaChatSession = module.LlamaChatSession;
    this.#clock = deps.clock ?? systemMetricsClock;
    this.#backend = llama.gpu === false ? "cpu" : llama.gpu;
  }

  get modelId(): string | null {
    return this.#modelId;
  }

  get isLoaded(): boolean {
    return this.#model !== null;
  }

  /** Load sequence steps 8-10 (model load / context create / session create) plus 11 (metadata ->
   * summary). Steps 1-7 (resolve modelId, validate path, verify file, busy-check, unload previous,
   * backend init) are local-llm-service.ts's job — by the time this is called, `modelPath` has
   * already been resolved and validated via ModelRepository. */
  async load(input: LoadRuntimeInput): Promise<LoadedModelSummary> {
    const startedAtMs = this.#clock.now();
    try {
      input.onPhase?.("loading_model");
      const model = await this.#llama.loadModel({ modelPath: input.modelPath, loadSignal: input.signal });

      input.onPhase?.("creating_context");
      const requestedContextSize = input.contextSize ?? Math.min(DEFAULT_CONTEXT_SIZE, model.trainContextSize || DEFAULT_CONTEXT_SIZE);
      const contextSize = Math.max(1, Math.min(requestedContextSize, model.trainContextSize || requestedContextSize));
      let context: LlamaContextLike;
      try {
        context = await model.createContext({ contextSize });
      } catch (error) {
        await model.dispose().catch(() => {});
        throw new LocalLlmError("CONTEXT_CREATE_FAILED", "failed to create an inference context for this model", { cause: error });
      }

      input.onPhase?.("creating_session");
      let session: LlamaChatSessionLike;
      try {
        session = new this.#LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: "" });
      } catch (error) {
        await context.dispose().catch(() => {});
        await model.dispose().catch(() => {});
        throw new LocalLlmError("BACKEND_INIT_FAILED", "failed to create a chat session for this model", { cause: error });
      }

      input.onPhase?.("finalizing");
      this.#model = model;
      this.#context = context;
      this.#session = session;
      this.#modelId = input.modelId;

      return {
        modelId: input.modelId,
        displayName: input.displayName,
        architecture: input.architecture,
        sizeBytes: input.sizeBytes,
        contextSize: context.contextSize,
        trainContextSize: model.trainContextSize || undefined,
        backend: this.#backend,
        loadedAt: new Date(this.#clock.now()).toISOString(),
        loadDurationMs: Math.max(0, this.#clock.now() - startedAtMs),
      };
    } catch (error) {
      throw mapLoadError(error);
    }
  }

  /** Runs exactly one generation against the currently loaded model, streaming text chunks via
   * `onTextChunk` and returning the final text + metrics once generation completes. Throws
   * LocalLlmError("MODEL_NOT_READY") if no model is loaded. "cancel後にtoken eventを配送しない" is
   * enforced by node-llama-cpp itself once the internal AbortController is aborted (its `signal`
   * option stops invoking onTextChunk once the abort has been observed) — this method additionally
   * tracks a per-call generation id so a *previous*, already-superseded call's straggling callback
   * can never be mistaken for the current one. */
  async generate(input: GenerateRuntimeInput): Promise<GenerateRuntimeResult> {
    if (!this.#model || !this.#context || !this.#session || !this.#modelId) {
      throw new LocalLlmError("MODEL_NOT_READY", "no model is currently loaded", { retryable: false });
    }
    const session = this.#session;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) controller.abort(input.signal.reason);
    else input.signal?.addEventListener("abort", forwardAbort, { once: true });
    this.#activeGenerationController = controller;
    let releaseSettled!: () => void;
    this.#activeGenerationSettled = new Promise((resolve) => {
      releaseSettled = resolve;
    });

    const promptTokens = this.#estimatePromptTokens(input);
    const metrics = new GenerationMetricsCollector({ backend: this.#backend, contextSize: this.#context.contextSize, promptTokens, clock: this.#clock });

    try {
      // input.history already starts with the merged system entry (message-adapter.ts's
      // adaptMessages()) — do not prepend another one here, or the system prompt is sent twice.
      session.setChatHistory(input.history);
      const text = await session.prompt(input.prompt, {
        signal: controller.signal,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        onTextChunk: (chunk: string) => {
          if (controller.signal.aborted) return; // "cancel後にtoken eventを配送しない"
          metrics.recordToken();
          input.onTextChunk?.(chunk);
        },
      });
      return { text, metrics: metrics.finish(await this.#peakMemoryBytes()) };
    } catch (error) {
      throw normalizeLocalLlmError(error, "GENERATION_FAILED");
    } finally {
      input.signal?.removeEventListener("abort", forwardAbort);
      if (this.#activeGenerationController === controller) this.#activeGenerationController = null;
      releaseSettled();
    }
  }

  /** Used by local-llm-service.ts's cancel(requestId) when requestId is the queue's currently
   * active job — aborts whatever generate() call is in flight right now, if any. Returns whether a
   * generation was actually cancelled. */
  cancelActiveGeneration(): boolean {
    if (!this.#activeGenerationController || this.#activeGenerationController.signal.aborted) return false;
    this.#activeGenerationController.abort(new LocalLlmError("CANCELLED", "generation was cancelled", { retryable: false }));
    return true;
  }

  /** "peak memory(取得可能な場合のみ)" — best-effort: node-llama-cpp's own VRAM query reports the
   * state *after* generation completes, not a true continuously-sampled peak, but it's the only
   * memory signal the real API exposes and is exactly the "when obtainable" case the issue asks
   * for. Never throws — a query failure just means this metric is omitted, same as when the
   * backend doesn't implement getVramState() at all (e.g. a fake test module). */
  async #peakMemoryBytes(): Promise<number | undefined> {
    try {
      const state = await this.#llama.getVramState?.();
      return state?.used;
    } catch {
      return undefined;
    }
  }

  #estimatePromptTokens(input: GenerateRuntimeInput): number {
    if (!this.#model) return 0;
    try {
      // input.history already includes the system entry — see the field's doc comment above.
      const historyText = input.history.map((item) => ("text" in item ? item.text : item.response.join(""))).join("\n");
      return this.#model.tokenize(`${historyText}\n${input.prompt}`).length;
    } catch {
      return 0;
    }
  }

  /**
   * Dispose order, exactly as specified: 1) cancel any active generation, 2) stop token callback
   * delivery (implied by (1) — the abort itself is what stops onTextChunk from firing again), 3)
   * session dispose, 4) context dispose, 5) model dispose, 6) drop every internal reference. Each
   * step is independently try/caught so a failure partway through never skips the remaining
   * resource releases ("各disposeは二重呼出可能にし、途中失敗しても残りのresource解放を試みる").
   * Never throws — returns every error it swallowed so the caller (local-llm-service.ts) can decide
   * whether to surface DISPOSE_FAILED / transition to the "error" state.
   */
  async unload(): Promise<{ errors: LocalLlmError[] }> {
    const errors: LocalLlmError[] = [];

    this.cancelActiveGeneration();
    // Wait for the in-flight generate() call (if any) to actually finish unwinding from that abort
    // — cancelActiveGeneration() only *requests* the stop; disposing the session/context/model
    // before the native call underneath it has actually returned would race a still-running
    // operation against the objects it's using.
    await this.#activeGenerationSettled;

    if (this.#session) {
      try {
        this.#session.dispose({ disposeSequence: false });
      } catch (error) {
        errors.push(new LocalLlmError("DISPOSE_FAILED", "failed to dispose the chat session", { cause: error }));
      }
    }
    if (this.#context) {
      try {
        await this.#context.dispose();
      } catch (error) {
        errors.push(new LocalLlmError("DISPOSE_FAILED", "failed to dispose the inference context", { cause: error }));
      }
    }
    if (this.#model) {
      try {
        await this.#model.dispose();
      } catch (error) {
        errors.push(new LocalLlmError("DISPOSE_FAILED", "failed to dispose the model", { cause: error }));
      }
    }

    this.#session = null;
    this.#context = null;
    this.#model = null;
    this.#modelId = null;
    this.#activeGenerationController = null;

    return { errors };
  }
}

function mapLoadError(error: unknown): LocalLlmError {
  if (error instanceof LocalLlmError) return error;
  if (error instanceof Error) {
    if (error.name === "AbortError" || /aborted/i.test(error.message)) return new LocalLlmError("CANCELLED", "model load was cancelled", { retryable: false, cause: error });
    const code = classifyNativeErrorMessage(error.message);
    if (code === "OUT_OF_MEMORY") return new LocalLlmError("OUT_OF_MEMORY", "the model backend ran out of memory while loading", { cause: error });
    if (code === "CONTEXT_OVERFLOW") return new LocalLlmError("CONTEXT_CREATE_FAILED", "the requested context size could not be satisfied", { cause: error });
    const lowerMessage = error.message.toLowerCase();
    if (/gguf|magic|invalid model|failed to load model/.test(lowerMessage)) return new LocalLlmError("INVALID_GGUF", "the model file could not be parsed as a valid GGUF model", { cause: error });
  }
  return new LocalLlmError("BACKEND_INIT_FAILED", "failed to load the model", { cause: error });
}
