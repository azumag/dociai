// Issue #92: per-key sliding-window rate limiting for trigger actions — DIFFERENT from
// src/triggers/cooldown-tracker.js's cooldown (a minimum SPACING between individual fires).
// A rate limiter instead bounds a COUNT: at most `maxActions` actions per `key` within a rolling
// `windowMs`, allowing a burst up to that count before throttling kicks in. A trigger typically
// wants BOTH: a cooldown so back-to-back fires are spaced out, AND a rate limit so it can't be
// re-triggered indefinitely fast right up against the cooldown boundary forever.
//
// Deliberately its OWN small bounded structure rather than another `ResponseBudgetTracker`
// composition (see cooldown-tracker.js's header comment for why THAT reuse made sense for
// cooldown): a sliding-window rate limiter's natural state per key is a short list of recent
// timestamps pruned to the window, not a committed/reserved counter with a single fixed TTL — a
// fundamentally different shape, so forcing it through ResponseBudgetTracker would fight the
// abstraction rather than reuse it. It still follows this repo's established "bound a per-key map
// with LRU eviction" shape (see event-id-dedupe.ts/notification-dedupe.ts's own mirrored-not-shared
// stance for the identical reasoning).
export const OVERFLOW_POLICIES = Object.freeze(["drop", "aggregate", "template-only"]);
export const DEFAULT_OVERFLOW_POLICY = "drop";
export const DEFAULT_MAX_KEYS = 2_000;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export class ActionRateLimiter {
  constructor({ clock = () => Date.now(), maxKeys = DEFAULT_MAX_KEYS } = {}) {
    this.clock = clock;
    this.maxKeys = maxKeys;
    this.windows = new Map(); // key -> { timestamps: number[], lruSeq }
    this.sequence = 0;
    this.totalAllowed = 0;
    this.totalOverflowed = 0;
  }

  /**
   * Attempts to record one action at `key` against `{ windowMs, maxActions, overflowPolicy }`.
   * `priorityExempt: true` always allows (used sparingly — the primary priority-aware protection
   * for a burst of unrelated low-priority triggers is src/actions/global-action-budget.js's
   * reserved headroom; this is a cheap escape hatch for a caller that already knows a specific
   * trigger's own action must never be rate-limited against itself).
   *
   * Returns `{ allowed, decision, reason, count, maxActions, windowMs, remaining }` where
   * `decision` is `"allow"` when allowed, else one of OVERFLOW_POLICIES.
   */
  attempt(key, { windowMs, maxActions, overflowPolicy = DEFAULT_OVERFLOW_POLICY, priorityExempt = false } = {}, now = this.clock()) {
    if (!key || typeof key !== "string") throw new TypeError("ActionRateLimiter key is required");
    if (!isPositiveInteger(windowMs)) throw new RangeError("ActionRateLimiter windowMs must be a positive integer");
    if (!isPositiveInteger(maxActions)) throw new RangeError("ActionRateLimiter maxActions must be a positive integer");
    const policy = OVERFLOW_POLICIES.includes(overflowPolicy) ? overflowPolicy : DEFAULT_OVERFLOW_POLICY;

    const entry = this.#entryFor(key, now);
    this.#prune(entry, windowMs, now);

    if (priorityExempt || entry.timestamps.length < maxActions) {
      entry.timestamps.push(now);
      this.#touch(entry);
      this.totalAllowed += 1;
      return Object.freeze({ allowed: true, decision: "allow", reason: null, count: entry.timestamps.length, maxActions, windowMs, remaining: Math.max(0, maxActions - entry.timestamps.length) });
    }

    this.totalOverflowed += 1;
    return Object.freeze({ allowed: false, decision: policy, reason: "rate-limit-exceeded", count: entry.timestamps.length, maxActions, windowMs, remaining: 0 });
  }

  /** Read-only peek — current in-window count for `key`, without recording an attempt. */
  peek(key, { windowMs }, now = this.clock()) {
    const entry = this.windows.get(key);
    if (!entry) return 0;
    this.#prune(entry, windowMs, now);
    return entry.timestamps.length;
  }

  reset(key) {
    return this.windows.delete(key);
  }

  clear() {
    this.windows.clear();
  }

  stats() {
    return Object.freeze({ keys: this.windows.size, maxKeys: this.maxKeys, totalAllowed: this.totalAllowed, totalOverflowed: this.totalOverflowed });
  }

  #entryFor(key, now) {
    let entry = this.windows.get(key);
    if (!entry) {
      if (this.windows.size >= this.maxKeys) this.#evictOldest();
      entry = { timestamps: [], lruSeq: ++this.sequence };
      this.windows.set(key, entry);
    }
    return entry;
  }

  #prune(entry, windowMs, now) {
    const cutoff = now - windowMs;
    if (entry.timestamps.length && entry.timestamps[0] <= cutoff) {
      entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);
    }
  }

  #touch(entry) {
    entry.lruSeq = ++this.sequence;
  }

  #evictOldest() {
    let oldestKey = null;
    let oldestSeq = Infinity;
    for (const [key, entry] of this.windows) {
      if (entry.lruSeq < oldestSeq) {
        oldestSeq = entry.lruSeq;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.windows.delete(oldestKey);
  }
}
