// Issue #89: "recent historyを件数/文字量でbounded化" — a bounded ring of recently-published
// events for the snapshot/list IPC (a freshly-opened console/OBS window needs to see what already
// happened, not just events published from now on). Bounded on TWO independent axes at once —
// entry COUNT and total approximate CHARACTER size — because a small number of pathologically
// large events (e.g. a long resub message) could otherwise blow past a reasonable memory budget
// even while comfortably under the entry-count limit, and vice versa.
import type { StreamEvent } from "../../../../src/stream-events/contract.js";

export type StreamEventContext = "production" | "simulation";

export type StreamEventHistoryEntry = {
  event: StreamEvent;
  context: StreamEventContext;
  publishedAtMs: number;
  approxChars: number;
};

/** Comfortably more than any realistic UI needs to render at once, while still bounding memory
 * for a long-lived process. */
export const DEFAULT_HISTORY_MAX_ENTRIES = 500;

/** ~a few hundred bytes per typical event times DEFAULT_HISTORY_MAX_ENTRIES, generous headroom
 * over that for a mix of larger events (long chat/resub messages) without ever needing to hold
 * the full JSON of thousands of events in memory. Our own defensive default. */
export const DEFAULT_HISTORY_MAX_TOTAL_CHARS = 500_000;

export type StreamEventHistoryDeps = { maxEntries?: number; maxTotalChars?: number };

function approxCharSize(event: StreamEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}

export class StreamEventHistory {
  readonly #maxEntries: number;
  readonly #maxTotalChars: number;
  #entries: StreamEventHistoryEntry[] = [];
  #totalChars = 0;
  #trimmedByCount = 0;
  #trimmedByChars = 0;

  constructor(deps: StreamEventHistoryDeps = {}) {
    this.#maxEntries = deps.maxEntries ?? DEFAULT_HISTORY_MAX_ENTRIES;
    this.#maxTotalChars = deps.maxTotalChars ?? DEFAULT_HISTORY_MAX_TOTAL_CHARS;
  }

  record(event: StreamEvent, context: StreamEventContext, publishedAtMs: number): void {
    const approxChars = approxCharSize(event);
    this.#entries.push({ event, context, publishedAtMs, approxChars });
    this.#totalChars += approxChars;
    this.#trim();
  }

  /** Most-recent-last. `limit` (default: everything currently retained) caps how many of the most
   * recent entries are returned. */
  list(limit?: number): StreamEventHistoryEntry[] {
    if (limit === undefined || limit >= this.#entries.length) return [...this.#entries];
    return this.#entries.slice(Math.max(0, this.#entries.length - limit));
  }

  get size(): number {
    return this.#entries.length;
  }

  get totalChars(): number {
    return this.#totalChars;
  }

  get stats(): { size: number; totalChars: number; trimmedByCount: number; trimmedByChars: number } {
    return { size: this.#entries.length, totalChars: this.#totalChars, trimmedByCount: this.#trimmedByCount, trimmedByChars: this.#trimmedByChars };
  }

  clear(): void {
    this.#entries = [];
    this.#totalChars = 0;
  }

  #trim(): void {
    while (this.#entries.length > this.#maxEntries) {
      const removed = this.#entries.shift();
      if (!removed) break;
      this.#totalChars -= removed.approxChars;
      this.#trimmedByCount += 1;
    }
    // The most-recently-recorded entry always survives, even if its own size alone exceeds
    // maxTotalChars — a single pathologically large event (e.g. a very long resub message) should
    // shrink history down to "just that one", not empty it out entirely and then immediately
    // re-empty on every subsequent record().
    while (this.#totalChars > this.#maxTotalChars && this.#entries.length > 1) {
      const removed = this.#entries.shift();
      if (!removed) break;
      this.#totalChars -= removed.approxChars;
      this.#trimmedByChars += 1;
    }
  }
}
