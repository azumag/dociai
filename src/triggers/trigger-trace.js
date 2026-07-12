// Issue #91: bounded ring buffer for recent EventTriggerConfig MatchResults (see
// event-trigger-matcher.js's own buildResult()) — a diagnostic-UI feed of "why did/didn't trigger
// X fire for event Y", bounded so it can never grow unbounded across a long-running session.
//
// This repo already has an established "bound a long-lived collection, evict the oldest entry once
// full" family: src/personas/response-budget-tracker.js (the foundational TTL+LRU bounded-Map
// primitive), reused one-for-one by electron/main/services/twitch/eventsub/notification-dedupe.ts
// (#88) and electron/main/services/stream-events/event-id-dedupe.ts (#89) — all three keep a
// monotonic `lruSeq`/sequence counter per entry for stable ordering/debuggability. A MatchResult
// trace is simpler than any of those (a fixed-size FIFO history, not a TTL membership cache — a
// duplicate entry is never "the same trace" the way a duplicate event id is), so its closest
// existing shape in this repo is actually src/health/health-registry.js's own bounded `history`
// array (`push`, then `splice` off the front once over `maxHistory`). This module follows THAT
// push/trim mechanic, while still keeping the monotonic `seq` stamp on every recorded entry for
// the same reason the TTL/LRU family does — stable ordering and easy debugging/log correlation.
const DEFAULT_MAX_ENTRIES = 200;

export class TriggerTraceBuffer {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, clock = () => Date.now() } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("TriggerTraceBuffer maxEntries must be a positive integer");
    this.maxEntries = maxEntries;
    this.clock = clock;
    this.entries = [];
    this.sequence = 0;
    this.totalRecorded = 0;
    this.evictedByLimit = 0;
  }

  /** Appends one MatchResult (or any plain-object trace entry) to the buffer, stamping it with a
   * monotonic `seq` and `recordedAt`. Evicts the OLDEST entries once over `maxEntries` — never
   * throws, the buffer can never grow past its bound. Returns the stamped (frozen) entry. */
  record(entry) {
    const stamped = Object.freeze({ ...entry, seq: ++this.sequence, recordedAt: this.clock() });
    this.entries.push(stamped);
    this.totalRecorded++;
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
      this.evictedByLimit++;
    }
    return stamped;
  }

  /** All currently-held entries, oldest first — a shallow copy, so a caller can never mutate the
   * buffer's own internal array. */
  list() {
    return [...this.entries];
  }

  /** The most recently recorded `limit` entries, newest first — the shape a diagnostic UI's
   * "recent activity" feed typically wants. */
  recent(limit = this.entries.length) {
    return [...this.entries].slice(-limit).reverse();
  }

  stats() {
    return Object.freeze({ size: this.entries.length, maxEntries: this.maxEntries, totalRecorded: this.totalRecorded, evictedByLimit: this.evictedByLimit });
  }

  clear() {
    this.entries = [];
  }
}
