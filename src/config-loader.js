// 設定の読み込みと検証 (issue #2)
// config.local.json をサーバー経由fetchまたはファイル選択で読み込む。
// 読み込んだ設定 (APIキー含む) はメモリ保持のみ。永続ストレージには書かない。

const KNOWN_PROVIDERS = ["openai", "openrouter", "openai-compatible", "ollama", "minimax", "mock"];
const KNOWN_TRIGGER_TYPES = ["keyword", "hotkey", "interval", "random", "manual"];
const KNOWN_NEWS_SOURCE_TYPES = ["rss", "mock"];
const KNOWN_TOPIC_SOURCE_TYPES = ["todoist"];
const KNOWN_NEWS_MODES = ["topic", "current", "simple"];
const DEFAULT_TOPIC_INTRO = "上のお題について、あなたのキャラクターとして自由にコメントしてください。";
const DEFAULT_TOPIC_STYLE = "雑談のお題として、自然な自分の言葉で自由にコメントする";

function splitNewsAndLegacyTopics(cfg) {
  const sources = Array.isArray(cfg.news?.sources) ? cfg.news.sources : [];
  return {
    newsSources: sources.filter((src) => src?.type !== "todoist"),
    legacyTopicSources: sources.filter((src) => src?.type === "todoist"),
  };
}

