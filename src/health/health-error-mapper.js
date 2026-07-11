import { resolveHealthAction } from "./health-action-registry.js";

const STATUS_BY_CODE = Object.freeze({ AUTH: "auth_required", AUTH_REQUIRED: "auth_required", CONFIG: "configuration_required", CONFIGURATION_REQUIRED: "configuration_required", NETWORK: "degraded", TIMEOUT: "degraded", RATE_LIMIT: "degraded", SERVER: "error", UNAVAILABLE: "error", CANCELLED: "unknown" });

export function mapHealthError(error = {}, context = {}) {
  const code = String(error.code ?? error.kind ?? "UNKNOWN").toUpperCase();
  const status = STATUS_BY_CODE[code] ?? "error";
  const action = resolveHealthAction({ code, category: context.category });
  return { status, action, code, severity: status === "error" || status === "auth_required" ? 2 : 1, error: { code, message: String(error.message ?? error) } };
}
