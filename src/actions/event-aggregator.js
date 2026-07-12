// Issue #92: batches multiple same-key events arriving within a short window into ONE summary
// response instead of firing an individual action per event — the "aggregate" overflow policy's
// destination (see action-rate-limiter.js's OVERFLOW_POLICIES), and independently useful for any
// caller that wants "collapse a burst into one" regardless of why the burst happened.
//
// -- "timer/listener/bufferをgenerationごとに所有" / "config reload/cancel時にflushせず破棄" ------
// Mirrors electron/main/services/twitch/eventsub/reconnect-coordinator.ts's own generation idiom
// one-for-one (see that file's header comment for the idiom's lineage across this repo): a
// monotonic `#generation` counter is bumped by `cancel()`, and every scheduled flush timer closes
// over the generation it was armed under, checking `generation !== this.#generation` before doing
// anything — so a timer that was ALREADY QUEUED to fire at the exact moment `cancel()` runs (a
// real race in a single-threaded event loop: the timer callback is already on the macrotask queue)
// still finds itself stale and no-ops, even though `clock.clearTimeout()` was also called on it.
// Both mechanisms together (explicit clearTimeout AND the generation guard) are what makes
// `cancel()` a genuine DISCARD, never a "flush on the way out" — the issue is explicit that a
// pending buffer must NOT be flushed as a final catch-up response on reload/cancel, only replaced.
//
// A caller wanting "apply new aggregation config" therefore does NOT mutate a live EventAggregator
// in place — the correct pattern (matching ReconnectCoordinator.start()'s own "supersede, don't
// mutate" convention) is: call `cancel()` on the old instance (discarding its buffers), then
// construct a brand new `EventAggregator` with the new config. This file does not implement that
// swap itself (no config-reload orchestration lives in this issue's scope — see the module list),
// it only guarantees `cancel()` is safe to call at any time without ever invoking `onFlush`.
export const DEFAULT_WINDOW_MS = 5_000;
export const DEFAULT_MAX_BATCH_SIZE = 20;
export const DEFAULT_MAX_KEYS = 500;

/** Plain-`src/*.js` equivalent of this repo's Electron-side `Clock` type (see
 * src/twitch-chat/twitch-chat-source.js's own identically-shaped `systemClock`) — real timers by
 * default, fully replaceable by a manual fake in tests so nothing here ever sleeps wall-clock
 * time. */
export const systemClock = { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (id) => clearTimeout(id) };

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Produces a summary object suitable for one combined response instead of N individual ones —
 * "aggregate summary(total bits/gifts/reward count)を生成". Reads only the base #91 StreamEvent
 * contract fields (never a dynamic path), same allow-list stance as event-field-registry.js.
 *
 * `uniqueActors` intentionally counts every ANONYMOUS event as its own distinct actor: per #90's
 * normalizer, every anonymous actor collapses to the identical `{ id: null, displayName:
 * "Anonymous" }` shape, so there is no way to know whether two anonymous events in the same batch
 * were the same person — collapsing them into one "unique actor" would be an unverifiable (and
 * mildly identity-linking) assumption, not a fact this data supports.
 */
export function summarizeAggregatedEvents(key, events) {
  const actorIds = new Set();
  let totalBits = 0;
  let totalGiftCount = 0;
  let rewardRedemptionCount = 0;
  const countsByKind = {};
  let anonymousSeq = 0;

  for (const event of events) {
    countsByKind[event?.kind] = (countsByKind[event?.kind] ?? 0) + 1;
    if (event?.actor?.isAnonymous === true) actorIds.add(`anonymous:${++anonymousSeq}`);
    else if (event?.actor?.id) actorIds.add(event.actor.id);
    if (event?.kind === "cheer" && typeof event?.data?.bits === "number") totalBits += event.data.bits;
    if (event?.kind === "gift-subscription" && typeof event?.data?.count === "number") totalGiftCount += event.data.count;
    if (event?.kind === "reward-redemption") rewardRedemptionCount += 1;
  }

  const timestamps = events.map((event) => event?.timestamp).filter(Boolean).sort();
  return Object.freeze({
    key,
    count: events.length,
    totalBits,
    totalGiftCount,
    rewardRedemptionCount,
    uniqueActors: actorIds.size,
    countsByKind: Object.freeze(countsByKind),
    firstEventAt: timestamps[0] ?? null,
    lastEventAt: timestamps[timestamps.length - 1] ?? null,
    events: Object.freeze([...events]),
  });
}

export class EventAggregator {
  constructor({ windowMs = DEFAULT_WINDOW_MS, maxBatchSize = DEFAULT_MAX_BATCH_SIZE, maxKeys = DEFAULT_MAX_KEYS, onFlush = () => {}, clock = systemClock } = {}) {
    if (!isPositiveInteger(windowMs)) throw new RangeError("EventAggregator windowMs must be a positive integer");
    if (!isPositiveInteger(maxBatchSize)) throw new RangeError("EventAggregator maxBatchSize must be a positive integer");
    this.windowMs = windowMs;
    this.maxBatchSize = maxBatchSize;
    this.maxKeys = maxKeys;
    this.onFlush = onFlush;
    this.clock = clock;
    this.generation = 0;
    this.buffers = new Map(); // key -> { events, timerId, generation, lruSeq }
    this.sequence = 0;
    this.disposed = false;
    this.flushedByTimerCount = 0;
    this.flushedByMaxCount = 0;
    this.flushedManuallyCount = 0;
    this.discardedBufferCount = 0;
    this.discardedEventCount = 0;
    this.evictedByMaxKeysCount = 0;
  }

