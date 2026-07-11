export function applyConfigDefaults(config) {
  const copy = structuredClone(config);
  copy.router = { defaultPersona: copy.personas?.[0]?.id, maxRepliesPerComment: 1, cooldownSeconds: 8, ...(copy.router ?? {}) };
  copy.context = { commentHistoryLimit: 80, includeRecentComments: 20, maxPromptChars: 4000, ...(copy.context ?? {}), screenCapture: { enabled: false, maxAgeSeconds: 120, maxTokens: 768, ...(copy.context?.screenCapture ?? {}) } };
  copy.speechQueue = { maxPending: 50, maxPendingPerSource: 20, maxAgeMs: 120000, maxHistory: 50, overflow: "drop-oldest", expireWhileHeld: true, strictOrdering: false, ...(copy.speechQueue ?? {}) };
  copy.voicevox = { enabled: false, baseUrl: "http://127.0.0.1:50021", defaultSpeaker: 3, maxChars: 200, timeoutMs: 30000, retries: 1, ...(copy.voicevox ?? {}) };
  copy.bouyomi = { enabled: false, baseUrl: "http://127.0.0.1:50080", timeoutMs: 5000, voice: 0, volume: -1, speed: -1, tone: -1, ...(copy.bouyomi ?? {}) };
  copy.micMonitor = { enabled: false, threshold: 0.05, minSpeechMs: 150, silenceHoldMs: 800, ...(copy.micMonitor ?? {}) };
  copy.commentReader = { enabled: false, engine: "webspeech", name: "default", rate: 1, pitch: 1, includeAuthor: true, skipEmotes: false, ignoreUsers: [], ...(copy.commentReader ?? {}) };
  copy.news = { enabled: false, mode: "topic", maxItems: 3, dedupe: true, sources: [], ...(copy.news ?? {}) };
  copy.topics = { enabled: false, maxItems: 3, dedupe: true, sources: [], intro: "上のお題について、あなたのキャラクターとして自由にコメントしてください。", style: "雑談のお題として、自然な自分の言葉で自由にコメントする", ...(copy.topics ?? {}) };
  copy.commentSources = { ...(copy.commentSources ?? {}), twitch: { enabled: false, ...(copy.commentSources?.twitch ?? {}) } };
  copy.personas = (copy.personas ?? []).map((persona) => ({ enabled: true, triggers: [], ...persona, voice: { enabled: true, engine: "webspeech", name: "default", rate: 1, pitch: 1, ...(persona.voice ?? {}) } }));
  return copy;
}
