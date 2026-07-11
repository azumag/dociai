import { CURRENT_SCHEMA_VERSION, failureResult, issue, successResult } from "./config-contract.js";
import { CONFIG_REGISTRY, registryIds } from "./config-registry.js";
import { CURRENT_CONFIG_SCHEMA } from "./config-schema.js";

export function validateConfigStructure(config) {
  const issues = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return failureResult("structural-validation", [issue([], "type.object", "config root must be an object")], config);
  if (config.schemaVersion !== CURRENT_SCHEMA_VERSION) issues.push(issue(["schemaVersion"], "version.current", `schemaVersion must be ${CURRENT_SCHEMA_VERSION}`));
  for (const key of CURRENT_CONFIG_SCHEMA.required) if (config[key] == null) issues.push(issue([key], "required", `${key} is required`));
  for (const key of Object.keys(config)) if (!CURRENT_CONFIG_SCHEMA.sections.includes(key)) issues.push(issue([key], CURRENT_CONFIG_SCHEMA.securitySensitiveUnknownPattern.test(key) ? "unknown.security-sensitive" : "unknown", `Unknown config field: ${key}`, { severity: CURRENT_CONFIG_SCHEMA.securitySensitiveUnknownPattern.test(key) ? "error" : "warning" }));
  for (const [id, connector] of Object.entries(config.connectors ?? {})) if (!registryIds("providers").includes(connector?.provider)) issues.push(issue(["connectors", id, "provider"], "enum", "Unsupported provider", { meta: { options: registryIds("providers") } }));
  for (const [id, trigger] of Object.entries(config.triggers ?? {})) if (!registryIds("triggerTypes").includes(trigger?.type)) issues.push(issue(["triggers", id, "type"], "enum", "Unsupported trigger type"));
  for (const [index, persona] of (config.personas ?? []).entries()) if (persona?.voice?.engine && !registryIds("voiceEngines").includes(persona.voice.engine)) issues.push(issue(["personas", index, "voice", "engine"], "enum", "Unsupported voice engine"));
  const errors = issues.filter((entry) => entry.severity === "error");
  return errors.length ? failureResult("structural-validation", issues, config) : successResult(config, issues);
}
export { CONFIG_REGISTRY };
