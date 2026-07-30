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
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15000) issues.push(issue(["commentReader", "translation", "timeoutMs"], "range", "timeoutMs must be an integer from 500 to 15000"));
    const maxInputChars = Number(t.maxInputChars);
    if (!Number.isInteger(maxInputChars) || maxInputChars < 1 || maxInputChars > 1000) issues.push(issue(["commentReader", "translation", "maxInputChars"], "range", "maxInputChars must be an integer from 1 to 1000"));
    const maxPendingComments = Number(t.maxPendingComments);
    if (!Number.isInteger(maxPendingComments) || maxPendingComments < 1 || maxPendingComments > 200) issues.push(issue(["commentReader", "translation", "maxPendingComments"], "range", "maxPendingComments must be an integer from 1 to 200"));
  }
  const eventTriggersResult = validateEventTriggersConfig(config.eventTriggers);
  for (const entry of eventTriggersResult.issues) issues.push(issue(entry.path, entry.code, entry.message, { severity: entry.severity, meta: entry.meta }));
  const errors = issues.filter((entry) => entry.severity === "error");
  return errors.length ? failureResult("structural-validation", issues, config) : successResult(config, issues);
}
export { CONFIG_REGISTRY };