export function validateConfig(cfg) {
  const errors = [];
  const warnings = [];

  if (!cfg || typeof cfg !== "object") {
    return { errors: ["設定のルートがオブジェクトではありません"], warnings };
  }

  // connectors
  if (!cfg.connectors || typeof cfg.connectors !== "object" || !Object.keys(cfg.connectors).length) {
    errors.push("connectors が空です。最低1つのコネクタを定義してください");
  } else {
    for (const [id, c] of Object.entries(cfg.connectors)) {
      if (!c || typeof c !== "object") { errors.push(`connectors.${id} がオブジェクトではありません`); continue; }
      if (!c.provider) errors.push(`connectors.${id}.provider がありません`);
      else if (!KNOWN_PROVIDERS.includes(c.provider)) {
        errors.push(`connectors.${id}.provider "${c.provider}" は未対応です (対応: ${KNOWN_PROVIDERS.join(", ")})`);
      }
      if (c.provider && c.provider !== "mock") {
        if (!c.model) errors.push(`connectors.${id}.model がありません`);
        if (!c.apiKey && !["openai-compatible", "ollama"].includes(c.provider)) {
          warnings.push(`connectors.${id} にapiKeyがありません。呼び出し時に認証エラーになる可能性があります`);
        }
      }
      if (c.timeoutMs != null && Number(c.timeoutMs) > 0 && Number(c.timeoutMs) < 1000) {
        warnings.push(`connectors.${id}.timeoutMs は${c.timeoutMs}(ミリ秒)です。秒のつもりの値だと即座にタイムアウトします (例: 30秒 → 30000)`);
      }
      if (c.retries != null && !(Number(c.retries) >= 0)) {
        errors.push(`connectors.${id}.retries は0以上の数値にしてください`);
      }
    }
  }

  // personas
  if (!Array.isArray(cfg.personas) || !cfg.personas.length) {
    errors.push("personas が空です。最低1つのペルソナを定義してください");
  } else {
    const seen = new Set();
    cfg.personas.forEach((p, i) => {
      const label = p?.id ? `personas[${p.id}]` : `personas[${i}]`;
      if (!p?.id) errors.push(`personas[${i}].id がありません`);
      else if (seen.has(p.id)) errors.push(`ペルソナID "${p.id}" が重複しています`);
      else seen.add(p.id);
      if (!p?.name) errors.push(`${label}.name がありません`);
      if (!p?.connector) errors.push(`${label}.connector がありません`);
      else if (cfg.connectors && !cfg.connectors[p.connector]) {
        errors.push(`${label}.connector "${p.connector}" が connectors に存在しません`);
      }
      if (!p?.systemPrompt) warnings.push(`${label}.systemPrompt がありません。共通ルールのみで動作します`);
    });
  }

  // triggers
  if (!cfg.triggers || typeof cfg.triggers !== "object") {
    errors.push("triggers がありません");
  } else {
    for (const [id, t] of Object.entries(cfg.triggers)) {
      if (!t?.type) { errors.push(`triggers.${id}.type がありません`); continue; }
      if (!KNOWN_TRIGGER_TYPES.includes(t.type)) {
        errors.push(`triggers.${id}.type "${t.type}" は未対応です (対応: ${KNOWN_TRIGGER_TYPES.join(", ")})`);
        continue;
      }
      if (t.type === "keyword" && (!Array.isArray(t.keywords) || !t.keywords.length)) {
        errors.push(`triggers.${id} (keyword) に keywords 配列がありません`);
      }
      if (t.type === "hotkey" && !t.keys) errors.push(`triggers.${id} (hotkey) に keys がありません`);
      if (t.type === "interval" && !(t.minutes > 0 || t.seconds > 0)) {
        errors.push(`triggers.${id} (interval) に minutes または seconds (正の数) が必要です`);
      }
      if (t.type === "random" && !(t.probability >= 0 && t.probability <= 1)) {
        errors.push(`triggers.${id} (random) の probability は0から1の数値にしてください`);
      }
    }
    // ペルソナが参照するトリガーの存在確認
    for (const p of cfg.personas ?? []) {
      for (const tid of p?.triggers ?? []) {
        if (tid !== "manual" && !cfg.triggers[tid]) {
          warnings.push(`personas[${p.id}].triggers の "${tid}" が triggers に存在しません`);
        }
      }
    }
  }

  // news
  if (cfg.news?.enabled) {
    if (!Array.isArray(cfg.news.sources) || !cfg.news.sources.length) {
      errors.push("news.enabled が true ですが news.sources が空です");
    } else {
      cfg.news.sources.forEach((src, i) => {
        const label = src?.name ? `news.sources[${src.name}]` : `news.sources[${i}]`;
        if (!src || typeof src !== "object") {
          errors.push(`news.sources[${i}] がオブジェクトではありません`);
          return;
        }
        if (!src.name) warnings.push(`${label}.name がありません。ログ表示用の名前を付けることを推奨します`);
        if (!src.type) errors.push(`${label}.type がありません`);
        else if (src.type === "todoist") {
          warnings.push(`${label}.type "todoist" は news から分離されました。topics.sources へ移してください`);
          if (!src.token) errors.push(`${label}.token がありません (Todoist の個人アクセストークン)`);
          if (!src.projectId) errors.push(`${label}.projectId がありません`);
        } else if (!KNOWN_NEWS_SOURCE_TYPES.includes(src.type)) {
          errors.push(`${label}.type "${src.type}" は未対応です (対応: ${KNOWN_NEWS_SOURCE_TYPES.join(", ")})`);
        }
        if (src.type === "rss" && !src.url) errors.push(`${label}.url がありません`);
      });
    }
    if (cfg.news.mode && !KNOWN_NEWS_MODES.includes(cfg.news.mode)) {
      errors.push(`news.mode "${cfg.news.mode}" は未対応です (対応: ${KNOWN_NEWS_MODES.join(", ")})`);
    }
    if (cfg.news.trigger && !cfg.triggers?.[cfg.news.trigger]) {
      warnings.push(`news.trigger "${cfg.news.trigger}" が triggers に存在しません`);
    }
    if (cfg.news.persona && !(cfg.personas ?? []).some((p) => p?.id === cfg.news.persona)) {
      errors.push(`news.persona "${cfg.news.persona}" が personas に存在しません`);
    }
  }

  // topics (Todoistなどの配信ネタ)
  if (cfg.topics?.enabled) {
    if (!Array.isArray(cfg.topics.sources) || !cfg.topics.sources.length) {
      const hasLegacyTodoist = (cfg.news?.sources ?? []).some((src) => src?.type === "todoist");
      if (!hasLegacyTodoist) errors.push("topics.enabled が true ですが topics.sources が空です");
    } else {
      cfg.topics.sources.forEach((src, i) => {
        const label = src?.name ? `topics.sources[${src.name}]` : `topics.sources[${i}]`;
        if (!src || typeof src !== "object") {
          errors.push(`topics.sources[${i}] がオブジェクトではありません`);
          return;
        }
        if (!src.name) warnings.push(`${label}.name がありません。ログ表示用の名前を付けることを推奨します`);
        if (!src.type) errors.push(`${label}.type がありません`);
        else if (!KNOWN_TOPIC_SOURCE_TYPES.includes(src.type)) {
          errors.push(`${label}.type "${src.type}" は未対応です (対応: ${KNOWN_TOPIC_SOURCE_TYPES.join(", ")})`);
        }
        if (src.type === "todoist") {
          if (!src.token) errors.push(`${label}.token がありません (Todoist の個人アクセストークン)`);
          if (!src.projectId) errors.push(`${label}.projectId がありません`);
        }
      });
    }
    if (cfg.topics.trigger && !cfg.triggers?.[cfg.topics.trigger]) {
      warnings.push(`topics.trigger "${cfg.topics.trigger}" が triggers に存在しません`);
    }
    if (cfg.topics.persona && !(cfg.personas ?? []).some((p) => p?.id === cfg.topics.persona)) {
      errors.push(`topics.persona "${cfg.topics.persona}" が personas に存在しません`);
    }
  }

  // comment sources
  if (cfg.commentSources?.twitch?.enabled) {
    const twitch = cfg.commentSources.twitch;
    const channels = twitch.channels ?? (twitch.channel ? [twitch.channel] : []);
    if (!Array.isArray(channels) || !channels.filter((c) => String(c ?? "").trim()).length) {
      errors.push("commentSources.twitch.enabled が true ですが channels が空です");
    }
  }

  // context
  if (cfg.context?.screenCapture?.enabled && cfg.context.screenCapture.connector) {
    if (!cfg.connectors?.[cfg.context.screenCapture.connector]) {
      errors.push(`context.screenCapture.connector "${cfg.context.screenCapture.connector}" が connectors に存在しません`);
    }
  }

  // voicevox (issue #17)
  if (cfg.voicevox?.enabled) {
    const v = cfg.voicevox;
    if (!v.baseUrl) errors.push("voicevox.enabled が true ですが voicevox.baseUrl がありません");
    if (v.defaultSpeaker == null || !Number.isFinite(Number(v.defaultSpeaker))) {
      errors.push("voicevox.defaultSpeaker は数値で指定してください (例: 3)");
    }
    if (v.maxChars != null && !(Number(v.maxChars) > 0)) {
      errors.push("voicevox.maxChars は正の数にしてください");
    }
    if (v.timeoutMs != null && Number(v.timeoutMs) > 0 && Number(v.timeoutMs) < 1000) {
      warnings.push(`voicevox.timeoutMs は${v.timeoutMs}(ミリ秒)です。秒のつもりの値だと即座にタイムアウトします (例: 30秒 → 30000)`);
    }
    if (v.retries != null && !(Number(v.retries) >= 0)) {
      errors.push("voicevox.retries は0以上の数値にしてください");
    }
  }

  // micMonitor (issue #32)
  if (cfg.micMonitor?.enabled) {
    const m = cfg.micMonitor;
    if (m.threshold != null && !(Number(m.threshold) > 0 && Number(m.threshold) <= 1)) {
      errors.push("micMonitor.threshold は0より大きく1以下の数値にしてください");
    }
    if (m.minSpeechMs != null && !(Number(m.minSpeechMs) >= 0)) {
      errors.push("micMonitor.minSpeechMs は0以上の数値にしてください");
    }
    if (m.silenceHoldMs != null && !(Number(m.silenceHoldMs) >= 0)) {
      errors.push("micMonitor.silenceHoldMs は0以上の数値にしてください");
    }
  }

  // commentReader (issue #31)
  if (cfg.commentReader?.enabled) {
    const cr = cfg.commentReader;
    if (cr.engine && !["webspeech", "voicevox"].includes(cr.engine)) {
      errors.push(`commentReader.engine "${cr.engine}" は未対応です (対応: webspeech, voicevox)`);
    }
    if (cr.engine === "voicevox" && !cfg.voicevox?.enabled) {
      warnings.push("commentReader.engine が voicevox ですが voicevox.enabled が true ではありません。Web Speech API にフォールバックします");
    }
    if (cr.ignoreUsers != null && !Array.isArray(cr.ignoreUsers)) {
      errors.push("commentReader.ignoreUsers は配列で指定してください");
    }
  }

  // personas.voice.engine (issue #17)
  for (const [i, p] of (cfg.personas ?? []).entries()) {
    const label = p?.id ? `personas[${p.id}]` : `personas[${i}]`;
    const engine = p?.voice?.engine;
    if (engine && !["webspeech", "voicevox"].includes(engine)) {
      errors.push(`${label}.voice.engine "${engine}" は未対応です (対応: webspeech, voicevox)`);
    }
    if (engine === "voicevox" && !cfg.voicevox?.enabled) {
      warnings.push(`${label}.voice.engine が voicevox ですが voicevox.enabled が true ではありません。Web Speech API にフォールバックします`);
    }
  }

  return { errors, warnings };
}

