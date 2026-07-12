// Issue #88: EventSub-specific reconnect TRIGGER CONDITIONS and POLICY VALUES only — pure, no I/O,
// no timers, no mutable state (same "pure logic beside a stateful orchestrator" role eventsub-
// state.ts plays for eventsub-session.ts/eventsub-service.ts, and subscription-registry.ts plays
// for subscription-reconciler.ts). reconnect-coordinator.ts is the stateful orchestrator that
// actually owns sockets/timers and calls into this file's functions.
//
// "共通化: backoff計算...は#57/#68の共有primitiveを利用し、本issueはEventSub固有の発火条件とpolicy
// 値のみ定義する" — computeReconnectDelayMs() below is a thin wrapper that DELEGATES the actual
// exponential-backoff-with-jitter math to #68's retry-policy.ts (`retryDelay`), the same function
// twitch-token-refresher.ts/device-code-flow.ts's one-shot retries already use. Nothing here
// reimplements that formula — this file only supplies the EventSub-specific RetryPolicy VALUES
// (base/max delay, jitter) and constructs the throwaway ServiceError retryDelay's signature
// requires (EventSub reconnects never carry a server-supplied Retry-After, so
// `options.retryAfterMs` is always left unset, meaning retryDelay always falls through to its own
// exponential+jitter branch).
import { ServiceError } from "../../service-error";
import { retryDelay } from "../../retry-policy";
import type { RetryPolicy } from "../../retry-policy";
import type { ServiceErrorCode } from "../../../../shared/services/service-errors";
import type { EventSubCloseCategory } from "./eventsub-state";

const SERVICE_ID = "twitch:eventsub:reconnect";

/** "通常切断用exponential backoff＋jitterを実装" — our own defensive choice (Twitch's docs don't
 * prescribe a reconnect cadence for an ordinary/unspecified disconnect, only for the specified
 * `session_reconnect` flow, which never backs off at all — see DEFAULT_SPECIFIED_RECONNECT_GRACE_MS
 * below). 1s -> 2s -> 4s -> 8s -> 16s -> 30s(capped), ±20% jitter. `maxAttempts` is effectively
 * unbounded — an ordinary disconnect is always worth retrying forever until an explicit stop/auth
 * change says otherwise (see shouldRetryCloseCategory()); nothing in this policy itself ever gives
 * up. */
export const DEFAULT_RECONNECT_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: Number.MAX_SAFE_INTEGER,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
});

/** "接続継続時間によるattempt resetを実装" — how long a session must stay connected before the NEXT
 * disconnect is treated as a fresh outage (attempt count reset to 0) rather than a continuation of
 * an already-backing-off flapping sequence. Our own choice (Twitch documents no such figure); one
 * minute is long enough to distinguish "briefly connected then dropped again" (flapping — keep
 * backing off) from "was genuinely healthy for a while" (reset). */
export const DEFAULT_STABLE_CONNECTED_MS = 60_000;

/** "grace deadline超過時に通常新規接続へfallback" — our own budget for the CANDIDATE socket (the
 * new session opened against Twitch's `session_reconnect`-supplied URL) to finish its TCP/TLS
 * handshake and deliver session_welcome. Deliberately larger than eventsub-session.ts's own
 * DEFAULT_WELCOME_TIMEOUT_MS (10s, used for the ordinary connect path against a URL this app
 * already has an open TLS session history with) since a specified reconnect_url can point at a
 * different host, requiring a completely fresh DNS+TCP+TLS negotiation before welcome-timeout
 * bookkeeping even starts on the candidate session itself. */
export const DEFAULT_SPECIFIED_RECONNECT_GRACE_MS = 15_000;

const RECONNECT_ERROR_CODE: ServiceErrorCode = "UNAVAILABLE";

/** "自身のEventSub session closeのretry可否をcategoryで判定" — mirrors eventsub-state.ts's own
 * closeCategoryFor() one level up: only a `normal` close (welcome_timeout/keepalive_timeout/
 * protocol_error/socket_error/socket_closed) is worth retrying. `auth` (a fresh token/scope grant
 * is required — retrying with the same credentials would just repeat the failure) and
 * `explicit_stop` (someone deliberately ended this — app quit, an explicit stop() call, or this
 * session being superseded by a newer one) are both terminal for THIS reconnect sequence — "explicit
 * stop/auth error...をretry対象外にする". */
export function shouldRetryCloseCategory(category: EventSubCloseCategory): boolean {
  return category === "normal";
}

/** Delegates to #68's retryDelay() for the actual math — see the module doc comment. `attempt` is
 * 1-based, matching retry-policy.ts's own convention (retryWithPolicy's first call is attempt 1). */
export function computeReconnectDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RECONNECT_POLICY, random: () => number = Math.random): number {
  const pseudoError = new ServiceError(RECONNECT_ERROR_CODE, "EventSub session disconnected", { serviceId: SERVICE_ID, retryable: true });
  return retryDelay(pseudoError, Math.max(1, attempt), policy, random);
}

/** "reconnect URLのscheme/hostを検証しqueryは改変しない" — a defense against a compromised/
 * malicious relay handing this client a `session_reconnect` message whose `reconnect_url` points
 * somewhere attacker-controlled: Twitch's own EventSub WebSocket reconnect_url is always issued on
 * their `*.wss.twitch.tv` host (the same family DEFAULT_EVENTSUB_WS_URL in eventsub-session.ts
 * itself connects to — "eventsub.wss.twitch.tv"). This function ONLY validates scheme+host; it
 * never rewrites/strips the URL's path or query — a caller that gets `true` back is expected to
 * connect to the EXACT string Twitch sent, untouched (reconnect_url's query carries a Twitch-issued
 * continuation token the server needs back verbatim). */
const TWITCH_RECONNECT_HOST_SUFFIX = ".wss.twitch.tv";
const TWITCH_RECONNECT_EXACT_HOST = "wss.twitch.tv";

export function isValidReconnectUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "wss:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === TWITCH_RECONNECT_EXACT_HOST || host.endsWith(TWITCH_RECONNECT_HOST_SUFFIX);
}
