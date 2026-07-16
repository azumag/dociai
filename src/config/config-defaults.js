// 全ペルソナ共通のプロンプトルール (issue #6の COMMON_RULES 相当)。context.commonRules として
// config化されているのは、放送内容やAIの口調ポリシーはコード変更なしで運用者が調整できる必要が
// あるため — src/context-builder.js / src/context/stream-event-context.js はどちらもこの
// config値をそのまま使い、既定文言はここ1箇所だけが持つ。
export const DEFAULT_COMMON_RULES = [
  "あなたはライブ配信に出演するAIです。",
  "返答は音声読み上げ前提。話し言葉で2文以内、80文字程度までにする。",
  "絵文字、顔文字、記号の羅列、URLは使わない。",
  "配信者や視聴者を不快にさせる発言はしない。",
].join("\n");

// commentReaderの旧フラットvoice設定を、engineごとの独立設定へ移す。
// 明示済みのネスト設定を最優先し、旧configは読み込むだけで同じ値を引き継げる。
export function commentReaderDefaults(input = {}) {
  const {
    name, rate, pitch, speaker, speed, intonation, volume, voice, tone,
    webspeech, voicevox, bouyomi,
    ...common
  } = input ?? {};
  const engine = common.engine ?? "webspeech";
  const section = (value, defaults) => {
    if (value === undefined) return defaults;
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return { ...defaults, ...value };
  };
  const legacyWebSpeech = engine === "webspeech" ? { ...(name != null ? { name } : {}), ...(rate != null ? { rate } : {}), ...(pitch != null ? { pitch } : {}) } : {};
  const legacyVoiceVox = engine === "voicevox" ? { ...(speaker != null ? { speaker } : {}), ...(rate != null ? { speed: rate } : {}), ...(pitch != null ? { pitch } : {}), ...(intonation != null ? { intonation } : {}), ...(volume != null ? { volume } : {}) } : {};
  const legacyBouyomi = engine === "bouyomi" ? { ...(voice != null ? { voice } : {}), ...(speed != null ? { speed } : {}), ...(tone != null ? { tone } : {}), ...(volume != null ? { volume } : {}) } : {};
  return {
    enabled: false,
    engine,
    includeAuthor: true,
    skipEmotes: false,
    collapseConsecutiveEmoji: false,
    ignoreUsers: [],
    ...common,
    webspeech: section(webspeech, { name: "default", rate: 1, pitch: 1, ...legacyWebSpeech }),
    voicevox: section(voicevox, { speed: 1, pitch: 0, intonation: 1, volume: 1, ...legacyVoiceVox }),
    // 未指定値はruntimeでbouyomi共通設定へフォールバックする。ここで0/-1を
    // 埋めると、旧configが使っていたbouyomi.voice/tone/volumeを上書きしてしまう。
    bouyomi: section(bouyomi, legacyBouyomi),
  };
}

export function applyConfigDefaults(config) {
  const copy = structuredClone(config);
  copy.router = { defaultPersona: copy.personas?.[0]?.id, maxRepliesPerComment: 1, cooldownSeconds: 8, historyTtlSeconds: 7200, historyMaxEntries: 2000, ...(copy.router ?? {}) };
  copy.context = { commentHistoryLimit: 80, includeRecentComments: 20, maxPromptChars: 4000, commonRules: DEFAULT_COMMON_RULES, ...(copy.context ?? {}), screenCapture: { enabled: false, maxAgeSeconds: 120, maxTokens: 768, sourceName: "", ...(copy.context?.screenCapture ?? {}) } };
  copy.speechQueue = { maxPending: 50, maxPendingPerSource: 20, maxAgeMs: 120000, maxHistory: 50, overflow: "drop-oldest", expireWhileHeld: true, strictOrdering: false, ...(copy.speechQueue ?? {}) };
  copy.voicevox = { enabled: false, baseUrl: "http://127.0.0.1:50021", defaultSpeaker: 3, maxChars: 200, timeoutMs: 30000, retries: 1, ...(copy.voicevox ?? {}) };
  copy.bouyomi = { enabled: false, baseUrl: "http://127.0.0.1:50080", timeoutMs: 5000, voice: 0, volume: -1, speed: -1, tone: -1, charsPerSecond: 6, ...(copy.bouyomi ?? {}) };
  copy.micMonitor = { enabled: false, threshold: 0.05, minSpeechMs: 150, silenceHoldMs: 800, ...(copy.micMonitor ?? {}) };
  copy.commentReader = commentReaderDefaults(copy.commentReader);
  copy.research = { enabled: false, connector: "", maxResults: 5, ...(copy.research ?? {}) };
  copy.news = { enabled: false, mode: "topic", maxItems: 3, dedupe: true, sources: [], ...(copy.news ?? {}), retry: { maxAttempts: 3, initialDelaySeconds: 30, maxDelaySeconds: 900, ...(copy.news?.retry ?? {}) } };
  copy.topics = { enabled: false, maxItems: 3, dedupe: true, sources: [], intro: "上のお題について、あなたのキャラクターとして自由にコメントしてください。", style: "雑談のお題として、自然な自分の言葉で自由にコメントする", randomPersona: false, personas: [], ...(copy.topics ?? {}), retry: { maxAttempts: 3, initialDelaySeconds: 30, maxDelaySeconds: 900, ...(copy.topics?.retry ?? {}) } };
  copy.commentSources = { ...(copy.commentSources ?? {}), twitch: { enabled: false, ...(copy.commentSources?.twitch ?? {}) } };
  // Issue #94: broadcaster identity + enabled EventSub features for the Twitch auth/EventSub
  // overview screen. Deliberately does NOT include a client id field — that is a build/deploy-time
  // constant (`TWITCH_CLIENT_ID`, Main-process only), never user-editable config; see
  // electron/main/services/twitch/twitch-composition.ts's own doc comment for why.
  copy.twitch = { broadcasterUserId: null, enabledFeatures: ["bits", "subscriptions", "redemptions"], ...(copy.twitch ?? {}) };
  copy.triggers = Object.fromEntries(Object.entries(copy.triggers ?? {}).map(([id, trigger]) => [id, { ...(trigger ?? {}), ...(trigger?.type === "hotkey" ? { global: Boolean(trigger.global) } : {}) }]));
  // Issue #91: `eventTriggers` (StreamEvent condition-based triggers) is a separate section from
  // the existing `triggers` above (keyword/hotkey/interval/random/manual) — additive, not a
  // replacement. Each entry only gets `enabled`/`priority`/`stopPropagation` defaults filled in;
  // `condition`/`eventTypes` are left as-authored (see src/triggers/event-trigger-schema.js's own
  // createEventTriggerConfig() for the same defaults applied when building a fresh one in code).
  copy.eventTriggers = Object.fromEntries(Object.entries(copy.eventTriggers ?? {}).map(([id, trigger]) => [id, { enabled: true, priority: 0, stopPropagation: false, ...(trigger ?? {}) }]));
  copy.personas = (copy.personas ?? []).map((persona) => ({ enabled: true, triggers: [], ...persona, voice: { enabled: true, engine: "webspeech", name: "default", rate: 1, pitch: 1, ...(persona.voice ?? {}) } }));
  return copy;
}
