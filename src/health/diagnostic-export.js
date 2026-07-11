const MAX_SERVICES = 32;
const MAX_TIMELINE = 12;
const MAX_METRICS = 16;
const MAX_TEXT = 160;
const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|api[-_]?key|cookie|header|prompt|user|text|payload|raw|path|file|directory|home|credential)/i;
const SAFE_METRIC_KEYS = new Set([
  "attempts", "durationMs", "httpStatus", "latencyMs", "queueDepth", "retryAt", "retryCount", "uptimeMs",
]);

function safeText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) return fallback;
  return normalized.slice(0, MAX_TEXT);
}

function safeTimestamp(value, fallback = null) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function safeMetricValue(key, value) {
  if (SENSITIVE_KEY.test(key) || !SAFE_METRIC_KEYS.has(key)) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return undefined;
}

function sanitizeMetrics(metrics) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return {};
  const output = {};
  for (const [key, value] of Object.entries(metrics).slice(0, MAX_METRICS)) {
    const safe = safeMetricValue(key, value);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

function sanitizeTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  return timeline.slice(-MAX_TIMELINE).map((entry) => {
    const item = {
      at: safeTimestamp(entry?.at),
      status: safeText(entry?.status, "unknown"),
      errorCode: safeText(entry?.errorCode ?? entry?.error?.code, "") || undefined,
      latencyMs: Number.isFinite(entry?.latencyMs) ? entry.latencyMs : undefined,
    };
    return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null && value !== undefined && value !== ""));
  });
}

function serviceRecord(service) {
  const errorCode = safeText(service?.errorCode ?? service?.error?.code, "");
  const record = {
    serviceId: safeText(service?.serviceId ?? service?.id, "unknown"),
    category: safeText(service?.category, "integration"),
    status: safeText(service?.status, "unknown"),
    enabled: service?.enabled !== false,
    critical: Boolean(service?.critical),
    at: safeTimestamp(service?.at),
    lastSuccessAt: safeTimestamp(service?.lastSuccessAt),
    retryAt: safeTimestamp(service?.retryAt ?? service?.nextRetryAt),
    metrics: sanitizeMetrics(service?.metrics),
    timeline: sanitizeTimeline(service?.timeline),
  };
  if (errorCode) record.errorCode = errorCode;
  if (service?.diagnosticId) record.diagnosticId = safeText(service.diagnosticId);
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}

function serviceArray(services) {
  if (Array.isArray(services)) return services;
  if (services && typeof services === "object") return Object.values(services);
  return [];
}

export function createDiagnosticExport({ app = "dociai", build = "unknown", generatedAt = Date.now(), services = [] } = {}) {
  const timestamp = safeTimestamp(generatedAt, new Date().toISOString()) ?? new Date().toISOString();
  return Object.freeze({
    schema: "dociai.integration-diagnostic.v1",
    app: safeText(app, "dociai"),
    build: safeText(build, "unknown"),
    timestamp,
    services: serviceArray(services).slice(0, MAX_SERVICES).map(serviceRecord),
  });
}

export function serializeDiagnosticExport(payload) {
  return JSON.stringify(payload, null, 2);
}

export function downloadDiagnosticExport(payload, { document = globalThis.document, filename = "dociai-integration-diagnostic.json" } = {}) {
  if (!document?.createElement) return false;
  const blob = new Blob([serializeDiagnosticExport(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export const DIAGNOSTIC_LIMITS = Object.freeze({ MAX_SERVICES, MAX_TIMELINE, MAX_METRICS, MAX_TEXT });
