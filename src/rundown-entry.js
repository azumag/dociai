import {
  hasElectronVoiceVoxService,
  speakersThroughElectron,
  synthesizeThroughElectron,
} from "./platform/electron-services.js";

const nativeFetch = globalThis.fetch?.bind(globalThis);
let pendingQuery = null;
let requestSequence = 0;

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function isLocalVoiceVoxUrl(url) {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
}

function nativeSpeakerShape(flatSpeakers) {
  const groups = new Map();
  for (const entry of flatSpeakers ?? []) {
    const name = String(entry.speaker ?? "");
    if (!groups.has(name)) groups.set(name, { name, styles: [] });
    groups.get(name).styles.push({ id: Number(entry.id), name: String(entry.style ?? "") });
  }
  return [...groups.values()];
}

async function fetchThroughElectronVoiceVox(input, init = {}) {
  const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
  const url = new URL(rawUrl, globalThis.location?.href);
  if (!isLocalVoiceVoxUrl(url)) return nativeFetch(input, init);

  if (url.pathname === "/version") {
    const result = await speakersThroughElectron({ baseUrl: url.origin });
    if (!result?.ok) return jsonResponse({ error: result?.error?.message ?? "VOICEVOX接続に失敗しました" }, { status: 502 });
    return jsonResponse(`Electron bridge / 話者 ${result.value.speakers.length}件`);
  }

  if (url.pathname === "/speakers") {
    const result = await speakersThroughElectron({ baseUrl: url.origin });
    if (!result?.ok) return jsonResponse({ error: result?.error?.message ?? "VOICEVOX話者一覧を取得できません" }, { status: 502 });
    return jsonResponse(nativeSpeakerShape(result.value.speakers));
  }

  if (url.pathname === "/audio_query") {
    const text = String(url.searchParams.get("text") ?? "");
    const speaker = Number(url.searchParams.get("speaker"));
    if (!text.trim() || !Number.isSafeInteger(speaker) || speaker < 0) {
      return jsonResponse({ error: "textまたはspeakerが不正です" }, { status: 400 });
    }
    pendingQuery = { text, speaker, baseUrl: url.origin };
    return jsonResponse({ pitchScale: 0, speedScale: 1, intonationScale: 1, volumeScale: 1 });
  }

  if (url.pathname === "/synthesis") {
    const speaker = Number(url.searchParams.get("speaker"));
    if (!pendingQuery || pendingQuery.speaker !== speaker) {
      return jsonResponse({ error: "対応するaudio_queryがありません" }, { status: 409 });
    }
    let query = {};
    try { query = init?.body ? JSON.parse(String(init.body)) : {}; }
    catch { return jsonResponse({ error: "音声クエリJSONが不正です" }, { status: 400 }); }

    const current = pendingQuery;
    pendingQuery = null;
    const result = await synthesizeThroughElectron({
      requestId: `rundown-voicevox-${Date.now()}-${++requestSequence}`,
      baseUrl: current.baseUrl,
      timeoutMs: 30_000,
      text: current.text,
      speaker,
      pitch: Number(query.pitchScale) || 0,
      speed: Number(query.speedScale) || 1,
      intonation: Number(query.intonationScale) || 1,
      volume: Number(query.volumeScale) || 1,
    });
    if (!result?.ok) {
      return jsonResponse({ error: result?.error?.message ?? "VOICEVOX合成に失敗しました" }, { status: 502 });
    }
    return new Response(result.value.audio, {
      status: 200,
      headers: { "Content-Type": result.value.contentType || "audio/wav" },
    });
  }

  return nativeFetch(input, init);
}

if (hasElectronVoiceVoxService() && nativeFetch) {
  globalThis.fetch = fetchThroughElectronVoiceVox;
}

await import("./rundown-app.js");
