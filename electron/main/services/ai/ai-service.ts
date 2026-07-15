import type { AiChatInput, AiChatResponse, AiMessage, AiTokenEvent } from "../../../shared/services/ai-contract";
import type { SecretStore } from "../../../shared/secret-contract";
import { ConfigRepository } from "../../config/config-repository";
import { ServiceRuntime } from "../service-runtime";
import { retryWithPolicy } from "../retry-policy";
import { ServiceError, normalizeServiceError } from "../service-error";
import { providerConfig } from "./provider-registry";
import { openAiCompatibleChat } from "./providers/openai-compatible";
import { miniMaxChat } from "./providers/minimax";
import { mockChat } from "./providers/mock";

const maxMessages = 64;
const maxChars = 128000;

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function assertMessages(messages: AiMessage[]): void {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > maxMessages) throw new ServiceError("BAD_REQUEST", "AI messages are invalid", { serviceId: "ai", retryable: false });
  let characters = 0;
  for (const message of messages) {
    if (!message || !["system", "user", "assistant"].includes(message.role)) throw new ServiceError("BAD_REQUEST", "AI message role is invalid", { serviceId: "ai", retryable: false });
    let serialized: string;
    try { serialized = JSON.stringify(message.content); } catch { throw new ServiceError("BAD_REQUEST", "AI message content is invalid", { serviceId: "ai", retryable: false }); }
    characters += serialized.length;
    if (characters > maxChars) throw new ServiceError("BAD_REQUEST", "AI messages are too large", { serviceId: "ai", retryable: false });
  }
}

export class AiService {
  readonly runtime = new ServiceRuntime("ai");
  constructor(private readonly configRepository: ConfigRepository, private readonly secretStore: SecretStore, private readonly fetchFn: typeof fetch = fetch, private readonly emitToken: (event: AiTokenEvent) => void = () => {}) {}

  cancel(requestId: string): boolean { return this.runtime.registry.cancel(requestId, "cancelled"); }

  async chat(input: AiChatInput): Promise<AiChatResponse> {
    if (!input.connectorId || input.connectorId.length > 128) throw new ServiceError("BAD_REQUEST", "AI connector is invalid", { serviceId: "ai", retryable: false });
    assertMessages(input.messages);
    const loaded = await this.configRepository.getPublic();
    const connectors = (loaded.config.connectors ?? {}) as Record<string, Record<string, unknown>>;
    const connector = connectors[input.connectorId];
    if (!connector) throw new ServiceError("BAD_REQUEST", "connector was not found", { serviceId: input.connectorId, retryable: false });
    const secretRef = typeof connector.apiKeySecretRef === "string" ? connector.apiKeySecretRef : typeof connector.secretRef === "string" ? connector.secretRef : `connector.${input.connectorId}.apiKey`;
    const secret = await this.secretStore.getForService(secretRef as never);
    const config = providerConfig(input.connectorId, connector, secret);
    const generation = input.generation ?? this.runtime.generation;
    if (generation !== this.runtime.generation) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId: input.connectorId, retryable: false });
    const handle = this.runtime.registry.create({ serviceId: input.connectorId, generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: config.timeoutMs });
    const options = {
      maxTokens: boundedNumber(input.options?.maxTokens, config.maxTokens, 1, 32768),
      ...(input.options?.temperature !== undefined ? { temperature: boundedNumber(input.options.temperature, 1, 0, 2) } : {}),
      stream: input.options?.stream === true,
      onToken: (text: string) => {
        if (handle.context.signal.aborted || handle.context.generation !== this.runtime.generation || !text) return;
        this.emitToken({ connectorId: input.connectorId, requestId: handle.context.requestId, generation: handle.context.generation, text });
      },
    };
    try {
      const result = await retryWithPolicy(async () => {
        if (config.provider === "mock") return mockChat(input.messages, options);
        if (config.provider === "minimax") return miniMaxChat(this.fetchFn, { ...config, apiKey: config.apiKey ?? "" }, input.messages, options, handle.context.signal);
        return openAiCompatibleChat(this.fetchFn, config, input.messages, options, handle.context.signal);
      }, { maxAttempts: 1 + config.retries, baseDelayMs: 500, maxDelayMs: 5000 }, handle.context);
      if (handle.context.generation !== this.runtime.generation || handle.context.signal.aborted) throw new ServiceError("CANCELLED", "request generation is stale", { serviceId: input.connectorId, retryable: false });
      handle.complete(result);
      this.runtime.health.report({ type: "completed", serviceId: input.connectorId, requestId: handle.context.requestId, at: Date.now() });
      return { ...result, requestId: handle.context.requestId };
    } catch (error) {
      const normalized = normalizeServiceError(error, handle.context);
      handle.fail(normalized);
      this.runtime.health.report({ type: "failed", serviceId: input.connectorId, requestId: handle.context.requestId, at: Date.now(), error: normalized.toJSON() });
      throw normalized;
    }
  }
  dispose(): void { this.runtime.dispose(); }
}
