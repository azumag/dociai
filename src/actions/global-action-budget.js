// Issue #92: a budget spanning ALL triggers, not just one. cooldown-tracker.js and
// action-rate-limiter.js both operate PER KEY (per trigger, or per trigger+actor/reward/eventType);
// each one individually staying within its own limit does not stop many DIFFERENT triggers from
// collectively flooding the shared AI/speech pipeline (e.g. ten different reward redemptions, each
// well under its own per-trigger rate limit, still add up to ten simultaneous AI requests).
// GlobalActionBudget is the final, trigger-agnostic gate: a sliding-window rate cap and a
// concurrency cap, both spanning every trigger together.
//
// -- High-priority protection ("high priority event保護" — this issue's own explicit test/accept
// requirement) --------------------------------------------------------------------------------
// A blanket global cap applied identically to every request would let a flood of many LOW-priority
// events (e.g. a redemption spam) exhaust the budget before a single HIGH-priority event (e.g. a
// large bits cheer) ever gets a turn — even though the high-value event arrived perfectly validly
// and deserves a response. `highPriorityReserve` carves out a portion of BOTH the rate-window and
// concurrency capacity exclusively for requests at/above `highPriorityThreshold`: general (non-
// high-priority) requests may only use the capacity OUTSIDE that reserve, while high-priority
// requests may use the full capacity (general pool + reserve). A low-priority flood can therefore
// never drive EITHER dimension past `capacity - reserve`, guaranteeing a high-priority request a
// slot is available whenever the flood alone would otherwise have exhausted the budget.
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_PER_WINDOW = 30;
export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_HIGH_PRIORITY_RESERVE = 2;
/** Matches event-trigger-schema.js's `DEFAULT_PRIORITY` (0) as the floor — any trigger configured
 * with an above-default priority is treated as "high priority" for budget purposes unless the
 * caller overrides `highPriorityThreshold`. */
