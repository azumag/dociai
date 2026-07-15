import { ServiceError, errorFromHttpStatus } from "../../service-error";
import type { AiMessage } from "../../../../shared/services/ai-contract";

type ChatOptions = { maxTokens: number; temperature?: number; stream: boolean; onToken(text: string): void };

function abortError(signal: AbortSignal, serviceId: string): ServiceError {
  return signal.reason instanceof ServiceError ? signal.reason : new ServiceError("CANCELLED", "request cancelled", { serviceId, retryable: false });
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

async function streamResponse(response: Response, signal: AbortSignal, serviceId: string, onToken: (text: string) => void): Promise<{ text: string; usage: unknown }> {
  if (!response.body) throw new ServiceError("EMPTY", "provider stream was empty", { serviceId, retryable: false });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  let usage: unknown = null;
  try {
    while (true) {
      if (signal.aborted) throw abortError(signal, serviceId);
      const { done, value } = await reader.read();
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: { choices?: Array<{ delta?: { content?: unknown } }>; usage?: unknown };
        try { event = JSON.parse(payload); } catch { continue; }
        const token = event.choices?.[0]?.delta?.content;
        if (typeof token === "string" && token) { text += token; onToken(token); }
        if (event.usage !== undefined) usage = event.usage;
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
  const trimmed = text.trim();
  if (!trimmed) throw new ServiceError("EMPTY", "provider response was empty", { serviceId, retryable: false });
  return { text: trimmed, usage };
}

export async function openAiCompatibleChat(fetchFn: typeof fetch, config: { id: string; provider: string; model: string; baseUrl: string; apiKey?: string }, messages: AiMessage[], options: ChatOptions, signal: AbortSignal): Promise<{ text: string; usage: unknown }> {
  let response: Response;
  try {
    response = await fetchFn(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", signal, headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}), ...(config.provider === "openrouter" ? { "HTTP-Referer": "https://dociai.local", "X-Title": "dociai" } : {}) }, body: JSON.stringify({ model: config.model, messages, max_tokens: options.maxTokens, ...(config.provider === "ollama" ? { reasoning_effort: "none" } : {}), ...(options.stream ? { stream: true, stream_options: { include_usage: true } } : {}), ...(options.temperature !== undefined ? { temperature: options.temperature } : {}) }) });
  } catch (error) { throw signal.aborted || (error instanceof Error && error.name === "AbortError") ? abortError(signal, config.id) : new ServiceError("NETWORK", "provider connection failed", { serviceId: config.id }); }
  if (!response.ok) throw errorFromHttpStatus(response.status, { serviceId: config.id, retryAfterMs: retryAfterMs(response) });
  if (options.stream) return streamResponse(response, signal, config.id, options.onToken);
  const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
  const text = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content.trim() : "";
  if (!text) throw new ServiceError("EMPTY", "provider response was empty", { serviceId: config.id, retryable: false });
  return { text, usage: data.usage ?? null };
}