export function applyDefaults(cfg) {
  const { newsSources, legacyTopicSources } = splitNewsAndLegacyTopics(cfg);
  const { topicIntro, topicStyle, sources: _legacyNewsSources, ...newsRest } = cfg.news ?? {};
  const legacyTopicsEnabled = !!cfg.news?.enabled && legacyTopicSources.some((src) => src.enabled !== false);
  const explicitTopicSources = Array.isArray(cfg.topics?.sources) ? cfg.topics.sources : null;
  const legacyTopicDefaults = legacyTopicSources.length
    ? {
        enabled: legacyTopicsEnabled,
        trigger: cfg.news?.trigger ?? "",
        persona: cfg.news?.persona ?? "",
        maxItems: cfg.news?.maxItems ?? 3,
        intro: topicIntro ?? DEFAULT_TOPIC_INTRO,
        style: topicStyle ?? DEFAULT_TOPIC_STYLE,
      }
    : {};
  const personas = (cfg.personas ?? []).map((p) => ({
    enabled: true,
    triggers: [],
    ...p,
    voice: { enabled: true, engine: "webspeech", name: "default", rate: 1.0, pitch: 1.0, ...(p.voice ?? {}) },
  }));
  return {
    ...cfg,
    personas,
    router: {
      defaultPersona: personas[0]?.id,
      maxRepliesPerComment: 1,
      cooldownSeconds: 8,
      ...(cfg.router ?? {}),
    },
    context: {
      commentHistoryLimit: 80,
      includeRecentComments: 20,
      maxPromptChars: 4000,
      ...(cfg.context ?? {}),
      screenCapture: {
        enabled: false,
        maxAgeSeconds: 120,
        maxTokens: 768,
        ...(cfg.context?.screenCapture ?? {}),
      },
    },
    voicevox: {
      enabled: false,
      baseUrl: "http://127.0.0.1:50021",
      defaultSpeaker: 3,
      maxChars: 200,
      timeoutMs: 30000,
      retries: 1,
      ...(cfg.voicevox ?? {}),
    },
    micMonitor: {
      enabled: false,
      threshold: 0.05,
      minSpeechMs: 150,
      silenceHoldMs: 800,
      ...(cfg.micMonitor ?? {}),
    },
    commentReader: {
      enabled: false,
      engine: "webspeech",
      name: "default",
      rate: 1.0,
      pitch: 1.0,
      includeAuthor: true,
      skipEmotes: false,
      ignoreUsers: [],
      ...(cfg.commentReader ?? {}),
    },
    news: cfg.news
      ? {
          maxItems: 3,
          mode: "topic",
          dedupe: true,
          ...newsRest,
          enabled: newsSources.length ? !!cfg.news.enabled : false,
          sources: newsSources,
        }
      : {
          enabled: false,
          mode: "topic",
          dedupe: true,
          sources: [],
        },
    topics: {
      enabled: false,
      sources: [],
      maxItems: 3,
      dedupe: true,
      intro: DEFAULT_TOPIC_INTRO,
      style: DEFAULT_TOPIC_STYLE,
      ...legacyTopicDefaults,
      ...(cfg.topics ?? {}),
      sources: explicitTopicSources ?? legacyTopicSources,
    },
    commentSources: {
      ...(cfg.commentSources ?? {}),
      twitch: {
        enabled: false,
        ...(cfg.commentSources?.twitch ?? {}),
      },
    },
  };
}

