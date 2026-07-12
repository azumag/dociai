// Issue #92: cooldown key construction for src/triggers/cooldown-tracker.js. A trigger's cooldown
// is always scoped to the trigger itself ("cooldown can be scoped per-trigger" — #92's own body);
// `keyBy` only controls OPTIONAL further narrowing on top of that base scope, by any combination of
// `actor` (the event's `actor.id`), `reward` (`data.rewardId`, reward-redemption events only), and
// `eventType` (`event.kind`). This mirrors event-field-registry.js's own "fixed allow-list, no
// dynamic path-walking" stance: the only fields ever read here are the exact base-StreamEvent
// fields the #91 contract (src/stream-events/contract.js) guarantees, never a caller-supplied path.
//
// -- Anonymous actor policy (the issue's own explicit decision point) --------------------------
// Per #90's normalizer (electron/main/services/twitch/events/normalizers/shared.ts's buildActor()),
// EVERY anonymous event collapses to the exact same `{ id: null, displayName: "Anonymous",
// isAnonymous: true }` actor — there is no way to tell two different anonymous cheerers apart.
// Naively keying cooldown by `actor.id` (or by a shared "anonymous" sentinel) would therefore let
// ONE anonymous cheerer's cooldown block a COMPLETELY DIFFERENT anonymous cheerer, which the issue
// flags as unfair. This module resolves it by fully EXEMPTING any cooldown rule whose `keyBy`
// includes `"actor"` when the event's actor is anonymous: buildCooldownKey() returns `exempt: true`
// (and a null `key`) rather than falling back to some coarser shared key, so cooldown-tracker.js
// never gates (and never consumes) that rule for an anonymous event at all — no two anonymous
// events are ever bucketed together BECAUSE they're anonymous. A trigger that still wants SOME
// throttling for anonymous bursts should configure a `keyBy` that omits `"actor"` (e.g. `[]` for
// plain per-trigger cooldown, or `["reward"]`/`["eventType"]`) — those dimensions don't depend on
// actor identity and apply to anonymous events exactly like any other.

/** The only narrowing dimensions a `keyBy` array may request, beyond the always-present trigger
 * base scope. Any other value is silently ignored (defensive — same "fixed allow-list, unknown
 * input just doesn't match" stance as event-field-registry.js). */
export const COOLDOWN_KEY_DIMENSIONS = Object.freeze(["actor", "reward", "eventType"]);

const MAX_KEY_PART_LENGTH = 200;

function sanitizePart(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return text.length > MAX_KEY_PART_LENGTH ? text.slice(0, MAX_KEY_PART_LENGTH) : text;
}

/**
 * Builds a cooldown key for `event` under a trigger `triggerId`, narrowed by `keyBy` (an array
 * subset of COOLDOWN_KEY_DIMENSIONS; unknown entries are ignored; order does not affect the
 * resulting key — dimensions are always emitted in the fixed order eventType/reward/actor so two
 * configs that request the same set of dimensions in different array orders produce IDENTICAL
 * keys).
 *
 * Returns `{ key, exempt, reason }`:
 *   - `key`: a stable string, or `null` when no key applies (missing `triggerId`, or the
 *     anonymous-actor exemption below).
 *   - `exempt`: true when this cooldown rule does not apply to `event` at all (anonymous-actor
 *     exemption) — the caller (cooldown-tracker.js) must treat this as "always allowed, never
 *     consumed", not merely "no extra narrowing".
 *   - `reason`: `null`, `"missing-trigger-id"`, or `"anonymous-actor-exempt"` — surfaced so a
 *     trace/diagnostic can explain WHY a cooldown rule didn't gate a given event.
 */
export function buildCooldownKey({ triggerId, keyBy = [], event } = {}) {
  if (!triggerId || typeof triggerId !== "string") {
    return Object.freeze({ key: null, exempt: false, reason: "missing-trigger-id" });
  }
  const dims = new Set((Array.isArray(keyBy) ? keyBy : []).filter((dim) => COOLDOWN_KEY_DIMENSIONS.includes(dim)));

  if (dims.has("actor") && event?.actor?.isAnonymous === true) {
    return Object.freeze({ key: null, exempt: true, reason: "anonymous-actor-exempt" });
  }

  const parts = [`trigger:${sanitizePart(triggerId)}`];
  if (dims.has("eventType")) parts.push(`eventType:${sanitizePart(event?.kind)}`);
  if (dims.has("reward")) parts.push(`reward:${sanitizePart(event?.data?.rewardId)}`);
  if (dims.has("actor")) parts.push(`actor:${sanitizePart(event?.actor?.id)}`);
  return Object.freeze({ key: parts.join("|"), exempt: false, reason: null });
}

/** True for a `keyBy` array that only contains recognized dimensions — a save-time validation
 * helper for whatever config layer eventually authors trigger cooldown rules (not itself invoked by
 * anything in this issue's scope, offered for the same reason event-field-registry.js exposes
 * `isFieldValidForKind` standalone). */
export function isValidCooldownKeyBy(keyBy) {
  return Array.isArray(keyBy) && keyBy.every((dim) => COOLDOWN_KEY_DIMENSIONS.includes(dim));
}
