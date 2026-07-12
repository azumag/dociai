import { CURRENT_SCHEMA_VERSION } from "./config-contract.js";
export const CURRENT_CONFIG_SCHEMA = Object.freeze({
  version: CURRENT_SCHEMA_VERSION,
  required: Object.freeze(["connectors", "personas", "triggers"]),
  sections: Object.freeze(["schemaVersion", "connectors", "personas", "triggers", "eventTriggers", "router", "context", "voicevox", "bouyomi", "speechQueue", "micMonitor", "commentReader", "commentSources", "news", "topics", "twitch"]),
  unknownFieldPolicy: "warning",
  securitySensitiveUnknownPattern: /(?:secret|token|password|api[-_]?key)/i,
});
