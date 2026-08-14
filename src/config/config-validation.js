import { CURRENT_SCHEMA_VERSION, failureResult, issue, successResult } from "./config-contract.js";
import { CONFIG_REGISTRY, registryIds } from "./config-registry.js";
import { CURRENT_CONFIG_SCHEMA } from "./config-schema.js";
// Issue #91's "config migration/validationを#64へ登録": src/triggers/* (StreamEvent condition
// triggers) owns its own field/operator/type registry and is validated by its own module, not
// re-implemented here — this file only registers the hook (below) into this shared
// validateConfigStructure() pipeline, the same way every other section's own validation rule
// lives inline just below.
import { validateEventTriggersConfig } from "../triggers/trigger-validation.js";
import { isMiniMaxSearchConnector } from "./minimax-search-config.js";

// C0/C1制御文字 (タブ・改行・復帰を除く)。electron/main/services/captions/caption-policy.ts の
// CONTROL_CHARACTERS と同じ範囲 — あちらは送出直前の最後の砦、こちらは保存時に運用者へ知らせる。
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

export function validateConfigStructure(config) {
  const issues = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return failureResult("structural-validation", [issue([], "type.object", "config root must be an object")], config);
  if (config.schemaVersion !== CURRENT_SCHEMA_VERSION) issues.push(issue(["schemaVersion"], "version.current", `schemaVersion must be ${CURRENT_SCHEMA_VERSION}`));
  for (const key of CURRENT_CONFIG_SCHEMA.required) if (config[key] == null) issues.push(issue([key], "required", `${key} is required`));
  for (const key of Object.keys(config)) if (!CURRENT_CONFIG_SCHEMA.sections.includes(key)) issues.push(issue([key], CURRENT_CONFIG_SCHEMA.securitySensitiveUnknownPattern.test(key) ? "unknown.security-sensitive" : "unknown", `Unknown config field: ${key}`, { severity: CURRENT_CONFIG_SCHEMA.securitySensitiveUnknownPattern.test(key) ? "error" : "warning" }));
  for (const [id, connector] of Object.entries(config.connectors ?? {})) if (!registryIds("providers").includes(connector?.provider)) issues.push(issue(["connectors", id, "provider"], "enum", "Unsupported provider", { meta: { options: registryIds("providers") } }));
  for (const [id, trigger] of Object.entries(config.triggers ?? {})) if (!registryIds("triggerTypes").includes(trigger?.type)) issues.push(issue(["triggers", id, "type"], "enum", "Unsupported trigger type"));
  for (const [index, persona] of (config.personas ?? []).entries()) if (persona?.voice?.engine && !registryIds("voiceEngines").includes(persona.voice.engine)) issues.push(issue(["personas", index, "voice", "engine"], "enum", "Unsupported voice engine"));
  if (config.research?.enabled === true) {
    const connectorId = typeof config.research.connector === "string" ? config.research.connector.trim() : "";
    const connector = connectorId ? config.connectors?.[connectorId] : null;
    if (!connector) issues.push(issue(["research", "connector"], "reference", "Web調査connectorを選択してください"));
    else if (!isMiniMaxSearchConnector(connector)) issues.push(issue(["research", "connector"], "capability", "Web調査には公式MiniMax API connectorを選択してください"));
    const maxResults = Number(config.research.maxResults);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) issues.push(issue(["research", "maxResults"], "range", "maxResults must be an integer from 1 to 10"));
  }
  // commentReader.enabledもゲートに含める — settings-ui.js側は`cr.enabled`がfalseの間
  // 翻訳カード自体を描画しない (#renderCommentReader()) ため、それと揃えないと
  // 「commentReaderを無効化しただけなのに、画面から見えなくなった翻訳フィールドの
  // validationエラーで保存がブロックされ続ける」という直しようのない詰み状態になる
  // (PRレビュー指摘)。
  if (config.commentReader?.enabled === true && config.commentReader?.translation?.enabled === true) {
    const t = config.commentReader.translation;
    const sourceLanguages = Array.isArray(t.sourceLanguages) ? t.sourceLanguages : [];
    if (!sourceLanguages.length || sourceLanguages.some((lang) => !registryIds("translationSourceLanguages").includes(lang))) {
      issues.push(issue(["commentReader", "translation", "sourceLanguages"], "enum", "翻訳元言語を選択してください", { meta: { options: registryIds("translationSourceLanguages") } }));
    }
    if (t.targetLanguage !== "ja") issues.push(issue(["commentReader", "translation", "targetLanguage"], "enum", "翻訳先言語はjaのみ対応しています"));
    if (!registryIds("translationOutputModes").includes(t.outputMode)) issues.push(issue(["commentReader", "translation", "outputMode"], "enum", "Unsupported outputMode", { meta: { options: registryIds("translationOutputModes") } }));
    if (!registryIds("translationFailurePolicies").includes(t.onFailure)) issues.push(issue(["commentReader", "translation", "onFailure"], "enum", "Unsupported onFailure policy", { meta: { options: registryIds("translationFailurePolicies") } }));
    const minimumConfidence = Number(t.minimumConfidence);
    if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) issues.push(issue(["commentReader", "translation", "minimumConfidence"], "range", "minimumConfidence must be between 0 and 1"));
    const timeoutMs = Number(t.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) issues.push(issue(["commentReader", "translation", "timeoutMs"], "range", "timeoutMs must be an integer from 500 to 30000"));
    const maxInputChars = Number(t.maxInputChars);
    if (!Number.isInteger(maxInputChars) || maxInputChars < 1 || maxInputChars > 1000) issues.push(issue(["commentReader", "translation", "maxInputChars"], "range", "maxInputChars must be an integer from 1 to 1000"));
    const maxPendingComments = Number(t.maxPendingComments);
    if (!Number.isInteger(maxPendingComments) || maxPendingComments < 1 || maxPendingComments > 200) issues.push(issue(["commentReader", "translation", "maxPendingComments"], "range", "maxPendingComments must be an integer from 1 to 200"));
  }
  // issue #282 (英語CC)。OBS WebSocketパスワードだけはenabledに関係なく常に拒否する —
  // 設定JSONへ直接書かれた場合、そのままconfig exportやディスクへ平文で残ってしまうため
  // (secret storeへ入れる正規の経路は設定UIのパスワード欄)。
  if (config.captions?.obs && typeof config.captions.obs === "object" && "password" in config.captions.obs) {
    issues.push(issue(["captions", "obs", "password"], "unknown.security-sensitive", "OBSパスワードは設定ファイルではなく設定画面のパスワード欄へ保存してください", { severity: "error" }));
  }
  if (config.captions?.enabled === true) {
    const captions = config.captions;
    if (captions.sourceLanguage !== "ja-JP") issues.push(issue(["captions", "sourceLanguage"], "enum", "音声認識言語はja-JPのみ対応しています"));
    if (captions.targetLanguage !== "en") issues.push(issue(["captions", "targetLanguage"], "enum", "字幕言語はenのみ対応しています"));
    if (!registryIds("captionRecognitionEngines").includes(captions.recognitionEngine)) issues.push(issue(["captions", "recognitionEngine"], "enum", "Unsupported recognitionEngine", { meta: { options: registryIds("captionRecognitionEngines") } }));
    if (!registryIds("captionTranslationEngines").includes(captions.translationEngine)) issues.push(issue(["captions", "translationEngine"], "enum", "Unsupported translationEngine", { meta: { options: registryIds("captionTranslationEngines") } }));
    const range = (value, path, min, max, message) => {
      const numeric = Number(value);
      if (!Number.isInteger(numeric) || numeric < min || numeric > max) issues.push(issue(["captions", ...path], "range", message));
    };
    // 0 = ephemeral portなので下限は0。1〜1023はOS側で特権が必要になるため除外する。
    const workerPort = Number(captions.workerPort);
    if (!Number.isInteger(workerPort) || workerPort < 0 || workerPort > 65535 || (workerPort > 0 && workerPort < 1024)) {
      issues.push(issue(["captions", "workerPort"], "range", "workerPortは0 (自動) もしくは1024〜65535で指定してください"));
    }
    range(config.captions.obs?.port, ["obs", "port"], 1, 65535, "OBS WebSocketのポートは1〜65535で指定してください");
    range(captions.maxPending, ["maxPending"], 1, 20, "maxPendingは1〜20で指定してください");
    range(captions.maxAgeMs, ["maxAgeMs"], 500, 60000, "maxAgeMsは500〜60000で指定してください");
    // 0 = 分割しない。実表示可能な上限はissue #282 Phase 0の実機検証で確定する。
    range(captions.maxCaptionChars, ["maxCaptionChars"], 0, 500, "maxCaptionCharsは0 (分割しない) 〜500で指定してください");
    const host = typeof config.captions.obs?.host === "string" ? config.captions.obs.host.trim() : "";
    if (!host) issues.push(issue(["captions", "obs", "host"], "required", "OBS WebSocketのホストを指定してください"));
    const replacements = config.captions.replacements;
    if (replacements !== undefined && (!replacements || typeof replacements !== "object" || Array.isArray(replacements))) {
      issues.push(issue(["captions", "replacements"], "type.object", "replacementsはobjectで指定してください"));
    } else if (replacements && Object.entries(replacements).some(([from, to]) => typeof from !== "string" || !from || typeof to !== "string")) {
      issues.push(issue(["captions", "replacements"], "type.object", "replacementsは文字列のキーと値で指定してください"));
    } else if (replacements && Object.entries(replacements).some(([from, to]) => CONTROL_CHARACTERS.test(from) || CONTROL_CHARACTERS.test(to))) {
      // 置換は字幕本文の検査より後に適用されるため、ここで弾かないと設定経由で制御文字を
      // 字幕へ注入できてしまう (Main側の caption-policy.ts も置換後に再検査して二重に防ぐ)。
      issues.push(issue(["captions", "replacements"], "type.string", "replacementsに制御文字は指定できません"));
    }
  }
  const eventTriggersResult = validateEventTriggersConfig(config.eventTriggers);
  for (const entry of eventTriggersResult.issues) issues.push(issue(entry.path, entry.code, entry.message, { severity: entry.severity, meta: entry.meta }));
  const errors = issues.filter((entry) => entry.severity === "error");
  return errors.length ? failureResult("structural-validation", issues, config) : successResult(config, issues);
}
export { CONFIG_REGISTRY };