export const DEFAULT_HIGH_PRIORITY_THRESHOLD = 1;

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export class GlobalActionBudget {
  constructor({
    windowMs = DEFAULT_WINDOW_MS,
    maxPerWindow = DEFAULT_MAX_PER_WINDOW,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    highPriorityReserve = DEFAULT_HIGH_PRIORITY_RESERVE,
    highPriorityThreshold = DEFAULT_HIGH_PRIORITY_THRESHOLD,
    clock = () => Date.now(),
  } = {}) {
    if (!isNonNegativeInteger(windowMs) || windowMs < 1) throw new RangeError("GlobalActionBudget windowMs must be a positive integer");
    if (!isNonNegativeInteger(maxPerWindow) || maxPerWindow < 1) throw new RangeError("GlobalActionBudget maxPerWindow must be a positive integer");
    if (!isNonNegativeInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError("GlobalActionBudget maxConcurrent must be a positive integer");
    if (!isNonNegativeInteger(highPriorityReserve)) throw new RangeError("GlobalActionBudget highPriorityReserve must be a non-negative integer");
    this.windowMs = windowMs;
    this.maxPerWindow = maxPerWindow;
    this.maxConcurrent = maxConcurrent;
    this.highPriorityReserve = Math.min(highPriorityReserve, maxPerWindow, maxConcurrent);
    this.highPriorityThreshold = highPriorityThreshold;
    this.clock = clock;

    this.generalWindow = []; // [{ id, ts }]
    this.highPriorityWindow = []; // [{ id, ts }]
    this.activeGeneral = 0;
    this.activeHighPriority = 0;
    this.reservations = new Map(); // id -> { isHighPriority, ts }
    this.sequence = 0;

    this.rejectedByRate = 0;
    this.rejectedByConcurrency = 0;
    this.reservedTotal = 0;
    this.completedTotal = 0;
    this.releasedTotal = 0;
  }

  /**
   * Attempts to reserve one global action slot. `priority` (defaults to event-trigger-schema.js's
   * own `DEFAULT_PRIORITY` of 0) is compared against `highPriorityThreshold` to decide whether this
   * request may draw on the reserved headroom.
   *
   * Returns `{ allowed, reason, reservation, isHighPriority }`. On `allowed: true`, the caller MUST
   * later call exactly one of `complete()`/`release()` with `reservation`.
   */
  reserve({ priority = 0, now = this.clock() } = {}) {
    this.#pruneWindow(now);
    const isHighPriority = priority >= this.highPriorityThreshold;

    const generalRateCap = Math.max(0, this.maxPerWindow - this.highPriorityReserve);
    const rateCount = this.generalWindow.length + this.highPriorityWindow.length;
    const rateAllowed = isHighPriority ? rateCount < this.maxPerWindow : this.generalWindow.length < generalRateCap;
    if (!rateAllowed) {
      this.rejectedByRate += 1;
      return Object.freeze({ allowed: false, reason: "global-rate-limit", reservation: null, isHighPriority });
    }

    const generalConcurrencyCap = Math.max(0, this.maxConcurrent - this.highPriorityReserve);
    const activeTotal = this.activeGeneral + this.activeHighPriority;
    const concurrencyAllowed = isHighPriority ? activeTotal < this.maxConcurrent : this.activeGeneral < generalConcurrencyCap;
    if (!concurrencyAllowed) {
      this.rejectedByConcurrency += 1;
      return Object.freeze({ allowed: false, reason: "global-concurrency-limit", reservation: null, isHighPriority });
    }

    const id = `global-action-budget-${++this.sequence}`;
    const windowEntry = { id, ts: now };
    (isHighPriority ? this.highPriorityWindow : this.generalWindow).push(windowEntry);
    if (isHighPriority) this.activeHighPriority += 1;
    else this.activeGeneral += 1;
    this.reservations.set(id, { isHighPriority });
    this.reservedTotal += 1;
    const reservation = Object.freeze({ id, isHighPriority, createdAt: now });
    return Object.freeze({ allowed: true, reason: "allowed", reservation, isHighPriority });
  }

  /** Marks a reservation's action as finished — frees its concurrency slot but keeps its
   * rate-window entry (the action genuinely happened, so it still counts against the window). */
  complete(reservation) {
    const active = this.#takeReservation(reservation);
    if (!active) return false;
    if (active.isHighPriority) this.activeHighPriority = Math.max(0, this.activeHighPriority - 1);
    else this.activeGeneral = Math.max(0, this.activeGeneral - 1);
    this.completedTotal += 1;
    return true;
  }

  /** Cancels a reservation that never actually ran — frees its concurrency slot AND removes its
   * rate-window entry (an action that never happened must not count against the budget). */
  release(reservation) {
    const active = this.#takeReservation(reservation);
    if (!active) return false;
    if (active.isHighPriority) {
      this.activeHighPriority = Math.max(0, this.activeHighPriority - 1);
      this.highPriorityWindow = this.highPriorityWindow.filter((entry) => entry.id !== reservation.id);
    } else {
      this.activeGeneral = Math.max(0, this.activeGeneral - 1);
      this.generalWindow = this.generalWindow.filter((entry) => entry.id !== reservation.id);
    }
    this.releasedTotal += 1;
    return true;
  }

  stats(now = this.clock()) {
    this.#pruneWindow(now);
    return Object.freeze({
      windowMs: this.windowMs,
      maxPerWindow: this.maxPerWindow,
      maxConcurrent: this.maxConcurrent,
      highPriorityReserve: this.highPriorityReserve,
      generalInWindow: this.generalWindow.length,
      highPriorityInWindow: this.highPriorityWindow.length,
      activeGeneral: this.activeGeneral,
      activeHighPriority: this.activeHighPriority,
      rejectedByRate: this.rejectedByRate,
      rejectedByConcurrency: this.rejectedByConcurrency,
      reservedTotal: this.reservedTotal,
      completedTotal: this.completedTotal,
      releasedTotal: this.releasedTotal,
    });
  }

  clear() {
    this.generalWindow = [];
    this.highPriorityWindow = [];
    this.activeGeneral = 0;
    this.activeHighPriority = 0;
    this.reservations.clear();
  }

  #takeReservation(reservation) {
    if (!reservation?.id) return null;
    const active = this.reservations.get(reservation.id);
    if (!active) return null;
    this.reservations.delete(reservation.id);
    return active;
  }

  #pruneWindow(now) {
    const cutoff = now - this.windowMs;
    if (this.generalWindow.length && this.generalWindow[0].ts <= cutoff) this.generalWindow = this.generalWindow.filter((entry) => entry.ts > cutoff);
    if (this.highPriorityWindow.length && this.highPriorityWindow[0].ts <= cutoff) this.highPriorityWindow = this.highPriorityWindow.filter((entry) => entry.ts > cutoff);
  }
}
