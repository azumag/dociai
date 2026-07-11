import { ServiceError, normalizeServiceError } from "../service-error";
import { ServiceRuntime } from "../service-runtime";

const DEFAULT_BASE_URL = "http://127.0.0.1:50080";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
function localEndpoint(value: unknown): URL { const url = new URL(typeof value === "string" && value ? value : DEFAULT_BASE_URL); if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname)) throw new ServiceError("BAD_REQUEST", "Bouyomi endpoint must be a local HTTP URL", { serviceId: "bouyomi", retryable: false }); return url; }
export type BouyomiInput = { text: string; baseUrl?: string; timeoutMs?: number; voice?: number; volume?: number; speed?: number; tone?: number; requestId?: string; ownerId?: string; generation?: number };

export class BouyomiService {
  readonly runtime = new ServiceRuntime("bouyomi");
  constructor(private readonly fetchFn: typeof fetch = fetch) {}
  cancel(requestId: string): boolean { return this.runtime.registry.cancel(requestId, "cancelled"); }
  async talk(input: BouyomiInput): Promise<{ submitted: true; requestId: string }> {
    const text = String(input.text ?? "").trim(); if (!text) throw new ServiceError("BAD_REQUEST", "Bouyomi text is empty", { serviceId: "bouyomi", retryable: false });
    const endpoint = localEndpoint(input.baseUrl); const handle = this.runtime.registry.create({ serviceId: "bouyomi", generation: input.generation ?? this.runtime.generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: Math.max(500, Math.min(30_000, Number(input.timeoutMs) || 5_000)) });
    try { const url = new URL(`${endpoint.origin}/Talk`); for (const [key, value] of Object.entries({ text, voice: input.voice ?? -1, volume: input.volume ?? -1, speed: input.speed ?? -1, tone: input.tone ?? -1 })) url.searchParams.set(key, String(value)); const response = await this.fetchFn(url, { signal: handle.context.signal }); if (!response.ok) throw new ServiceError("SERVER", `Bouyomi returned HTTP ${response.status}`, { serviceId: "bouyomi", status: response.status }); handle.complete(true); return { submitted: true, requestId: handle.context.requestId }; } catch (error) { const normalized = normalizeServiceError(error, handle.context); handle.fail(normalized); throw normalized; }
  }
  async clear(input: { baseUrl?: string; timeoutMs?: number; requestId?: string; ownerId?: string; generation?: number } = {}): Promise<{ cleared: true; requestId: string }> {
    const endpoint = localEndpoint(input.baseUrl); const handle = this.runtime.registry.create({ serviceId: "bouyomi", generation: input.generation ?? this.runtime.generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: Math.max(500, Math.min(30_000, Number(input.timeoutMs) || 5_000)) });
    try { const response = await this.fetchFn(new URL(`${endpoint.origin}/Clear`), { signal: handle.context.signal }); if (!response.ok) throw new ServiceError("SERVER", `Bouyomi returned HTTP ${response.status}`, { serviceId: "bouyomi", status: response.status }); handle.complete(true); return { cleared: true, requestId: handle.context.requestId }; } catch (error) { const normalized = normalizeServiceError(error, handle.context); handle.fail(normalized); throw normalized; }
  }
  dispose(): void { this.runtime.dispose(); }
}
