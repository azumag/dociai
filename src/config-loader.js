// 設定の読み込みと検証 (issue #2)
// config.local.json をサーバー経由fetchまたはファイル選択で読み込む。
// 読み込んだ設定 (APIキー含む) はメモリ保持のみ。永続ストレージには書かない。

const KNOWN_PROVIDERS = ["openai", "openrouter", "openai-compatible", "mock"];
const KNOWN_TRIGGER_TYPES = ["keyword", "hotkey", "interval", "random", "manual"];
const KNOWN_NEWS_SOURCE_TYPES = ["rss", "mock"];
const KNOWN_NEWS_MODES = ["topic", "current", "simple"];

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
        if (!c.apiKey && c.provider !== "openai-compatible") {
          warnings.push(`connectors.${id} にapiKeyがありません。呼び出し時に認証エラーになる可能性があります`);
        }
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
        else if (!KNOWN_NEWS_SOURCE_TYPES.includes(src.type)) {
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

  // context
  if (cfg.context?.screenCapture?.enabled && cfg.context.screenCapture.connector) {
    if (!cfg.connectors?.[cfg.context.screenCapture.connector]) {
      errors.push(`context.screenCapture.connector "${cfg.context.screenCapture.connector}" が connectors に存在しません`);
    }
  }

  return { errors, warnings };
}

export function applyDefaults(cfg) {
  const personas = cfg.personas.map((p) => ({
    enabled: true,
    triggers: [],
    ...p,
    voice: { enabled: true, name: "default", rate: 1.0, pitch: 1.0, ...(p.voice ?? {}) },
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
        ...(cfg.context?.screenCapture ?? {}),
      },
    },
    news: cfg.news ? { maxItems: 3, mode: "topic", dedupe: true, ...cfg.news } : { enabled: false, mode: "topic", dedupe: true },
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