function parseAndValidate(text, sourceLabel) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    const err = new Error(`JSONの構文エラー: ${e.message}`);
    err.validationErrors = [err.message];
    throw err;
  }
  const { errors, warnings } = validateConfig(cfg);
  if (errors.length) {
    const err = new Error(`設定エラー (${sourceLabel})`);
    err.validationErrors = errors;
    throw err;
  }
  return { config: applyDefaults(cfg), warnings, source: sourceLabel };
}

export async function loadFromServer() {
  let res;
  try {
    res = await fetch("./config.local.json", { cache: "no-store" });
  } catch (e) {
    throw new Error(`config.local.json の取得に失敗しました: ${e.message}`);
  }
  if (res.status === 404) {
    throw new Error("config.local.json が見つかりません。config.local.example.json をコピーして作成するか、ファイル選択で読み込んでください");
  }
  if (!res.ok) throw new Error(`config.local.json の取得に失敗しました (HTTP ${res.status})`);
  return parseAndValidate(await res.text(), "サーバー");
}

// 設定エディタ (issue #15) から呼ばれる。scripts/serve.py の PUT /config.local.json で
// ディスクへ書き込む。python3 -m http.server など保存に対応しないサーバーでは失敗するので、
// 呼び出し側でエラーを捕捉し、JSONエクスポートへの案内を行うこと。
export async function saveToServer(config) {
  let res;
  try {
    res = await fetch("./config.local.json", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config, null, 2),
    });
  } catch (e) {
    throw new Error(`config.local.json への保存に失敗しました: ${e.message}`);
  }
  if (!res.ok) {
    const detail = await res.json().then((j) => j?.error).catch(() => "");
    throw new Error(`config.local.json への保存に失敗しました (HTTP ${res.status}${detail ? `: ${detail}` : ""})。scripts/serve.py で起動しているか確認してください`);
  }
}

export function loadFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("ファイルの読み込みに失敗しました"));
    reader.onload = () => {
      try {
        resolve(parseAndValidate(String(reader.result), `ファイル: ${file.name}`));
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsText(file);
  });
}
