import { registryOptions } from "./config-registry.js";
export const CONFIG_UI_METADATA = Object.freeze({
  "connectors.*.provider": Object.freeze({ label: "Provider", options: registryOptions("providers") }),
  "triggers.*.type": Object.freeze({ label: "Trigger type", options: registryOptions("triggerTypes") }),
  "personas.*.voice.engine": Object.freeze({ label: "Voice engine", options: registryOptions("voiceEngines") }),
  "speechQueue.maxPending": Object.freeze({ label: "最大待機数", min: 1, max: 1000, default: 50, advanced: true }),
  "router.historyTtlSeconds": Object.freeze({ label: "応答履歴TTL秒", min: 60, max: 86400, default: 7200, advanced: true }),
  "router.historyMaxEntries": Object.freeze({ label: "応答履歴最大件数", min: 100, max: 100000, default: 2000, advanced: true }),
  "connectors.*.apiKey": Object.freeze({ label: "API key", secret: true }),
  "connectors.*.maxTokens": Object.freeze({ label: "maxTokens", min: 1, max: 32768, default: 2048, advanced: true }),
  "research.maxResults": Object.freeze({ label: "最大検索結果数", min: 1, max: 10, default: 5 }),
  "topics.sources.*.token": Object.freeze({ label: "Token", secret: true }),
  "commentReader.translation.minimumConfidence": Object.freeze({ label: "言語判定の信頼度", min: 0, max: 1, default: 0.7 }),
  "commentReader.translation.timeoutMs": Object.freeze({ label: "翻訳timeout(ms)", min: 500, max: 15000, default: 3000, advanced: true }),
  "commentReader.translation.maxInputChars": Object.freeze({ label: "翻訳する最大文字数", min: 1, max: 1000, default: 500, advanced: true }),
  "commentReader.translation.maxPendingComments": Object.freeze({ label: "翻訳待ちコメントの上限", min: 1, max: 200, default: 20, advanced: true }),
});
