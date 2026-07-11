export const HEALTH_ACTIONS = Object.freeze(["retry", "reauth", "open_settings", "open_manager", "start_service", "open_diagnostics"]);
const ACTION_BY_ERROR = Object.freeze({ AUTH: "reauth", AUTH_REQUIRED: "reauth", CONFIG: "open_settings", CONFIGURATION_REQUIRED: "open_settings", UNAVAILABLE: "start_service", NETWORK: "retry", TIMEOUT: "retry", SERVER: "retry", RATE_LIMIT: "retry" });

export function resolveHealthAction({ code = "UNKNOWN", category = "" } = {}) {
  const action = ACTION_BY_ERROR[String(code).toUpperCase()] ?? (String(category).toLowerCase() === "model" ? "open_manager" : "open_diagnostics");
  return HEALTH_ACTIONS.includes(action) ? action : "open_diagnostics";
}

export function isKnownHealthAction(action) { return HEALTH_ACTIONS.includes(action); }
