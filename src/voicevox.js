// VOICEVOX 音声合成バックエンド (issue #17)
// soviet_now/voicevox_tts.sh のチャンク分割・audio_query→synthesis の2段階合成を
// ブラウザ向けに移植したもの。テキストが長いときは句点・読点・改行で分割して
// 順番に合成・再生する (engine が 1リクエストで安定して扱える長さに限界があるため)。
//
// エンドポイント (engine 既定):
//   GET  /speakers                              話者一覧
//   POST /audio_query?text=...&speaker=N        音声クエリJSONを取得
//   POST /synthesis?speaker=N                   クエリJSONを投げてWAVを取得
//
// CORS: engine は Origin を見て Access-Control-Allow-Origin を返す (既定の localrequests)。
// http://localhost:8080 からのリクエストはそのまま通る。

const DEFAULT_BASE_URL = "http://127.0.0.1:50021";
const DEFAULT_MAX_CHARS = 200;

export class VoiceVoxClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 30000, retries = 1, log = () => {} } = {}) {
    this.baseUrl = String(baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = Number(timeoutMs) || 30000;
    this.retries = Number(retries) >= 0 ? Number(retries) : 1;
    this.log = log;
    this._cachedSpeakers = null;
  }

  async #fetch(pathname, { method = "GET", query = null, body = null, expect = "json" } = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: body != null ? { "Content-Type": "application/json" } : {},
        body: body != null ? JSON.stringify(body) : null,
        signal: controller.signal,
        credentials: "omit",
      });
    } catch (e) {
      if (e.name === "AbortError") throw new VoiceVoxError(`${this.baseUrl} が ${Math.round(this.timeoutMs / 1000)}秒でタイムアウトしました`, "timeout");
      throw new VoiceVoxError(`VOICEVOX エンジンに接続できません (${e.message})`, "network");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 200); } catch {}
      throw new VoiceVoxError(`VOICEVOX エンジンが HTTP ${res.status} を返しました${detail ? ` — ${detail}` : ""}`, "http");
    }
    if (expect === "blob") return await res.blob();
    return await res.json();
  }

  async speakers({ force = false } = {}) {
    if (this._cachedSpeakers && !force) return this._cachedSpeakers;
    const data = await this.#fetch("/speakers");
    const out = [];
    for (const s of data ?? []) {
      for (const st of s.styles ?? []) {
        out.push({ id: st.id, speaker: s.name, style: st.name, label: `${s.name} / ${st.name}` });
      }
    }
    this._cachedSpeakers = out;
    return out;
  }

  // audio_query → pitch/speed/intonation 適用 → synthesis でWAV Blob を返す。
  // ピッチ・テンポ・抑揚は soviet_now 通りクエリJSONの scale 系フィールドに加算/上書きする。
  async synth(text, { speaker, pitch = 0, speed = 1.0, intonation = 1.0, volume = 1.0 } = {}) {
    const sp = Number(speaker);
    if (!Number.isFinite(sp) || sp < 0) throw new VoiceVoxError(`speaker ID が不正です: ${speaker}`, "bad_request");
    const clean = String(text ?? "").replace(/[#＃]/g, "");
    if (!clean.trim()) throw new VoiceVoxError("合成対象のテキストが空です", "bad_request");

    const query = await this.#fetch("/audio_query", {
      method: "POST",
      query: { text: clean, speaker: sp },
    });
    if (!query || !Array.isArray(query.accent_phrases)) {
      throw new VoiceVoxError("audio_query の応答が想定外です", "server");
    }
    query.pitchScale = (Number(query.pitchScale) || 0) + Number(pitch || 0);
    query.speedScale = Number(speed ?? query.speedScale ?? 1.0) || 1.0;
    query.intonationScale = Number(intonation ?? query.intonationScale ?? 1.0) || 1.0;
    query.volumeScale = Number(volume ?? query.volumeScale ?? 1.0) || 1.0;

    const wav = await this.#fetch("/synthesis", {
      method: "POST",
      query: { speaker: sp },
      body: query,
      expect: "blob",
    });
    if (!(wav instanceof Blob) || wav.size === 0) {
      throw new VoiceVoxError("synthesis が空の音声を返しました", "server");
    }
    return wav;
  }
}

export class VoiceVoxError extends Error {
  constructor(message, kind = "unknown") {
    super(message);
    this.name = "VoiceVoxError";
    this.kind = kind; // "network" | "timeout" | "http" | "server" | "bad_request"
  }
}

// soviet_now/voicevox_tts.sh の _split_text と同じアルゴリズム。
// 句点(。)で文に分け、さらに長い文は読点(、)で分け、maxChars を超えないよう結合する。
export function chunkText(text, maxChars = DEFAULT_MAX_CHARS) {
  const max = Math.max(8, Number(maxChars) || DEFAULT_MAX_CHARS);
  const chunks = [];
  const push = (s) => {
    const trimmed = s.trim();
    if (!trimmed) return;
    if (chunks.length && chunks[chunks.length - 1].length + trimmed.length <= max) {
      chunks[chunks.length - 1] += trimmed;
    } else {
      chunks.push(trimmed);
    }
  };
  for (const line of String(text ?? "").split("\n")) {
    for (const sentRaw of line.split("。")) {
      const sent = sentRaw.trim();
      if (!sent) continue;
      const withDot = `${sent}。`;
      if (withDot.length <= max) {
        push(withDot);
        continue;
      }
      // 読点で再分割
      let buf = "";
      for (const part of withDot.split("、")) {
        const candidate = buf ? `${buf}、${part}` : part;
        if (candidate.length > max && buf) {
          chunks.push(buf);
          buf = part;
        } else {
          buf = candidate;
        }
      }
      if (buf) chunks.push(buf);
    }
  }
  return chunks;
}
