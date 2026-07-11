export const OBS_PROTOCOL_VERSION = 1;

const MAX_TEXT_LENGTH = 8_000;
const SECRET_KEY = /(?:api[-_]?key|token|secret|password|authorization|cookie)/i;
const COLOR = /^(?:#[0-9a-f]{6}|hsl\(\d{1,3}(?:\.\d+)?\s+\d{1,3}%\s+\d{1,3}%\))$/i;
const TYPES = new Set(["hello", "snapshot-request", "snapshot", "state", "heartbeat", "stopping"]);

function isObject(value) { return value != null && typeof value === "object" && !Array.isArray(value); }

function hasUnsafePayload(value, depth = 0) {
  if (depth > 5) return true;
  if (typeof value === "string") return value.length > MAX_TEXT_LENGTH;
  if (!isObject(value) && !Array.isArray(value)) return false;
  if (Array.isArray(value)) return value.length > 32 || value.some((entry) => hasUnsafePayload(entry, depth + 1));
  return Object.entries(value).some(([key, entry]) => SECRET_KEY.test(key) || hasUnsafePayload(entry, depth + 1));
}

export function createEnvelope(type, payload, { serverInstanceId, generation = 0, sequence = 0, targetClientId = null } = {}) {
  return Object.freeze({ protocolVersion: OBS_PROTOCOL_VERSION, type, serverInstanceId, generation, sequence, targetClientId, payload: Object.freeze({ ...payload }) });
}

export function validateEnvelope(envelope) {
  if (!isObject(envelope)) return { ok: false, reason: "envelope" };
  if (envelope.protocolVersion !== OBS_PROTOCOL_VERSION) return { ok: false, reason: "protocol-version" };
  if (!TYPES.has(envelope.type)) return { ok: false, reason: "type" };
  if (typeof envelope.serverInstanceId !== "string" || envelope.serverInstanceId.length < 1 || envelope.serverInstanceId.length > 128) return { ok: false, reason: "server-instance" };
  if (!Number.isSafeInteger(envelope.generation) || envelope.generation < 0) return { ok: false, reason: "generation" };
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0) return { ok: false, reason: "sequence" };
  if (!isObject(envelope.payload) || hasUnsafePayload(envelope.payload)) return { ok: false, reason: "payload" };
  if (envelope.payload.color != null && !COLOR.test(envelope.payload.color)) return { ok: false, reason: "color" };
  return { ok: true };
}

export function evaluateSequence(current, incoming) {
  if (!current?.serverInstanceId) return "initial";
  if (current.serverInstanceId !== incoming.serverInstanceId) return "server-changed";
  if (incoming.generation < current.generation) return "stale-generation";
  if (incoming.generation > current.generation) return "new-generation";
  if (incoming.sequence === current.sequence) return "duplicate";
  if (incoming.sequence < current.sequence) return "out-of-order";
  if (incoming.sequence > current.sequence + 1) return "gap";
  return "next";
}
