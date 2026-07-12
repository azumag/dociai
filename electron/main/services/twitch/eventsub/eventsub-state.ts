// Issue #86: pure state shapes + transition guard for the EventSub session/service state
// machines, plus the health-status projection shipped to the UI. No I/O, no timers — mirrors
// twitch-auth-state.ts's role for the Device Code Grant state machine (#83/#84/#85): the only
// thing that drives these transitions is eventsub-session.ts/eventsub-service.ts, but the shapes
// and the transition table themselves are kept here, framework-free.
import type { HealthStatus } from "../../../../shared/services/service-events";

// -------------------------------------------------------------------------------------------
// Session-level state (owned by eventsub-session.ts — one instance per WebSocket connection)
// -------------------------------------------------------------------------------------------

export type EventSubSessionState = "connecting" | "awaiting_welcome" | "connected" | "closed";

export const SESSION_STATE_TRANSITIONS: Readonly<Record<EventSubSessionState, readonly EventSubSessionState[]>> = Object.freeze({
  connecting: ["awaiting_welcome", "closed"],
  awaiting_welcome: ["connected", "closed"],
  connected: ["closed"],
  closed: [],
});

export function canTransitionSessionState(from: EventSubSessionState, to: EventSubSessionState): boolean {
  return from === to || SESSION_STATE_TRANSITIONS[from].includes(to);
}

/** Why a session ended. Deliberately more granular than the three acceptance-criteria categories
 * below (EventSubCloseCategory) — #88 (reconnect policy) is expected to switch on `category` for
 * its actual retry/backoff decision, while `reason` stays around for logs/diagnostics/tests. */
export type EventSubCloseReason =
  | "explicit_stop"
  | "app_quit"
  | "superseded"
  | "auth_generation_changed"
  | "auth_not_ready"
  | "welcome_timeout"
  | "keepalive_timeout"
  | "protocol_error"
  | "socket_error"
  | "socket_closed";

/** "切断理由を通常切断・auth・explicit stopへ分類できる" (issue #86 acceptance criteria) — the
 * three buckets #88's reconnect policy is expected to branch on: `normal` (a recoverable
 * disconnect worth retrying per #88's own policy), `auth` (the token/identity the session was
 * opened under is no longer trustworthy — reconnecting with the SAME credentials would just repeat
 * the failure; a fresh getValidAccessToken() + explicit start() is required), `explicit_stop`
 * (someone deliberately asked for this — app quit, a caller-issued stop(), or this service
 * replacing its own session — never retry). */
export type EventSubCloseCategory = "normal" | "auth" | "explicit_stop";

export const CLOSE_REASON_CATEGORY: Readonly<Record<EventSubCloseReason, EventSubCloseCategory>> = Object.freeze({
  explicit_stop: "explicit_stop",
  app_quit: "explicit_stop",
  superseded: "explicit_stop",
  auth_generation_changed: "auth",
  auth_not_ready: "auth",
  welcome_timeout: "normal",
  keepalive_timeout: "normal",
  protocol_error: "normal",
  socket_error: "normal",
  socket_closed: "normal",
});

export function closeCategoryFor(reason: EventSubCloseReason): EventSubCloseCategory {
  return CLOSE_REASON_CATEGORY[reason];
}

export type EventSubSessionSnapshot = {
  sessionId: string | null;
  state: EventSubSessionState;
  keepaliveTimeoutSeconds: number | null;
  lastMessageAtMs: number | null;
  closeReason: EventSubCloseReason | null;
  closeCategory: EventSubCloseCategory | null;
};

export function initialSessionSnapshot(): EventSubSessionSnapshot {
  return { sessionId: null, state: "connecting", keepaliveTimeoutSeconds: null, lastMessageAtMs: null, closeReason: null, closeCategory: null };
}

// -------------------------------------------------------------------------------------------
// Service-level state (owned by eventsub-service.ts — the top-level "one session at a time" owner)
// -------------------------------------------------------------------------------------------

export type EventSubServiceStatus = "idle" | "disabled" | "desired_empty" | "auth_not_ready" | "starting" | "running" | "stopped";

export type EventSubServiceSnapshot = {
  status: EventSubServiceStatus;
  session: EventSubSessionSnapshot | null;
  updatedAtMs: number;
};

export function initialServiceSnapshot(nowMs: number): EventSubServiceSnapshot {
  return { status: "idle", session: null, updatedAtMs: nowMs };
}

/** "state/health snapshotをUIへ配送" — projects the service snapshot onto the shared HealthStatus
 * taxonomy every other Main-process service already reports through (integration-health.ts).
 * `disabled`/`desired_empty`/`idle` are deliberate, non-error states (nothing is wrong; nothing was
 * asked for) and map to "unknown" rather than "unavailable"/"degraded" — the same reasoning
 * twitch-chat-health.js's idle branch uses. A `stopped` session whose last close was a `normal`
 * (unexpected) disconnect is reported as "degraded" — the caller asked to be running and isn't,
 * distinct from a `stopped` that followed an explicit_stop/auth close (both "unknown": nothing
 * unexpected happened). */
export function eventSubHealthStatus(snapshot: EventSubServiceSnapshot): HealthStatus {
  switch (snapshot.status) {
    case "running":
      return "healthy";
    case "starting":
      return "checking";
    case "auth_not_ready":
      return "degraded";
    case "stopped":
      return snapshot.session?.closeCategory === "normal" ? "degraded" : "unknown";
    case "disabled":
    case "desired_empty":
    case "idle":
    default:
      return "unknown";
  }
}