  /**
   * Adds one event to `key`'s buffer, arming a flush timer the moment a FRESH buffer is created for
   * that key (not re-armed on every subsequent add — the window bounds time-since-FIRST-event, not
   * time-since-last, so a steady trickle within `maxBatchSize` still flushes on schedule instead of
   * being pushed back indefinitely). Flushes immediately ("flushOnMax") the instant the batch
   * reaches `maxBatchSize`.
   */
  add(key, event, now = this.clock.now()) {
    if (this.disposed) return Object.freeze({ buffered: false, flushed: false, reason: "disposed" });
    if (!key || typeof key !== "string") throw new TypeError("EventAggregator key is required");

    let buffer = this.buffers.get(key);
    if (!buffer) {
      if (this.buffers.size >= this.maxKeys) this.#evictOldest();
      const generation = this.generation;
      buffer = { events: [], timerId: null, generation, lruSeq: ++this.sequence, createdAt: now };
      buffer.timerId = this.clock.setTimeout(() => this.#onTimer(key, generation), this.windowMs);
      this.buffers.set(key, buffer);
    }
    buffer.events.push(event);
    buffer.lruSeq = ++this.sequence;

    if (buffer.events.length >= this.maxBatchSize) {
      this.#flushKey(key, "max");
      return Object.freeze({ buffered: true, flushed: true, reason: "flush-on-max" });
    }
    return Object.freeze({ buffered: true, flushed: false, reason: null });
  }

  /** Manually flushes one key's pending buffer (if any) right now. Returns true iff a buffer
   * existed and was flushed. */
  flush(key) {
    if (!this.buffers.has(key)) return false;
    this.#flushKey(key, "manual");
    return true;
  }

  /** Manually flushes every currently pending buffer. */
  flushAll() {
    for (const key of [...this.buffers.keys()]) this.#flushKey(key, "manual");
  }

  /**
   * Discards every pending buffer and timer WITHOUT calling `onFlush` — the explicit "config
   * reload/cancel時にflushせず破棄" contract. Bumps `generation` so any timer callback already
   * queued on the event loop for the OLD generation still no-ops even though its `clock.clearTimeout`
   * call already ran (belt-and-suspenders against the same-tick race described in the module doc
   * comment).
   */
  cancel() {
    this.generation += 1;
    for (const buffer of this.buffers.values()) {
      if (buffer.timerId !== null) this.clock.clearTimeout(buffer.timerId);
      this.discardedEventCount += buffer.events.length;
    }
    this.discardedBufferCount += this.buffers.size;
    this.buffers.clear();
  }

  /** Permanent teardown — discards (never flushes), then refuses any further `add()`. */
  dispose() {
    this.cancel();
    this.disposed = true;
  }

  stats() {
    return Object.freeze({
      pendingKeys: this.buffers.size,
      maxKeys: this.maxKeys,
      pendingEvents: [...this.buffers.values()].reduce((sum, buffer) => sum + buffer.events.length, 0),
      flushedByTimer: this.flushedByTimerCount,
      flushedByMax: this.flushedByMaxCount,
      flushedManually: this.flushedManuallyCount,
      discardedBuffers: this.discardedBufferCount,
      discardedEvents: this.discardedEventCount,
      evictedByMaxKeys: this.evictedByMaxKeysCount,
    });
  }

  #onTimer(key, generation) {
    if (generation !== this.generation) return; // superseded by cancel() — discard, never flush late
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.generation !== generation) return;
    this.#flushKey(key, "timer");
  }

  #flushKey(key, cause) {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    if (buffer.timerId !== null) this.clock.clearTimeout(buffer.timerId);
    this.buffers.delete(key);
    if (cause === "timer") this.flushedByTimerCount += 1;
    else if (cause === "max") this.flushedByMaxCount += 1;
    else if (cause === "manual") this.flushedManuallyCount += 1;
    const summary = summarizeAggregatedEvents(key, buffer.events);
    this.onFlush(summary, { cause });
  }

  /**
   * Bounds the number of DISTINCT concurrently-buffering keys (e.g. many different reward ids all
   * mid-window at once) — a different failure mode from `maxBatchSize`, which bounds one key's own
   * batch. Unlike `cancel()`, evicting here is NOT a config-reload/cancel event — the evicted
   * buffer's own window/max simply hasn't elapsed yet, so its events are still organic, in-progress
   * data, and dropping them silently would be worse than flushing them a little early. The oldest
   * (least-recently-touched) buffer is therefore FLUSHED, not discarded.
   */
  #evictOldest() {
    let oldestKey = null;
    let oldestSeq = Infinity;
    for (const [key, buffer] of this.buffers) {
      if (buffer.lruSeq < oldestSeq) {
        oldestSeq = buffer.lruSeq;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    this.evictedByMaxKeysCount += 1;
    this.#flushKey(oldestKey, "max-keys-eviction");
  }
}
