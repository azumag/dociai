// connectors.*.apiKey / topics.sources[].token / news.sources[].token (legacyのTodoistエントリが
// v1→v2移行前でtopicsへまだ移されていない場合) をconfigから分離する。
// electron/main/index.ts の旧 moveConnectorSecrets() をそのまま移設したもの (Browser/Renderer/Main
// の全ランタイムから同一ロジックで呼べるようにするため)。Node/Electron依存のない純粋なJSON変換。
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
// electron/main/secrets/secret-keys.ts の parseSecretKey と同じ制約 (文字種+128文字上限) を、
// connector idではなく実際にMainへ渡す完全なkey文字列に対して検証する。idだけを検証すると、
// 十分長いidが `connectors.<id>.apiKey` として組み立てられたときに128文字上限を超えて
// Main側のparseSecretKeyだけが弾く (=ローカルではinvalidIdsに乗らず保存"成功"したのに秘密鍵だけ
// 保存に失敗する) というズレが起きるため。
const SECRET_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function splitSourceTokens(publicConfig, sectionName, secretEntries) {
  const section = object(publicConfig[sectionName]);
  const sources = Array.isArray(section.sources) ? section.sources : [];
  section.sources = sources.map((value, index) => {
    const source = object(value);
    if (typeof source.token === "string" && source.token.trim()) {
      const key = `${sectionName}.sources.${index}.token`;
      secretEntries.push({ key, value: source.token.trim() });
      delete source.token;
      source.tokenConfigured = true;
      source.tokenSecretRef = key;
    }
    return source;
  });
  if (sectionName in publicConfig) publicConfig[sectionName] = section;
}

export function splitConnectorSecrets(config) {
  const publicConfig = structuredClone(config);
  const connectors = object(publicConfig.connectors);
  const secretEntries = [];
  const invalidIds = [];
  for (const [id, value] of Object.entries(connectors)) {
    const connector = object(value);
    if (typeof connector.apiKey === "string" && connector.apiKey.trim()) {
      const key = `connectors.${id}.apiKey`;
      if (!SECRET_KEY_PATTERN.test(key)) invalidIds.push({ path: `connectors.${id}`, reason: "invalid-secret-key-id" });
      secretEntries.push({ key, value: connector.apiKey.trim() });
      delete connector.apiKey;
      connector.apiKeyConfigured = true;
      connector.apiKeySecretRef = key;
    }
    connectors[id] = connector;
  }
  publicConfig.connectors = connectors;
  splitSourceTokens(publicConfig, "topics", secretEntries);
  splitSourceTokens(publicConfig, "news", secretEntries);
  return { publicConfig, secretEntries, invalidIds };
}
