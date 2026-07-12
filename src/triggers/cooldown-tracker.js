// Issue #92: per-trigger cooldown gating, sitting directly on top of #91's matcher output — a
// `MatchResult` says a trigger's condition tree passed; CooldownTracker decides whether that match
// may actually FIRE right now, or is still on cooldown.
//
// -- "TTL/LRU bounded trackerを#59 primitiveと共有" ----------------------------------------------
// This repo's established bounded-Map primitive is src/personas/response-budget-tracker.js's
// `ResponseBudgetTracker` (added for #59, already reused by two Electron-side TTL/LRU dedupe
// classes — see notification-dedupe.ts's and event-id-dedupe.ts's own header comments — though both
// of THOSE chose to mirror its TTL/LRU MECHANICS rather than import the class itself, since a
// dedupe cache's "have I seen this id" need is simpler than ResponseBudgetTracker's full
// reserve/commit/release bookkeeping, and Electron main-process TS code can't import a plain
// src/*.js module across that build boundary anyway).
//
// Neither obstacle applies here: this file lives in the same plain-`src/*.js` world as
// response-budget-tracker.js, AND cooldown genuinely needs reserve/commit/release — a cooldown can
// be "reserved" the moment a trigger is scheduled to fire (blocking a second concurrent match on
// the same key while the first is still in flight), "committed" (the cooldown actually starts
// counting down) at whichever lifecycle point `consumeOn` names, and "released" (no cooldown
// consumed at all) if the action never gets there. A cooldown is exactly "at most 1 committed
// action per key per `cooldownMs`" — i.e. `ResponseBudgetTracker` with `limit = 1`. So this module
// genuinely REUSES `ResponseBudgetTracker` (imports and instantiates the real class, not a
// copy-pasted idiom) instead of extracting/duplicating its TTL/LRU mechanics.
//
// The one real mismatch: `ResponseBudgetTracker` bakes a single `ttlMs` into its constructor and
// applies it to every key the instance ever touches, but different triggers legitimately want
// different `cooldownMs` values sharing one CooldownTracker (a "big cheer" trigger's 2-minute
// cooldown and a "small redemption" trigger's 5-second cooldown must not interfere with each
// other's timing). Rather than forking/rewriting ResponseBudgetTracker (risking its two existing
// Electron-independent callers/tests) or inventing a THIRD bounded-map idiom, CooldownTracker holds
// one `ResponseBudgetTracker` instance PER DISTINCT `cooldownMs` value, created lazily and reused
// across all keys that share that duration. The number of distinct durations in play is bounded by
// the number of configured triggers (a config-time quantity), never by event volume, so this does
// not reintroduce the "grows without bound under a burst" problem #92 exists to prevent; each
// sub-tracker independently keeps its own key population bounded by `maxEntriesPerDuration`, exactly
// like `ResponseBudgetTracker` already guarantees for PersonaRouter's response budget.
import { ResponseBudgetTracker } from "../personas/response-budget-tracker.js";

/** WHEN a cooldown is actually consumed, relative to the action's own lifecycle — configurable per
 * trigger because different actions have different appropriate semantics (per the issue body):
 *   - "scheduled": consumed the instant the trigger is allowed to fire (matches PersonaRouter's own
 *     simple cooldown semantics) — cheapest, most conservative (always consumes even if the action
 *     later fails to start).
 *   - "started": consumed once the action actually STARTS executing (e.g. the AI request begins) —
 *     a match that gets dropped/aggregated before starting never consumes the cooldown.
 *   - "completed": consumed only once the action fully COMPLETES — a failed/cancelled action never
 *     consumes the cooldown, so the trigger can be retried sooner. Appropriate for actions where a
 *     failure should not itself count against the user.
 */
export const COOLDOWN_CONSUME_POINTS = Object.freeze(["scheduled", "started", "completed"]);
export const DEFAULT_CONSUME_ON = "scheduled";

export const DEFAULT_COOLDOWN_MAX_ENTRIES_PER_DURATION = 2_000;
/** Distinct `cooldownMs` values are a config-time quantity (one per differently-configured
 * trigger), not an event-volume quantity — this is generous headroom over any realistic trigger
 * list while still bounding memory against a pathological/misbehaving caller that mints a fresh
 * duration on every call (e.g. accidentally passing a timestamp instead of a duration). */
