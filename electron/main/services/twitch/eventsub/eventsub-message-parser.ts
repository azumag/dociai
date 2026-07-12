// Issue #86: pure parsing/validation for Twitch's EventSub WebSocket message envelope. No I/O, no
// timers, no class state — every function here is a plain `(input) -> result` so eventsub-
// session.ts can call it synchronously from inside a socket "message" handler without ever
// needing to catch an exception out of it (a malformed/oversize/unknown-shaped frame is a regular
// return value, never a throw — see the module's own JSON.parse try/catch below).
//
// Twitch's real envelope shape (per their documented EventSub WebSocket protocol):
//   { metadata: { message_id, message_type, message_timestamp, subscription_type?,
//                 subscription_version? },
//     payload: {...} }
// `message_type` is one of session_welcome | session_keepalive | notification |
// session_reconnect | revocation today — KNOWN_MESSAGE_TYPES below is deliberately NOT treated as
// exhaustive-forever: Twitch may add new types, so an unrecognized value is classified as `kind:
// "unknown"` (a normal, non-error outcome the caller can log and otherwise ignore) rather than
// `ok: false` (a protocol error worth closing the session over).

/** Twitch's real documented EventSub WebSocket message types. */
export type EventSubMessageType = "session_welcome" | "session_keepalive" | "notification" | "session_reconnect" | "revocation";

const KNOWN_MESSAGE_TYPES: ReadonlySet<string> = new Set<EventSubMessageType>(["session_welcome", "session_keepalive", "notification", "session_reconnect", "revocation"]);

export type EventSubMetadata = {
  messageId: string;
  messageType: string;
  messageTimestamp: string;
  subscriptionType?: string;
  subscriptionVersion?: string;
};

export type EventSubEnvelope = { metadata: EventSubMetadata; payload: unknown };

export type EventSubParseFailureReason = "malformed_json" | "invalid_envelope" | "oversize";

export type EventSubParseResult =
  | { ok: true; kind: "known"; messageType: EventSubMessageType; envelope: EventSubEnvelope }
  /** A structurally valid envelope whose `message_type` isn't one of today's known values —
   * "unknown type... を診断": the caller is expected to log/diagnose this and otherwise treat the
   * frame as a no-op liveness signal, never crash or close the session over it (Twitch may ship a
   * new message_type at any time and older clients must keep working). */
  | { ok: true; kind: "unknown"; messageType: string; envelope: EventSubEnvelope }
  | { ok: false; reason: EventSubParseFailureReason; message: string; sizeBytes?: number };

/** Twitch's real EventSub WebSocket frames are small (the largest documented notification
 * payloads are on the order of a few KB). 512 KiB is a generous multiple of that — plenty of
 * headroom for a legitimate frame this parser hasn't specifically modeled, while still bounding
 * memory against a misbehaving or malicious relay sitting in front of the socket. This is our own
 * defensive choice, not a number Twitch documents. */
export const DEFAULT_MAX_MESSAGE_BYTES = 512 * 1024;

export type ParseEventSubMessageOptions = { maxBytes?: number };

/** `JSON.parse` wrapped in try/catch (malformed JSON never throws out of this function), then a
 * runtime shape check for the envelope, then an oversize guard. Order matters: the byte-length
 * check runs BEFORE `JSON.parse` so a huge frame is rejected without ever paying to parse it. */
export function parseEventSubMessage(raw: string, options: ParseEventSubMessageOptions = {}): EventSubParseResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const sizeBytes = Buffer.byteLength(raw, "utf8");
  if (sizeBytes > maxBytes) return { ok: false, reason: "oversize", message: `EventSub message exceeds the ${maxBytes}-byte limit (${sizeBytes} bytes)`, sizeBytes };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: "malformed_json", message: error instanceof Error ? error.message : "invalid JSON" };
  }

  const envelope = extractEnvelope(parsed);
  if (!envelope) return { ok: false, reason: "invalid_envelope", message: "EventSub message is missing metadata.message_type" };

  if (KNOWN_MESSAGE_TYPES.has(envelope.metadata.messageType)) {
    return { ok: true, kind: "known", messageType: envelope.metadata.messageType as EventSubMessageType, envelope };
  }
  return { ok: true, kind: "unknown", messageType: envelope.metadata.messageType, envelope };
}

