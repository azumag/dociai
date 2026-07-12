// Issue #89: "event ID TTL/LRU dedupeを実装" — a bounded membership cache keyed by StreamEvent.id,
// so the SAME event published twice in a short window (e.g. a future normalizer re-delivering a
// notification, or a caller retrying a publish after an ambiguous failure) reaches every
// subscriber exactly once.
//
// Deliberately independent of electron/main/services/twitch/eventsub/notification-dedupe.ts (this
// issue is explicitly Twitch-EventSub-independent) but mirrors its TTL+LRU MECHANICS one-for-one,
// which in turn mirrors src/personas/response-budget-tracker.js's own bounding approach — this
// repo's established "bound a long-lived Map so it can never grow unbounded" primitive. A
// monotonic `lruSeq` on every entry (touched on every access, including a duplicate hit) selects
// eviction order; expiry is TTL-based and checked lazily on read (never a background timer of its
// own); `maxEntries` is enforced by evicting the LOWEST `lruSeq` entry on a fresh insert that would
// exceed it. Kept intentionally simple (no reserve/commit/release two-phase bookkeeping — a dedupe
// cache only ever needs "have I seen this id" + "record it"), per the issue's own instruction that
// #92 (not yet implemented) is expected to need the same shared idiom again.

/** A short window is enough to absorb a retried/re-delivered publish of the same event without
 * holding ids indefinitely. Our own defensive default, not tied to any platform's documented
 * redelivery window. */
export const DEFAULT_EVENT_DEDUPE_TTL_MS = 5 * 60 * 1000;

/** Far more than any realistic short-window duplicate burst could produce, while still bounding
 * memory against a misbehaving producer that mints the same id repeatedly. */
export const DEFAULT_EVENT_DEDUPE_MAX_ENTRIES = 2_000;

export type EventIdDedupeDeps = { clock?: () => number; ttlMs?: number; maxEntries?: number };

export type EventIdDedupeStats = {
  size: number;
  duplicates: number;
  evictedByTtl: number;
  evictedByLimit: number;
};

type Entry = { expiresAtMs: number; lruSeq: number };

export class EventIdDedupe {
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry>();
  #sequence = 0;
  #duplicates = 0;
  #evictedByTtl = 0;
  #evictedByLimit = 0;

  constructor(deps: EventIdDedupeDeps = {}) {
    this.#clock = deps.clock ?? (() => Date.now());
    this.#ttlMs = deps.ttlMs ?? DEFAULT_EVENT_DEDUPE_TTL_MS;
    this.#maxEntries = deps.maxEntries ?? DEFAULT_EVENT_DEDUPE_MAX_ENTRIES;
  }

  /** True the FIRST time `eventId` is seen (and records it); false for a duplicate still within
   * its TTL window — the caller (stream-event-bus.ts) delivers to subscribers on true and drops
   * (counted in `stats.duplicates`) on false. A duplicate hit still touches the entry's LRU
   * position and refreshes its TTL, exactly like ResponseBudgetTracker's #touch() on every
   * access. */
  shouldDeliver(eventId: string, nowMs: number = this.#clock()): boolean {
    const existing = this.#entries.get(eventId);
    if (existing && existing.expiresAtMs > nowMs) {
      this.#duplicates += 1;
      this.#touch(existing, nowMs);
      return false;
    }
    if (existing) {
      // Present but expired — falls through to a fresh insert; not double-counted as a
      // limit-driven eviction of a still-live entry.
      this.#entries.delete(eventId);
    }
    this.#makeRoom(nowMs);
    this.#entries.set(eventId, { expiresAtMs: nowMs + this.#ttlMs, lruSeq: ++this.#sequence });
    return true;
  }

  get stats(): EventIdDedupeStats {
    return { size: this.#entries.size, duplicates: this.#duplicates, evictedByTtl: this.#evictedByTtl, evictedByLimit: this.#evictedByLimit };
  }

  /** Best-effort sweep of expired entries — never required for correctness (shouldDeliver()
   * always lazily re-checks expiry on the exact key it cares about), but keeps `stats.size` an
   * honest reflection of live entries for a caller that polls it between publishes. */
  sweep(nowMs: number = this.#clock()): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAtMs <= nowMs) {
        this.#entries.delete(key);
        this.#evictedByTtl += 1;
      }
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  #touch(entry: Entry, nowMs: number): void {
    entry.expiresAtMs = nowMs + this.#ttlMs;
    entry.lruSeq = ++this.#sequence;
  }

  #makeRoom(nowMs: number): void {
    this.sweep(nowMs);
    while (this.#entries.size >= this.#maxEntries) {
      let oldestKey: string | null = null;
      let oldestSeq = Infinity;
      for (const [key, entry] of this.#entries) {
        if (entry.lruSeq < oldestSeq) {
          oldestSeq = entry.lruSeq;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.#entries.delete(oldestKey);
      this.#evictedByLimit += 1;
    }
  }
}
