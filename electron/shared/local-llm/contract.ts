// Shared Main-process-internal contract for the Local LLM *inference* service (#45).
//
// This module never runs anything itself — it is the framework-free shape every module under
// electron/main/services/local-llm/ (the service, the state machine, the queue, the runtime) and
// their tests agree on. It deliberately does NOT depend on node-llama-cpp's own types: the real
// native module is loaded dynamically (native-loader.ts) and adapted onto the narrow structural
// interfaces in model-runtime.ts, so this contract stays testable against a fully fake backend.
//
// Scope reminder (see the issue body): this is the INFERENCE runtime only. Model file management
// (catalog/download/local-import/installed-registry) is #75/#76's ModelRepository
// (electron/main/services/local-llm/models/*, electron/shared/local-llm/model-contract.ts) — this
// service only ever consumes an already-installed model's id, resolved to a real path via
// ModelRepository.resolveInstalledModelPath (Main-process only, never over IPC).
import type { RequestContext } from "../services/service-contract";

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/** The 15 codes named explicitly in the issue's "Error分類" list, plus two additions this
 * implementation needs and documents here rather than silently inventing elsewhere:
 *  - UNSUPPORTED_CAPABILITY: named in the issue's message-adapter paragraph ("image contentは初期
 *    実装でUNSUPPORTED_CAPABILITY") but omitted from the Error分類 enumeration itself — kept as a
 *    first-class code rather than folding it into UNSUPPORTED_MODEL (which is about the *model*,
 *    not the *request shape*).
 *  - INVALID_REQUEST: the issue requires validating message count/length/predicted-token limits
 *    ("message数/文字数/token予測上限をload前に検証") but the closed Error分類 list has no generic
 *    validation-failure code. Reusing e.g. CONTEXT_OVERFLOW would misreport a pre-flight rejection
 *    as a runtime context-window failure, so this adds one narrowly-scoped code instead. */
export type LocalLlmErrorCode =
  | "NATIVE_UNAVAILABLE"
  | "MODEL_NOT_FOUND"
  | "MODEL_NOT_INSTALLED"
  | "INVALID_GGUF"
  | "UNSUPPORTED_MODEL"
  | "UNSUPPORTED_CAPABILITY"
  | "OUT_OF_MEMORY"
  | "BACKEND_INIT_FAILED"
  | "CONTEXT_CREATE_FAILED"
  | "MODEL_NOT_READY"
  | "BUSY"
  | "QUEUE_FULL"
  | "CONTEXT_OVERFLOW"
  | "CANCELLED"
  | "GENERATION_FAILED"
  | "DISPOSE_FAILED"
  | "INVALID_REQUEST";

/** Never carries a raw stack trace or an on-disk path — see local-llm-errors.ts. `diagnosticId`
 * is the correlation key into the (Main-process-only) diagnostic log for anyone who needs the full
 * detail this shape deliberately omits. */
export type LocalLlmErrorShape = {
  code: LocalLlmErrorCode;
  message: string;
  diagnosticId: string;
  retryable: boolean;
};

// -------------------------------------------------------------------------------------------
// State machine
// -------------------------------------------------------------------------------------------

export type LoadPhase =
  | "resolving"
  | "validating_path"
  | "verifying_file"
  | "checking_busy"
  | "unloading_previous"
  | "initializing_backend"
  | "loading_model"
  | "creating_context"
  | "creating_session"
  | "finalizing";

export type LoadedModelSummary = {
  modelId: string;
  displayName: string;
  architecture?: string;
  sizeBytes: number;
  contextSize: number;
  trainContextSize?: number;
  backend: string;
  loadedAt: string;
  loadDurationMs: number;
};

/** Implemented exactly as specified by the issue: the union below IS the state machine, and
 * local-llm-state.ts's transition table is the only thing allowed to move between its members. */
export type LocalLlmState =
  | { status: "unavailable"; reason: string }
  | { status: "idle" }
  | { status: "loading"; modelId: string; requestId: string; phase: LoadPhase }
  | { status: "ready"; model: LoadedModelSummary }
  | { status: "generating"; model: LoadedModelSummary; requestId: string; startedAt: number }
  | { status: "unloading"; modelId: string }
  | { status: "error"; error: LocalLlmErrorShape; recoverable: boolean };

export type LocalLlmStatus = LocalLlmState["status"];

// -------------------------------------------------------------------------------------------
// Capabilities / requests
// -------------------------------------------------------------------------------------------

export type LocalLlmCapabilities = {
  available: boolean;
  reason?: string;
  backend?: string;
  packageVersion?: string;
  platform: string;
  arch: string;
  supportsGpuOffload?: boolean;
};

/** Deliberately the same shape as electron/shared/services/ai-contract.ts's `AiMessage` — the
 * issue calls this "既存ChatMessage[]"; reusing that exact shape (rather than a parallel one) is
 * what keeps a future #48 connector adapter from needing an impedance-mismatch shim. `content` is
 * `unknown` at this layer on purpose: message-adapter.ts is the single place that narrows it
 * (string vs. content-part array) and rejects anything it can't handle explicitly. */
export type LocalLlmChatMessage = { role: "system" | "user" | "assistant"; content: unknown };

export type LoadModelInput = {
  modelId: string;
  /** Caller-supplied context size; the runtime clamps this to the model's trained context size. */
  contextSize?: number;
  /** When a generation is already active: cancel it and proceed instead of returning BUSY. */
  force?: boolean;
};

export type GenerateInput = {
  modelId: string;
  messages: LocalLlmChatMessage[];
  maxTokens?: number;
  temperature?: number;
};

// -------------------------------------------------------------------------------------------
// Service contract
// -------------------------------------------------------------------------------------------

// GenerationEvent lives in events.ts (the streaming/event shapes), imported here only for the
// generate() method signature — see that file's header comment for the contract/events split
// rationale (mirrors service-contract.ts vs. service-events.ts elsewhere in this repo).
import type { GenerationEvent } from "./events";

export interface LocalLlmService {
  /** Capability probe only — never loads a model (issue: "app起動時に重いmodel loadは行わず、
   * capability列挙だけを行う"). Safe to call once at app startup. */
  initialize(): Promise<LocalLlmCapabilities>;
  getState(): LocalLlmState;
  getCapabilities(): LocalLlmCapabilities;
  load(input: LoadModelInput, context: RequestContext): Promise<LoadedModelSummary>;
  unload(input: { force?: boolean }, context: RequestContext): Promise<void>;
  generate(input: GenerateInput, context: RequestContext): AsyncIterable<GenerationEvent>;
  cancel(requestId: string): boolean;
  dispose(): Promise<void>;
}
