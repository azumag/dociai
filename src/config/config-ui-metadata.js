import { registryOptions } from "./config-registry.js";
export const CONFIG_UI_METADATA = Object.freeze({
  "connectors.*.provider": Object.freeze({ label: "Provider", options: registryOptions("providers") }),
  "triggers.*.type": Object.freeze({ label: "Trigger type", options: registryOptions("triggerTypes") }),
  "personas.*.voice.engine": Object.freeze({ label: "Voice engine", options: registryOptions("voiceEngines") }),
  "speechQueue.maxPending": Object.freeze({ label: "最大待機数", min: 1, max: 1000, default: 50, advanced: true }),
  "connectors.*.apiKey": Object.freeze({ label: "API key", secret: true }),
  "topics.sources.*.token": Object.freeze({ label: "Token", secret: true }),
});