export const DEFAULT_MAX_DURATION_BUCKETS = 256;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export class CooldownTracker {
  constructor({ clock = () => Date.now(), maxEntriesPerDuration = DEFAULT_COOLDOWN_MAX_ENTRIES_PER_DURATION, maxDurationBuckets = DEFAULT_MAX_DURATION_BUCKETS } = {}) {
    this.clock = clock;
    this.maxEntriesPerDuration = maxEntriesPerDuration;
    this.maxDurationBuckets = maxDurationBuckets;
    this.trackersByDuration = new Map(); // cooldownMs -> ResponseBudgetTracker
    this.durationBucketOverflows = 0;
  }

  /** Read-only peek: true if `key` is currently on cooldown for `cooldownMs`, without reserving or
   * consuming anything. A falsy `key` (e.g. cooldown-key.js's `exempt` result) is never on
   * cooldown. */
  isOnCooldown(key, cooldownMs, now = this.clock()) {
    if (!key) return false;
    const tracker = this.#trackerFor(cooldownMs, { createIfMissing: false });
    if (!tracker) return false;
    return tracker.remaining(key, 1, now) <= 0;
  }

  /**
   * Starts the cooldown lifecycle for one match: `schedule()` is called once a trigger is decided
   * to fire (i.e. AFTER matching, cooldown, rate-limit, and budget all being evaluated is exactly
   * the wrong mental model — `schedule()` IS the cooldown check itself, done first).
   *
   * `bypassCooldown` implements "simulationでcooldown無視option" — when true, cooldown is neither
   * checked nor consumed at all (the gate always allows, and never touches tracker state), so a
   * simulation run never pollutes real cooldown timing. #96's own safe default is to default THIS
   * flag ON for its simulation mode; that default lives in #96's UI, not here — this module only
   * needs to support the flag cleanly.
   *
   * Returns a "gate" object (intentionally mutable — `markStarted`/`markCompleted`/`cancel` update
   * it in place as the caller drives the action's lifecycle):
   *   `{ allowed, reason, key, cooldownMs, consumeOn, reservation, consumedAt }`
   * - `allowed: false` (`reason: "cooldown-active"`) — the caller must not fire; nothing to release.
   * - `allowed: true`, `consumedAt` set, `reservation: null` — cooldown already fully consumed
   *   (either `consumeOn: "scheduled"`, or `bypassCooldown`/exempt key).
   * - `allowed: true`, `reservation` set, `consumedAt: null` — the caller MUST later call exactly
   *   one of `markStarted()`/`markCompleted()`/`cancel()` on this gate to resolve it.
   */
  schedule(key, { cooldownMs, consumeOn = DEFAULT_CONSUME_ON, bypassCooldown = false } = {}, now = this.clock()) {
    const effectiveConsumeOn = COOLDOWN_CONSUME_POINTS.includes(consumeOn) ? consumeOn : DEFAULT_CONSUME_ON;
    if (!key) return this.#gate({ allowed: true, reason: "exempt", key: null, cooldownMs, consumeOn: effectiveConsumeOn, consumedAt: now });
    if (bypassCooldown) return this.#gate({ allowed: true, reason: "bypassed-simulation", key, cooldownMs, consumeOn: effectiveConsumeOn, consumedAt: now });
    if (!isPositiveInteger(cooldownMs)) return this.#gate({ allowed: true, reason: "no-cooldown-configured", key, cooldownMs, consumeOn: effectiveConsumeOn, consumedAt: now });

    const tracker = this.#trackerFor(cooldownMs, { createIfMissing: true });
    if (!tracker) return this.#gate({ allowed: true, reason: "duration-bucket-limit-exceeded", key, cooldownMs, consumeOn: effectiveConsumeOn, consumedAt: now });

    const reservation = tracker.reserve(key, 1, now);
    if (!reservation) return this.#gate({ allowed: false, reason: "cooldown-active", key, cooldownMs, consumeOn: effectiveConsumeOn });

    if (effectiveConsumeOn === "scheduled") {
      tracker.commit(reservation, now);
      return this.#gate({ allowed: true, reason: "allowed", key, cooldownMs, consumeOn: effectiveConsumeOn, consumedAt: now });
    }
    return this.#gate({ allowed: true, reason: "allowed", key, cooldownMs, consumeOn: effectiveConsumeOn, reservation });
  }

  /** Call when the action actually starts executing. Consumes the cooldown IFF this gate's
   * `consumeOn` is `"started"`; a no-op (returns false) for any other gate — including one already
   * fully consumed, or one whose `consumeOn` is `"completed"` (still pending `markCompleted`). */
  markStarted(gate, now = this.clock()) {
    return this.#consumeIf(gate, "started", now);
  }

  /** Call when the action fully completes. Consumes the cooldown IFF this gate's `consumeOn` is
   * `"completed"`; a no-op otherwise (a `"started"`-consumeOn gate should already be consumed by
   * `markStarted()` by the time an action completes). */
  markCompleted(gate, now = this.clock()) {
    return this.#consumeIf(gate, "completed", now);
  }

  /** Call when the action is dropped/fails/cancels BEFORE reaching its `consumeOn` point — releases
   * the pending reservation so the cooldown is never consumed. A no-op for a gate with no pending
   * reservation (already consumed, disallowed, or exempt). */
  cancel(gate) {
    if (!gate?.reservation) return false;
    const tracker = this.trackersByDuration.get(gate.cooldownMs);
    const released = tracker ? tracker.release(gate.reservation) : false;
    gate.reservation = null;
    return released;
  }

  /** Aggregated diagnostics across every duration bucket — "cooldown/rate/aggregation理由を利用者が
   * 確認できる"'s cooldown half. */
  stats() {
    let entries = 0;
    let reservations = 0;
    let evictedByTtl = 0;
    let evictedByLimit = 0;
    let rejectedReservations = 0;
    let committedTotalSinceStart = 0;
    for (const tracker of this.trackersByDuration.values()) {
      const s = tracker.stats();
      entries += s.entries;
      reservations += s.reservations;
      evictedByTtl += s.evictedByTtl;
      evictedByLimit += s.evictedByLimit;
      rejectedReservations += s.rejectedReservations;
      committedTotalSinceStart += s.committedTotalSinceStart;
    }
    return Object.freeze({
      durationBuckets: this.trackersByDuration.size,
      durationBucketOverflows: this.durationBucketOverflows,
      entries,
      reservations,
      evictedByTtl,
      evictedByLimit,
      rejectedReservations,
      committedTotalSinceStart,
    });
  }

  /** Full reset — for runtime teardown/generation replacement, mirroring PersonaRouter.dispose()'s
   * `budgetTracker.clear()`. Any gate created before this call must not be resolved afterwards
   * (its reservation belongs to a cleared/discarded sub-tracker). */
  clear() {
    for (const tracker of this.trackersByDuration.values()) tracker.clear();
    this.trackersByDuration.clear();
  }

  #consumeIf(gate, expectedConsumeOn, now) {
    if (!gate?.reservation || gate.consumeOn !== expectedConsumeOn) return false;
    const tracker = this.trackersByDuration.get(gate.cooldownMs);
    const committed = tracker ? tracker.commit(gate.reservation, now) : false;
    if (committed) {
      gate.consumedAt = now;
      gate.reservation = null;
    }
    return committed;
  }

  #trackerFor(cooldownMs, { createIfMissing }) {
    if (!isPositiveInteger(cooldownMs)) return null;
    const existing = this.trackersByDuration.get(cooldownMs);
    if (existing || !createIfMissing) return existing ?? null;
    if (this.trackersByDuration.size >= this.maxDurationBuckets) {
      // Defensive-only path (see the module doc comment: distinct durations are config-bounded in
      // practice). Fail OPEN rather than closed — refusing to create a bucket must never look like
      // "everything is on cooldown forever"; schedule() maps a null tracker to an always-allowed
      // gate with an explicit `"duration-bucket-limit-exceeded"` reason instead.
      this.durationBucketOverflows += 1;
      return null;
    }
    const tracker = new ResponseBudgetTracker({ ttlMs: cooldownMs, maxEntries: this.maxEntriesPerDuration, clock: this.clock });
    this.trackersByDuration.set(cooldownMs, tracker);
    return tracker;
  }

  #gate({ allowed, reason, key, cooldownMs, consumeOn, reservation = null, consumedAt = null }) {
    return { allowed, reason, key, cooldownMs, consumeOn, reservation, consumedAt };
  }
}
