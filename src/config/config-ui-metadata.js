import { registryOptions } from "./config-registry.js";
export const CONFIG_UI_METADATA = Object.freeze({
  "connectors.*.provider": Object.freeze({ label: "Provider", options: registryOptions("providers") }),
  "triggers.*.type": Object.freeze({ label: "Trigger type", options: registryOptions("triggerTypes") }),
  "personas.*.voice.engine": Object.freeze({ label: "Voice engine", options: registryOptions("voiceEngines") }),
  "speechQueue.maxPending": Object.freeze({ label: "最大待機数", min: 1, max: 1000, default: 50, advanced: true }),
  "router.historyTtlSeconds": Object.freeze({ label: "応答履歴TTL秒", min: 60, max: 86400, default: 7200, advanced: true }),
  "router.historyMaxEntries": Object.freeze({ label: "応答履歴最大件数", min: 100, max: 100000, default: 2000, advanced: true }),
  "connectors.*.apiKey": Object.freeze({ label: "API key", secret: true }),
  "connectors.*.maxTokens": Object.freeze({ label: "maxTokens", min: 1, max: 32768, default: 300, advanced: true }),
  "topics.sources.*.token": Object.freeze({ label: "Token", secret: true }),
});
