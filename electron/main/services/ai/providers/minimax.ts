import { ServiceError, errorFromHttpStatus } from "../../service-error";
import type { AiMessage } from "../../../../shared/services/ai-contract";

type ChatOptions = { maxTokens: number; temperature?: number; stream: boolean; onToken(text: string): void };

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

async function streamResponse(response: Response, signal: AbortSignal, serviceId: string, onToken: (text: string) => void): Promise<{ text: string; usage: unknown; finishReason?: string }> {
  if (!response.body) throw new ServiceError("EMPTY", "provider stream was empty", { serviceId, retryable: false });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  let usage: unknown = null;
  let finishReason: string | null = null;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason instanceof ServiceError ? signal.reason : new ServiceError("CANCELLED", "request cancelled", { serviceId, retryable: false });
      const { done, value } = await reader.read();
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: { delta?: { text?: unknown; stop_reason?: unknown }; usage?: unknown; content_block?: { text?: unknown } };
        try { event = JSON.parse(payload); } catch { continue; }
        const token = event.delta?.text ?? event.content_block?.text;
        if (typeof token === "string" && token) { text += token; onToken(token); }
        const reason = event.delta?.stop_reason;
        if (typeof reason === "string" && reason) finishReason = reason;
        if (event.usage !== undefined) usage = event.usage;
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
  const trimmed = text.trim();
  if (!trimmed) throw new ServiceError("EMPTY", "provider response was empty", { serviceId, retryable: false });
  return { text: trimmed, usage, ...(finishReason ? { finishReason } : {}) };
}

function anthropicMessages(messages: AiMessage[]) {
  let system = "";
  const converted = messages.flatMap((message) => {
    if (message.role === "system") { system = system ? `${system}\n\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}` : typeof message.content === "string" ? message.content : JSON.stringify(message.content); return []; }
    return [{ role: message.role === "assistant" ? "assistant" : "user", content: message.content }];
  });
  return { system, messages: converted };
}
export async function miniMaxChat(fetchFn: typeof fetch, config: { id: string; model: string; baseUrl: string; apiKey: string }, messages: AiMessage[], options: ChatOptions, signal: AbortSignal): Promise<{ text: string; usage: unknown; finishReason?: string }> {
  const converted = anthropicMessages(messages);
  let response: Response;
  try { response = await fetchFn(`${config.baseUrl.replace(/\/$/, "")}/v1/messages`, { method: "POST", signal, headers: { "Content-Type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: config.model, messages: converted.messages, max_tokens: options.maxTokens, ...(options.stream ? { stream: true } : {}), ...(converted.system ? { system: converted.system } : {}), ...(options.temperature !== undefined ? { temperature: options.temperature } : {}) }) }); }
  catch (error) { throw signal.aborted && signal.reason instanceof ServiceError ? signal.reason : error instanceof Error && error.name === "AbortError" ? new ServiceError("CANCELLED", "request cancelled", { serviceId: config.id, retryable: false }) : new ServiceError("NETWORK", "provider connection failed", { serviceId: config.id }); }
  if (!response.ok) throw errorFromHttpStatus(response.status, { serviceId: config.id, retryAfterMs: retryAfterMs(response) });
  if (options.stream) return streamResponse(response, signal, config.id, options.onToken);
  const data = await response.json() as { content?: Array<{ type?: string; text?: string }>; usage?: unknown; stop_reason?: unknown };
  const text = (data.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("").trim();
  if (!text) throw new ServiceError("EMPTY", "provider response was empty", { serviceId: config.id, retryable: false });
  const finishReason = typeof data.stop_reason === "string" ? data.stop_reason : null;
  return { text, usage: data.usage ?? null, ...(finishReason ? { finishReason } : {}) };
}
