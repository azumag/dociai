// APIキーの取り扱いガード (issue #13)
// - キーは常にメモリ保持のみ。localStorage/sessionStorageへは書かない。
// - 表示・ログに出す前に必ず maskApiKey / scrubSecrets を通す。

export function maskApiKey(key) {
  if (!key) return "(未設定)";
  const s = String(key);
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-2)}`;
}

// 設定オブジェクトの表示用コピーを作る。apiKey系のフィールドをマスクする。
export function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /apikey|api_key|token|secret/i.test(k) ? maskApiKey(v) : redactConfig(v);
    }
    return out;
  }
  return value;
}

// ログ文字列に生のキーが紛れ込んでいたらマスクに置き換える。
export function scrubSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets ?? []) {
    if (typeof s === "string" && s.length >= 8) {
      out = out.split(s).join(maskApiKey(s));
    }
  }
  return out;
}

export function collectApiKeys(config) {
  const keys = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (/apikey|api_key|token|secret/i.test(k) && typeof v === "string") keys.push(v);
        else walk(v);
      }
    }
  };
  walk(config);
  return keys;
}

// 永続ストレージにAPIキーが残っていないかを実際に走査する (issue #13 受け入れ条件の実証用)。
export function checkSecretStorage(config) {
  const keys = collectApiKeys(config).filter((k) => k && k.length >= 8);
  const hits = [];
  for (const [name, store] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]]) {
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        const value = store.getItem(key) ?? "";
        if (keys.some((k) => value.includes(k) || key.includes(k))) hits.push(`${name}:${key}`);
      }
    } catch {
      // ストレージ無効環境 (プライベートモード等) は残留リスクなしとして扱う
    }
  }
  return { ok: hits.length === 0, hits };
}
