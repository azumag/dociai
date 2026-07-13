// Error class + mapping for the Local LLM inference service (#45). Mirrors
// electron/main/services/service-error.ts's role for the generic ServiceError taxonomy: the
// *shape*/*codes* live in shared (electron/shared/local-llm/contract.ts's LocalLlmErrorCode /
// LocalLlmErrorShape), this file owns the runtime Error class, native-error classification, and
// the diagnostic-id/log correlation that keeps "内部stack/native pathをそのままRendererへ返さず
// 診断IDでlogと関連付ける" true in practice.
import crypto from "node:crypto";
import type { LocalLlmErrorCode, LocalLlmErrorShape } from "../../../shared/local-llm/contract";
import { createStructuredLogContext } from "../structured-log-context";

const SERVICE_ID = "local-llm";

const RETRYABLE_CODES: ReadonlySet<LocalLlmErrorCode> = new Set(["BUSY", "QUEUE_FULL", "BACKEND_INIT_FAILED", "OUT_OF_MEMORY"]);

export class LocalLlmError extends Error {
  readonly code: LocalLlmErrorCode;
  readonly diagnosticId: string;
  readonly retryable: boolean;

  constructor(code: LocalLlmErrorCode, message: string, options: { retryable?: boolean; cause?: unknown; diagnosticId?: string } = {}) {
    // The standard Error#cause (ES2022) carries the real underlying failure — logged (redacted)
    // via logLocalLlmError() below, never handed to toJSON()/the Renderer.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LocalLlmError";
    this.code = code;
    this.diagnosticId = options.diagnosticId ?? crypto.randomUUID();
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
  }

  toJSON(): LocalLlmErrorShape {
    return { code: this.code, message: this.message, diagnosticId: this.diagnosticId, retryable: this.retryable };
  }
}

export function isLocalLlmError(error: unknown): error is LocalLlmError {
  return error instanceof LocalLlmError;
}

/** Cancellation detector shared by every module in this service — matches the CANCELLED code and
 * the DOMException("AbortError")/Error("This operation was aborted") shapes node-llama-cpp's own
 * AbortSignal handling throws (verified against the real package; see native-loader.ts). */
export function isCancellation(error: unknown): boolean {
  if (isLocalLlmError(error)) return error.code === "CANCELLED";
  if (error instanceof Error) return error.name === "AbortError" || /aborted/i.test(error.message);
  return false;
}

/**
 * Message-text classification shared by normalizeLocalLlmError() (generation-time) and
 * model-runtime.ts's mapLoadError() (load-time) — kept in exactly one place so the two never drift
 * apart. Patterns are matched against REAL node-llama-cpp@3.19.0 message text, verified directly
 * against node_modules/node-llama-cpp/dist source during development, not guessed:
 *  - OOM: `InsufficientMemoryError`'s default message is literally "Insufficient memory"
 *    (utils/InsufficientMemoryError.js), and its specific call sites
 *    (gguf/insights/utils/resolve{Model,Context}...Option.js) say "... is too large for the
 *    available VRAM/RAM ...". A bare `/oom/` substring match was deliberately removed — it false-
 *    positives on unrelated words like "room"/"zoom" and never matched any message this package
 *    actually throws.
 *  - CONTEXT_OVERFLOW: two distinct real messages observed — LlamaChatSession's context-shift
 *    compaction failure ("Failed to compress chat history for context shift due to a too long
 *    prompt or system message...") and LlamaContext's lower-level token-eviction failure ("Failed
 *    to free up space for new tokens", evaluator/LlamaContext/LlamaContext.js).
 */
export function classifyNativeErrorMessage(message: string): LocalLlmErrorCode | null {
  const lowerMessage = message.toLowerCase();
  if (/insufficient memory|too large for the available|not enough (vram|memory|ram)/.test(lowerMessage)) return "OUT_OF_MEMORY";
  if (/failed to free up space for new tokens/.test(lowerMessage)) return "CONTEXT_OVERFLOW";
  if (/context/.test(lowerMessage) && /(overflow|too long|shift)/.test(lowerMessage)) return "CONTEXT_OVERFLOW";
  return null;
}

/** Normalizes anything thrown by node-llama-cpp (or by this service's own code) into a
 * LocalLlmError, defaulting to GENERATION_FAILED for a truly unrecognized failure. Never passes
 * `error.message`/`error.stack` straight through when they might contain a filesystem path —
 * callers that already know a more specific code (MODEL_NOT_FOUND, INVALID_GGUF, ...) should
 * construct a LocalLlmError directly instead of routing through this generic fallback. */
export function normalizeLocalLlmError(error: unknown, fallbackCode: LocalLlmErrorCode = "GENERATION_FAILED"): LocalLlmError {
  if (isLocalLlmError(error)) return error;
  if (isCancellation(error)) return new LocalLlmError("CANCELLED", "the request was cancelled", { retryable: false, cause: error });
  if (error instanceof Error) {
    const code = classifyNativeErrorMessage(error.message);
    if (code === "OUT_OF_MEMORY") return new LocalLlmError("OUT_OF_MEMORY", "the model backend ran out of memory", { cause: error });
    if (code === "CONTEXT_OVERFLOW") return new LocalLlmError("CONTEXT_OVERFLOW", "the request no longer fits in the model's context window", { cause: error });
    return new LocalLlmError(fallbackCode, "the local model backend reported an unexpected failure", { cause: error });
  }
  return new LocalLlmError(fallbackCode, "the local model backend reported an unexpected failure", { cause: error });
}

/** Routes every diagnostic line through structured-log-context.ts's redaction idiom, keyed by the
 * error's diagnosticId so a caller-visible LocalLlmErrorShape can always be correlated back to the
 * full (locally logged only) detail without ever handing that detail to a Renderer. `fields` must
 * never include a prompt/message body or an absolute filesystem path — see this service's module
 * docs ("prompt本文やlocal pathが通常診断へ露出しない"). */
export function logLocalLlmError(error: LocalLlmError, fields: Record<string, unknown> = {}): void {
  console.error(
    `[dociai:local-llm] ${error.message}`,
    createStructuredLogContext({
      serviceId: SERVICE_ID,
      fields: {
        code: error.code,
        diagnosticId: error.diagnosticId,
        causeName: error.cause instanceof Error ? error.cause.name : typeof error.cause,
        causeMessage: error.cause instanceof Error ? error.cause.message : undefined,
        ...fields,
      },
    }),
  );
}
