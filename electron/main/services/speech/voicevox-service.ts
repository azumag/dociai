import { ServiceError, normalizeServiceError } from "../service-error";
import { ServiceRuntime } from "../service-runtime";

const DEFAULT_BASE_URL = "http://127.0.0.1:50021";
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function localEndpoint(value: unknown, fallback: string): URL {
  const url = new URL(typeof value === "string" && value ? value : fallback);
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname)) throw new ServiceError("BAD_REQUEST", "speech endpoint must be a local HTTP URL", { serviceId: "voicevox", retryable: false });
  return url;
}

function endpointPath(endpoint: URL, pathname: string): URL { return new URL(`${endpoint.origin}${pathname}`); }
export type VoiceVoxInput = { text: string; speaker: number; baseUrl?: string; timeoutMs?: number; pitch?: number; speed?: number; intonation?: number; volume?: number; requestId?: string; ownerId?: string; generation?: number };

export class VoiceVoxService {
  readonly runtime = new ServiceRuntime("voicevox");
  constructor(private readonly fetchFn: typeof fetch = fetch) {}
  cancel(requestId: string): boolean { return this.runtime.registry.cancel(requestId, "cancelled"); }

  async speakers(input: { baseUrl?: string; requestId?: string; ownerId?: string; generation?: number } = {}): Promise<{ speakers: Array<{ id: number; speaker: string; style: string; label: string }>; requestId: string }> {
    const endpoint = localEndpoint(input.baseUrl, DEFAULT_BASE_URL);
    const handle = this.runtime.registry.create({ serviceId: "voicevox", generation: input.generation ?? this.runtime.generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: 30_000 });
    try {
      const response = await this.fetchFn(endpointPath(endpoint, "/speakers"), { signal: handle.context.signal });
      if (!response.ok) throw new ServiceError("SERVER", `VOICEVOX returned HTTP ${response.status}`, { serviceId: "voicevox", status: response.status });
      const raw = await response.json() as Array<{ name?: string; styles?: Array<{ id?: number; name?: string }> }>;
      const speakers = [];
      for (const item of raw ?? []) for (const style of item.styles ?? []) if (Number.isSafeInteger(style.id)) speakers.push({ id: style.id!, speaker: String(item.name ?? ""), style: String(style.name ?? ""), label: `${item.name ?? ""} / ${style.name ?? ""}` });
      handle.complete(speakers);
      return { speakers, requestId: handle.context.requestId };
    } catch (error) { const normalized = normalizeServiceError(error, handle.context); handle.fail(normalized); throw normalized; }
  }

  async synthesize(input: VoiceVoxInput): Promise<{ audio: ArrayBuffer; contentType: string; requestId: string }> {
    const endpoint = localEndpoint(input.baseUrl, DEFAULT_BASE_URL);
    const text = String(input.text ?? "").replace(/[#＃]/g, "").trim();
    const speaker = Number(input.speaker);
    if (!text || !Number.isSafeInteger(speaker) || speaker < 0) throw new ServiceError("BAD_REQUEST", "VOICEVOX text or speaker is invalid", { serviceId: "voicevox", retryable: false });
    const handle = this.runtime.registry.create({ serviceId: "voicevox", generation: input.generation ?? this.runtime.generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: Math.max(1_000, Math.min(120_000, Number(input.timeoutMs) || 30_000)) });
    try {
      const queryUrl = endpointPath(endpoint, "/audio_query"); queryUrl.searchParams.set("text", text); queryUrl.searchParams.set("speaker", String(speaker));
      const queryResponse = await this.fetchFn(queryUrl, { method: "POST", signal: handle.context.signal });
      if (!queryResponse.ok) throw new ServiceError("SERVER", `VOICEVOX audio_query returned HTTP ${queryResponse.status}`, { serviceId: "voicevox", status: queryResponse.status });
      const query = await queryResponse.json() as Record<string, unknown>;
      if (!Array.isArray(query.accent_phrases)) throw new ServiceError("SERVER", "VOICEVOX audio_query response is invalid", { serviceId: "voicevox", retryable: false });
      query.pitchScale = Number(query.pitchScale ?? 0) + Number(input.pitch ?? 0); query.speedScale = Number(input.speed ?? query.speedScale ?? 1) || 1; query.intonationScale = Number(input.intonation ?? query.intonationScale ?? 1) || 1; query.volumeScale = Number(input.volume ?? query.volumeScale ?? 1) || 1;
      const synthesisUrl = endpointPath(endpoint, "/synthesis"); synthesisUrl.searchParams.set("speaker", String(speaker));
      const synthesisResponse = await this.fetchFn(synthesisUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query), signal: handle.context.signal });
      if (!synthesisResponse.ok) throw new ServiceError("SERVER", `VOICEVOX synthesis returned HTTP ${synthesisResponse.status}`, { serviceId: "voicevox", status: synthesisResponse.status });
      const audio = await synthesisResponse.arrayBuffer(); const contentType = synthesisResponse.headers.get("content-type")?.split(";", 1)[0] ?? "audio/wav";
      if (!contentType.startsWith("audio/") || audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) throw new ServiceError("SERVER", "VOICEVOX audio response is invalid or too large", { serviceId: "voicevox", retryable: false });
      handle.complete(audio.byteLength); return { audio, contentType, requestId: handle.context.requestId };
    } catch (error) { const normalized = normalizeServiceError(error, handle.context); handle.fail(normalized); throw normalized; }
  }

  dispose(): void { this.runtime.dispose(); }
}
