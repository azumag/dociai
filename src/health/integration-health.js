export const HEALTH_STATUSES = Object.freeze([
  "disabled",
  "unknown",
  "checking",
  "ready",
  "degraded",
  "reconnecting",
  "auth_required",
  "configuration_required",
  "error",
]);

export const HEALTH_SEVERITY = Object.freeze({
  disabled: 0,
  unknown: 0,
  checking: 0,
  ready: 0,
  reconnecting: 1,
  degraded: 1,
  configuration_required: 1,
  auth_required: 2,
  error: 2,
});

export function healthEntry({ serviceId, status = "unknown", generation = 0, critical = false, at = Date.now(), error = null, action = null, metrics = {} } = {}) {
  if (!serviceId || typeof serviceId !== "string" || !HEALTH_STATUSES.includes(status) || !Number.isSafeInteger(generation) || generation < 0 || !Number.isFinite(at)) {
    throw new TypeError("invalid integration health event");
  }
  return Object.freeze({
    serviceId,
    status,
    severity: HEALTH_SEVERITY[status],
    generation,
    critical: Boolean(critical),
    at,
    error,
    action,
    metrics: Object.freeze({ ...metrics }),
  });
}

export function createHealthSnapshot({ generation = 0, services = {}, overall = "unknown", updatedAt = 0 } = {}) {
  return Object.freeze({
    generation,
    services: Object.freeze({ ...services }),
    overall,
    updatedAt,
  });
}
