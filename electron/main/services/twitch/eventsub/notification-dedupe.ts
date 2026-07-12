// Issue #88: "message_id TTL/LRU dedupeをold/new sessionで共有" — a bounded membership cache keyed
// by Twitch's EventSub `metadata.message_id`, shared by every socket the reconnect coordinator is
// currently juggling (the "current" session, and during a specified reconnect's overlap window,
// both the retiring old session and the candidate new one) so the SAME notification delivered
// twice (once per socket) is forwarded to the app exactly once.
//
// "#59系のbounded primitiveと揃える" — mirrors src/personas/response-budget-tracker.js's own
// TTL+LRU bounding approach one-for-one (that file is this repo's own established "bound a
// long-lived Map so it can never grow unbounded" primitive, added for "PersonaRouter の応答履歴を
// 上限制御する"): a monotonic `lruSeq` on every entry (touched on every access, including a
// duplicate hit) selects eviction order, expiry is TTL-based and checked lazily on read (never a
// background timer of its own), and `maxEntries` is enforced by evicting the LOWEST `lruSeq` entry
// whenever a fresh insert would exceed it. Kept intentionally simpler than ResponseBudgetTracker
// (no reserve/commit/release two-phase bookkeeping — a dedupe cache only ever needs "have I seen
// this id" + "record it"), but the expiry/eviction MECHANICS are the same shape on purpose, per the
// issue's own instruction to keep this consistent with #92's future dedupe needs too.
import type { Clock } from "./keepalive-watchdog";
import { systemClock } from "./keepalive-watchdog";

/** Twitch redelivers a notification at most within its own short retry window (session_reconnect's
 * overlap, or Twitch's own at-least-once delivery retries) — a few minutes is generous headroom
 * over that without holding message ids indefinitely. Our own defensive default, not a number
 * Twitch documents. */
export const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1000;

/** This app subscribes to at most 5 EventSub types (desired-subscriptions.ts) at a modest event
 * rate — a few thousand entries is already far more than any realistic reconnect-overlap window
 * could produce, while still bounding memory against a misbehaving/duplicating relay. */
export const DEFAULT_DEDUPE_MAX_ENTRIES = 2_000;

export type NotificationDedupeDeps = { clock?: Clock; ttlMs?: number; maxEntries?: number };

export type NotificationDedupeStats = {
  size: number;
  duplicates: number;
  evictedByTtl: number;
  evictedByLimit: number;
};

type Entry = { expiresAtMs: number; lruSeq: number };

export class NotificationDedupe {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry>();
  #sequence = 0;
  #duplicates = 0;
  #evictedByTtl = 0;
  #evictedByLimit = 0;

  constructor(deps: NotificationDedupeDeps = {}) {
    this.#clock = deps.clock ?? systemClock;
    this.#ttlMs = deps.ttlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.#maxEntries = deps.maxEntries ?? DEFAULT_DEDUPE_MAX_ENTRIES;
  }

  /** True the FIRST time `messageId` is seen (and records it); false for a duplicate still within
   * its TTL window — the caller is expected to deliver on true and drop (incrementing its own
   * duplicate-drop diagnostic) on false. A duplicate hit still touches the entry's LRU position and
   * refreshes its TTL, so a message id that keeps arriving (e.g. genuinely redelivered several
   * times in a row) survives at least as long as the busiest keys, exactly like
   * ResponseBudgetTracker's #touch() on every access. */
  shouldDeliver(messageId: string, nowMs: number = this.#clock.now()): boolean {
    const existing = this.#entries.get(messageId);
    if (existing && existing.expiresAtMs > nowMs) {
      this.#duplicates += 1;
      this.#touch(existing, nowMs);
      return false;
    }
    if (existing) {
      // Present but expired — falls through to a fresh insert below; not double-counted as an
      // eviction (TTL expiry, not a limit-driven eviction of a live entry).
      this.#entries.delete(messageId);
    }
    this.#makeRoom(nowMs);
    this.#entries.set(messageId, { expiresAtMs: nowMs + this.#ttlMs, lruSeq: ++this.#sequence });
    return true;
  }

  /** "dedupe TTL/LRU上限" diagnostics — exposed for reconnect-coordinator.ts's own snapshot/UI
   * surface (see the issue's "duplicate counterとdrop reasonをdiagnosticへ追加"). */
  get stats(): NotificationDedupeStats {
    return { size: this.#entries.size, duplicates: this.#duplicates, evictedByTtl: this.#evictedByTtl, evictedByLimit: this.#evictedByLimit };
  }

  /** Best-effort sweep of expired entries — never required for correctness (shouldDeliver() always
   * lazily re-checks expiry on the exact key it cares about), but keeps `stats.size` an honest
   * reflection of live entries for a caller that polls it between notifications rather than driving
   * shouldDeliver() itself. */
  sweep(nowMs: number = this.#clock.now()): void {
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
