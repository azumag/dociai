// Issue #87: maps Twitch's own documented EventSub revocation status values (arriving via a
// `revocation` WebSocket message — see eventsub-session.ts's onRevocation / eventsub-message-
// parser.ts's EventSubEnvelope) onto the actionable categories subscription-reconciler.ts needs,
// and tracks a short suppression window per subscription key so a revoked subscription is never
// immediately recreated in a tight revoke -> recreate -> revoke loop ("revoked keyを即再作成し続
// けない抑止", issue #87's TODO).
//
// Twitch's documented revocation `status` values (https://dev.twitch.tv/docs/eventsub/
// handling-websocket-events/ and the Twitch EventSub subscription-status catalog, cross-checked
// while implementing this issue):
//   authorization_revoked          - the authorizing user's grant no longer covers this
//                                     subscription (token revoked/scopes withdrawn)
//   user_removed                   - a user referenced in `condition` (here: the broadcaster) no
//                                     longer exists on Twitch
//   version_removed                - the subscribed type+version is no longer supported by Twitch
//   moderator_removed              - the moderator who authorized this subscription is no longer
//                                     one of the broadcaster's moderators (not reachable by this
//                                     app's 5 subscription types today — none of them use a
//                                     moderator_user_id condition — handled defensively anyway)
//   notification_failures_exceeded - Twitch gave up delivering to this session because this app's
//                                     own WebSocket client fell too far behind
import type { EventSubEnvelope } from "./eventsub-message-parser";
import type { SubscriptionCondition } from "./subscription-registry";
import { subscriptionKey } from "./subscription-registry";
import type { Clock } from "./keepalive-watchdog";
import { systemClock } from "./keepalive-watchdog";

/** "revocation statusをauth invalid/version removed/user removedへmapping" (issue #87's TODO):
 * `auth` -> hand off to the auth coordinator (a fresh token/scope grant may fix it); `not_
 * recoverable` -> a code/configuration problem no retry can fix, surfaced as an actionable
 * diagnostic; `recoverable` -> caused by this app's own client (e.g. falling behind on
 * notifications), expected to heal after reconnecting and a short suppression window; `unknown` is
 * any future status Twitch adds that this file doesn't recognize yet — treated conservatively
 * (never auto-recreated) rather than assumed safe, mirroring eventsub-message-parser.ts's "an
 * unrecognized value is never silently treated as a known-safe one" stance. */
export type RevocationCategory = "auth" | "not_recoverable" | "recoverable" | "unknown";

export type RevocationClassification = { status: string; category: RevocationCategory; actionable: boolean; message: string };

const CATEGORY_BY_STATUS: Readonly<Record<string, RevocationCategory>> = Object.freeze({
  authorization_revoked: "auth",
  moderator_removed: "auth",
  user_removed: "not_recoverable",
  version_removed: "not_recoverable",
  notification_failures_exceeded: "recoverable",
});

const MESSAGE_BY_STATUS: Readonly<Record<string, string>> = Object.freeze({
  authorization_revoked: "the authorizing user's grant no longer covers this subscription; a scope/reauthorization action is required",
  moderator_removed: "the moderator who authorized this subscription is no longer a moderator; a scope/reauthorization action is required",
  user_removed: "a user referenced by this subscription's condition no longer exists on Twitch; this subscription cannot be recreated as configured",
  version_removed: "Twitch no longer supports this subscription type/version; this is a code/configuration problem, not something a retry can fix",
  notification_failures_exceeded: "Twitch stopped delivering to this session after too many failed notification deliveries; safe to retry after the suppression window",
});

/** Pure classification — no state, no clock. Every outcome is `actionable: true`: a revocation
 * message, by definition, is never a healthy status, so there is always SOMETHING for a caller to
 * do with it (surface a diagnostic, hand off to auth, or quietly retry-after-suppression) — this
 * flag exists mainly so callers never need a separate "is this worth showing" check of their own,
 * satisfying "version removed時のactionable error" (issue #87's test list) uniformly for every
 * status, not just version_removed specifically. */
export function classifyRevocationStatus(status: string): RevocationClassification {
  const category = CATEGORY_BY_STATUS[status] ?? "unknown";
  const message = MESSAGE_BY_STATUS[status] ?? `unrecognized revocation status "${status}"; treating conservatively as non-retryable until a newer build recognizes it`;
  return { status, category, actionable: true, message };
}

export type RevokedSubscriptionInfo = { id: string; type: string; version: string; condition: SubscriptionCondition; status: string };

/** Extracts the `subscription` object Twitch's real `revocation` message payload carries (the same
 * `{ metadata, payload }` envelope every EventSub WebSocket message type shares — see eventsub-
 * message-parser.ts's own module doc comment). Returns null for a malformed payload rather than
 * throwing, matching every other payload-shape helper in this directory (parseWelcomeSession/
 * parseReconnectSession). */