function extractEnvelope(value: unknown): EventSubEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const metadataRaw = record.metadata;
  if (!metadataRaw || typeof metadataRaw !== "object" || Array.isArray(metadataRaw)) return null;
  const metadataRecord = metadataRaw as Record<string, unknown>;
  const messageType = metadataRecord.message_type;
  if (typeof messageType !== "string" || !messageType) return null;
  const metadata: EventSubMetadata = {
    messageId: typeof metadataRecord.message_id === "string" ? metadataRecord.message_id : "",
    messageType,
    messageTimestamp: typeof metadataRecord.message_timestamp === "string" ? metadataRecord.message_timestamp : "",
    ...(typeof metadataRecord.subscription_type === "string" ? { subscriptionType: metadataRecord.subscription_type } : {}),
    ...(typeof metadataRecord.subscription_version === "string" ? { subscriptionVersion: metadataRecord.subscription_version } : {}),
  };
  return { metadata, payload: "payload" in record ? record.payload : undefined };
}

// -------------------------------------------------------------------------------------------
// Payload shape helpers for the message types eventsub-session.ts itself needs to act on. Full
// per-subscription-type event payload parsing is #87/#88's concern (subscription registry) — this
// file only ever reaches into the `session`/`subscription` envelopes common to every subscription.
// -------------------------------------------------------------------------------------------

export type EventSubWelcomeSession = { id: string; status?: string; keepaliveTimeoutSeconds: number; reconnectUrl: string | null };

/** `session_welcome`'s payload is `{ session: { id, status, connected_at,
 * keepalive_timeout_seconds, reconnect_url, ... } }` — the two fields eventsub-session.ts actually
 * needs to keep watching a session ("session ID、keepalive timeout... を保持") are `id` and
 * `keepalive_timeout_seconds`; both are required and type-checked here so a malformed welcome
 * payload is caught as a protocol error at the call site rather than silently producing a
 * watchdog with a NaN/undefined deadline. */
export function parseWelcomeSession(payload: unknown): EventSubWelcomeSession | null {
  const session = sessionRecordOf(payload);
  if (!session) return null;
  const id = session.id;
  const keepaliveTimeoutSeconds = session.keepalive_timeout_seconds;
  if (typeof id !== "string" || !id) return null;
  if (typeof keepaliveTimeoutSeconds !== "number" || !Number.isFinite(keepaliveTimeoutSeconds) || keepaliveTimeoutSeconds <= 0) return null;
  return {
    id,
    ...(typeof session.status === "string" ? { status: session.status } : {}),
    keepaliveTimeoutSeconds,
    reconnectUrl: typeof session.reconnect_url === "string" ? session.reconnect_url : null,
  };
}

export type EventSubReconnectSession = { id: string; reconnectUrl: string };

/** `session_reconnect`'s payload carries the same `session` envelope, but the field that matters
 * here is `reconnect_url` — the new WebSocket URL Twitch wants the client to move to. */
export function parseReconnectSession(payload: unknown): EventSubReconnectSession | null {
  const session = sessionRecordOf(payload);
  if (!session) return null;
  const id = session.id;
  const reconnectUrl = session.reconnect_url;
  if (typeof id !== "string" || !id) return null;
  if (typeof reconnectUrl !== "string" || !reconnectUrl) return null;
  return { id, reconnectUrl };
}

function sessionRecordOf(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const session = (payload as Record<string, unknown>).session;
  if (!session || typeof session !== "object" || Array.isArray(session)) return null;
  return session as Record<string, unknown>;
}
