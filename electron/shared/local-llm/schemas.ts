// Pure validation for the Local LLM inference service (#45) — no I/O, no node-llama-cpp, no
// LocalLlmError class (that lives in electron/main/services/local-llm/local-llm-errors.ts and
// wraps the ValidationFailure below into a proper LocalLlmError with a diagnosticId). Mirrors
// electron/shared/validation.ts's "shared/ can hold pure validation logic, Main-only wraps it into
// its own Error class" split.
import type { GenerateInput, LoadModelInput, LocalLlmChatMessage } from "./contract";

export const MAX_MESSAGES = 128;
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_TOTAL_CHARS = 32_000;
/** Very rough chars-per-token heuristic (English/CJK mixed) used only as a cheap upper-bound
 * sanity check before a request is ever handed to the model — the real token count (message-
 * adapter.ts's job, once a tokenizer is available) is always the authoritative one. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/** `capability` is set only when the failure came from classifyMessageContent's
 * "unsupported-capability" branch — callers (local-llm-service.ts) use its presence to choose
 * LocalLlmErrorCode "UNSUPPORTED_CAPABILITY" over the generic "INVALID_REQUEST", exactly mirroring
 * message-adapter.ts's adaptMessages()'s own AdaptMessagesResult. Losing this distinction here
 * would make an image-content request's *early* validation failure report a different, wrong error
 * code than the *same* rejection surfaces if it instead reached adaptMessages(). */
export type ValidationFailure = { field: string; reason: string; capability?: string };
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; failure: ValidationFailure };

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}
function fail<T>(field: string, reason: string, capability?: string): ValidationResult<T> {
  return { ok: false, failure: capability === undefined ? { field, reason } : { field, reason, capability } };
}

/** Text content is always accepted. Content-part arrays follow connectors.js's existing
 * `toAnthropicContent` shape (`{type:"text", text}` / `{type:"image_url", image_url:{url}}`) since
 * that is the "既存ChatMessage[]" shape this adapts. Image parts are a defined, named rejection
 * (UNSUPPORTED_CAPABILITY, applied by message-adapter.ts) — never silently stringified. Any other
 * shape is also rejected explicitly rather than being coerced via `String(...)` (issue: "unknown
 * content partを黙って文字列化しない"). */
export type NormalizedContent = { kind: "text"; text: string } | { kind: "unsupported-capability"; capability: string } | { kind: "invalid" };

export function classifyMessageContent(content: unknown): NormalizedContent {
  if (typeof content === "string") return { kind: "text", text: content };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") return { kind: "invalid" };
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        parts.push(record.text);
        continue;
      }
      if (record.type === "image_url") return { kind: "unsupported-capability", capability: "vision" };
      return { kind: "invalid" };
    }
    return { kind: "text", text: parts.join("\n") };
  }
  return { kind: "invalid" };
}

/** "message数/文字数/token予測上限をload前に検証" (message-adapter.ts's paragraph) — validated right
 * before a request is fed into the model (i.e. inside generate(), not the service's load()
 * lifecycle method, which never sees message content at all). */
export function validateMessages(messages: LocalLlmChatMessage[], options: { maxContextTokens?: number } = {}): ValidationResult<LocalLlmChatMessage[]> {
  if (!Array.isArray(messages) || messages.length === 0) return fail("messages", "messages must be a non-empty array");
  if (messages.length > MAX_MESSAGES) return fail("messages", `messages exceeds the maximum of ${MAX_MESSAGES}`);

  let totalChars = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") return fail("messages", "each message must be an object");
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") return fail("messages.role", "message role must be system, user, or assistant");
    const classified = classifyMessageContent(message.content);
    if (classified.kind === "invalid") return fail("messages.content", "message content is not a recognized shape");
    if (classified.kind === "unsupported-capability") return fail("messages.content", `unsupported content capability: ${classified.capability}`, classified.capability);
    if (classified.text.length > MAX_MESSAGE_CHARS) return fail("messages.content", `a single message exceeds ${MAX_MESSAGE_CHARS} characters`);
    totalChars += classified.text.length;
    if (totalChars > MAX_TOTAL_CHARS) return fail("messages", `total message length exceeds ${MAX_TOTAL_CHARS} characters`);
  }

  const predictedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE);
  if (options.maxContextTokens !== undefined && predictedTokens > options.maxContextTokens) {
    return fail("messages", `predicted prompt tokens (~${predictedTokens}) exceed the model's context budget (${options.maxContextTokens})`);
  }
  return ok(messages);
}

export function validateGenerateInput(input: GenerateInput, options: { maxContextTokens?: number } = {}): ValidationResult<GenerateInput> {
  if (!input || typeof input.modelId !== "string" || input.modelId.length === 0) return fail("modelId", "modelId is required");
  if (input.maxTokens !== undefined && (!Number.isFinite(input.maxTokens) || input.maxTokens <= 0)) return fail("maxTokens", "maxTokens must be a positive number");
  // A caller asking for more generated tokens than the whole context can ever hold is always
  // wrong, regardless of how short the prompt is — bound it here rather than letting it reach the
  // native backend unchecked.
  if (input.maxTokens !== undefined && options.maxContextTokens !== undefined && input.maxTokens > options.maxContextTokens) {
    return fail("maxTokens", `maxTokens (${input.maxTokens}) exceeds the model's context size (${options.maxContextTokens})`);
  }
  if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0)) return fail("temperature", "temperature must be a non-negative number");
  const messages = validateMessages(input.messages, options);
  if (!messages.ok) return messages;
  return ok(input);
}

export function validateLoadModelInput(input: LoadModelInput): ValidationResult<LoadModelInput> {
  if (!input || typeof input.modelId !== "string" || input.modelId.length === 0) return fail("modelId", "modelId is required");
  if (input.contextSize !== undefined && (!Number.isInteger(input.contextSize) || input.contextSize <= 0)) return fail("contextSize", "contextSize must be a positive integer");
  return ok(input);
}