export function parseRevokedSubscription(payload: unknown): RevokedSubscriptionInfo | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const subscription = (payload as Record<string, unknown>).subscription;
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) return null;
  const record = subscription as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.type !== "string" || typeof record.version !== "string" || typeof record.status !== "string") return null;
  const conditionRaw = record.condition;
  const condition: Record<string, string> = {};
  if (conditionRaw && typeof conditionRaw === "object" && !Array.isArray(conditionRaw)) {
    for (const [key, value] of Object.entries(conditionRaw as Record<string, unknown>)) if (typeof value === "string") condition[key] = value;
  }
  return { id: record.id, type: record.type, version: record.version, status: record.status, condition };
}

export type RevocationOutcome = {
  key: string;
  subscription: RevokedSubscriptionInfo;
  classification: RevocationClassification;
  revokedAtMs: number;
  /** Absolute clock time this key may be attempted again, or null when the key is permanently
   * blocked (category `auth`/`not_recoverable` — see handle() below) rather than time-suppressed. */
  suppressedUntilMs: number | null;
};

export type RevocationHandlerDeps = {
  clock?: Clock;
  /** Suppression window applied to a `recoverable`/`unknown` revocation before the reconciler may
   * attempt to recreate that key again. Kept short (our own defensive default, not a number Twitch
   * documents) since these categories ARE expected to eventually heal on their own. */
  suppressionMs?: number;
};

export const DEFAULT_REVOCATION_SUPPRESSION_MS = 30_000;

/** Owns the small amount of mutable state this issue's revocation handling needs: the per-key
 * suppression clock ("revoked keyを即再作成し続けない抑止") and the last-known classification per
 * key ("revocation statusを...mapping" surfaced for UI/diagnostics). Never talks to Helix or the
 * WebSocket itself — wired as subscription-reconciler.ts's onRevocation handler. */
export class RevocationHandler {
  readonly #clock: Clock;
  readonly #suppressionMs: number;
  readonly #suppressedUntilMs = new Map<string, number>();
  /** `auth`/`not_recoverable` keys: never auto-recreated by time alone (auth needs a fresh
   * token/scope grant; not_recoverable needs a code/config change) — stay blocked until the caller
   * explicitly clears them via clearBlock() below. */
  readonly #blocked = new Set<string>();
  readonly #lastByKey = new Map<string, RevocationOutcome>();

  constructor(deps: RevocationHandlerDeps = {}) {
    this.#clock = deps.clock ?? systemClock;
    this.#suppressionMs = deps.suppressionMs ?? DEFAULT_REVOCATION_SUPPRESSION_MS;
  }

  /** Parses+classifies one `revocation` envelope and records its suppression/block state. Returns
   * null for a malformed payload (nothing to record) rather than throwing. */
  handle(envelope: EventSubEnvelope): RevocationOutcome | null {
    const subscription = parseRevokedSubscription(envelope.payload);
    if (!subscription) return null;
    const key = subscriptionKey({ type: subscription.type, version: subscription.version, condition: subscription.condition });
    const classification = classifyRevocationStatus(subscription.status);
    const revokedAtMs = this.#clock.now();

    // `unknown` (a status this build doesn't recognize) is blocked the SAME as `auth`/
    // `not_recoverable`, never time-suppressed like `recoverable` — see RevocationCategory's own
    // doc comment ("treated conservatively (never auto-recreated) rather than assumed safe") and
    // classifyRevocationStatus()'s own message text for an unrecognized status ("treating
    // conservatively as non-retryable"). A time-based suppression here would silently contradict
    // both of those and let the reconciler auto-retry a status nobody has actually vetted yet.
    let suppressedUntilMs: number | null = null;
    if (classification.category === "auth" || classification.category === "not_recoverable" || classification.category === "unknown") {
      this.#blocked.add(key);
      this.#suppressedUntilMs.delete(key);
    } else {
      this.#blocked.delete(key);
      suppressedUntilMs = revokedAtMs + this.#suppressionMs;
      this.#suppressedUntilMs.set(key, suppressedUntilMs);
    }

    const outcome: RevocationOutcome = { key, subscription, classification, revokedAtMs, suppressedUntilMs };
    this.#lastByKey.set(key, outcome);
    return outcome;
  }

  /** "revoked keyを即再作成し続けない抑止": true while `key` is still within its suppression
   * window OR permanently blocked (auth/not_recoverable) — subscription-reconciler.ts consults
   * this before attempting to (re)create any desired key. */
  isSuppressed(key: string, nowMs: number = this.#clock.now()): boolean {
    if (this.#blocked.has(key)) return true;
    const until = this.#suppressedUntilMs.get(key);
    return until !== undefined && nowMs < until;
  }

  /** Explicit escape hatch for a caller that knows the underlying cause has been addressed (e.g.
   * twitch-auth-coordinator.ts just completed a scope upgrade, or the broadcaster id changed) —
   * lets the reconciler retry a previously-blocked key without waiting for a fresh revocation to
   * re-arm a time-based suppression (which auth/not_recoverable keys never get in the first place —
   * see handle() above). */
  clearBlock(key: string): void {
    this.#blocked.delete(key);
    this.#suppressedUntilMs.delete(key);
  }

  lastOutcome(key: string): RevocationOutcome | null {
    return this.#lastByKey.get(key) ?? null;
  }

  snapshot(): RevocationOutcome[] {
    return [...this.#lastByKey.values()];
  }
}
