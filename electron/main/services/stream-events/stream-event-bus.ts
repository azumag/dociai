// Issue #89: the bounded, single fan-out `StreamEventBus` — publish-time runtime validation
// (including the raw-payload-escape-hatch guard), short-window dedupe, bounded history, and
// listener-exception isolation, all in one place so every subscriber category (a future Trigger
// engine per #91/#92, the console window, the OBS window — all wired up in electron/main/index.ts)
// observes the identical validated/deduped event stream.
//
// Main-process bus, but the `StreamEvent` contract itself lives in src/stream-events/ (pure JS,
// same "src/*.js importable from both Browser and Main-process TS" pattern src/config/*.js
// already established for #64's config core — see src/stream-events/contract.d.ts's doc comment
// for exactly how a `.js`-suffixed relative import here resolves to a real TS type at compile
// time via a colocated `.d.ts`, while esbuild bundles the actual `contract.js`/`schemas.js` at
// runtime, same as scripts/electron/build.mjs already does for src/config/*.js).
import type { StreamEvent, StreamEventIssue } from "../../../../src/stream-events/contract.js";
import { validateStreamEvent } from "../../../../src/stream-events/schemas.js";
import { EventIdDedupe, DEFAULT_EVENT_DEDUPE_MAX_ENTRIES, DEFAULT_EVENT_DEDUPE_TTL_MS } from "./event-id-dedupe";
import type { EventIdDedupeStats } from "./event-id-dedupe";
import { StreamEventHistory, DEFAULT_HISTORY_MAX_ENTRIES, DEFAULT_HISTORY_MAX_TOTAL_CHARS } from "./stream-event-history";
import type { StreamEventContext, StreamEventHistoryEntry } from "./stream-event-history";

export type { StreamEventContext, StreamEventHistoryEntry } from "./stream-event-history";
export { DEFAULT_EVENT_DEDUPE_MAX_ENTRIES, DEFAULT_EVENT_DEDUPE_TTL_MS } from "./event-id-dedupe";
export { DEFAULT_HISTORY_MAX_ENTRIES, DEFAULT_HISTORY_MAX_TOTAL_CHARS } from "./stream-event-history";

/** The wrapper metadata every consumer actually receives — "production/simulation contextを
 * wrapper metadataで区別": deliberately OUTSIDE the StreamEvent payload itself (per the issue: a
 * future simulation/test UI, #96, injects synthetic events without them being confused for real
 * ones, but the StreamEvent domain type itself stays clean of any test-only field). */
export type PublishedStreamEvent = { context: StreamEventContext; publishedAtMs: number; event: StreamEvent };

export type StreamEventListener = (published: PublishedStreamEvent) => void;

export type PublishResult =
  | { ok: true; delivered: true; duplicate: false; event: StreamEvent }
  | { ok: true; delivered: false; duplicate: true; event: StreamEvent }
  | { ok: false; issues: readonly StreamEventIssue[] };

export type StreamEventBusStats = {
  totalPublished: number;
  totalRejected: number;
  totalDuplicates: number;
  listenerCount: number;
  dedupe: EventIdDedupeStats;
  history: { size: number; totalChars: number; trimmedByCount: number; trimmedByChars: number };
};

export type StreamEventBusDeps = {
  clock?: () => number;
  dedupeTtlMs?: number;
  dedupeMaxEntries?: number;
  historyMaxEntries?: number;
  historyMaxTotalChars?: number;
  /** Called (never thrown out of publish()) whenever a subscriber's listener throws — defaults to
   * a console.error, matching electron/main/index.ts's own `logError` convention. Overridable so
   * tests can assert isolation without polluting test output. */
  onListenerError?: (error: unknown, published: PublishedStreamEvent) => void;
};

function defaultOnListenerError(error: unknown, published: PublishedStreamEvent): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[dociai:stream-event-bus] listener threw for event ${published.event.id} (${published.event.kind})`, message);
}

/** Recursively freezes `value` so a published event (shared by reference across every listener AND
 * retained in history) can never be mutated by one subscriber in a way that leaks to another or
 * corrupts history — mirrors this repo's existing freeze-heavy contract style (see
 * src/config/config-contract.js's `issue()`/electron/preload/index.ts's own `deepFreeze`). */
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

export class StreamEventBus {
  readonly #clock: () => number;
  readonly #dedupe: EventIdDedupe;
  readonly #history: StreamEventHistory;
  readonly #listeners = new Set<StreamEventListener>();
  readonly #onListenerError: (error: unknown, published: PublishedStreamEvent) => void;
  #totalPublished = 0;
  #totalRejected = 0;
  #totalDuplicates = 0;

  constructor(deps: StreamEventBusDeps = {}) {
    this.#clock = deps.clock ?? (() => Date.now());
    this.#dedupe = new EventIdDedupe({ clock: this.#clock, ttlMs: deps.dedupeTtlMs, maxEntries: deps.dedupeMaxEntries });
    this.#history = new StreamEventHistory({ maxEntries: deps.historyMaxEntries, maxTotalChars: deps.historyMaxTotalChars });
    this.#onListenerError = deps.onListenerError ?? defaultOnListenerError;
  }

  /** Validates (schema shape + the raw-payload-escape-hatch guard — see schemas.js's
   * validateStreamEvent()), dedupes by `event.id` within the short TTL window, records into
   * bounded history, and fans the SAME published wrapper out to every current subscriber — one
   * throwing listener is caught and reported via `onListenerError`, never stops delivery to the
   * remaining listeners, and never propagates out of publish() itself. Never throws. */
  publish(candidateEvent: StreamEvent, context: StreamEventContext = "production"): PublishResult {
    const validation = validateStreamEvent(candidateEvent);
    if (!validation.ok) {
      this.#totalRejected += 1;
      return { ok: false, issues: validation.issues };
    }
    const event = validation.event;
    const nowMs = this.#clock();

    if (!this.#dedupe.shouldDeliver(event.id, nowMs)) {
      this.#totalDuplicates += 1;
      return { ok: true, delivered: false, duplicate: true, event };
    }

    const published = deepFreeze({ context, publishedAtMs: nowMs, event });
    this.#history.record(published.event, published.context, published.publishedAtMs);
    this.#totalPublished += 1;

    for (const listener of [...this.#listeners]) {
      try {
        listener(published);
      } catch (error) {
        this.#onListenerError(error, published);
      }
    }

    return { ok: true, delivered: true, duplicate: false, event };
  }

  /** Registers a subscriber; returns an unsubscribe function. Multiple independent subscriber
   * categories (Trigger engine, console window forwarder, OBS window forwarder) each call this
   * once and all receive the identical published event — this is the bus's single fan-out
   * point. */
  subscribe(listener: StreamEventListener): () => void {
    this.#listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.#listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Most-recent-last snapshot of bounded history, for the snapshot/list IPC — a freshly-opened
   * console/OBS window replays this once instead of only ever seeing events published from that
   * moment on. */
  list(limit?: number): PublishedStreamEvent[] {
    return this.#history.list(limit).map(({ event, context, publishedAtMs }) => ({ event, context, publishedAtMs }));
  }

  get stats(): StreamEventBusStats {
    return {
      totalPublished: this.#totalPublished,
      totalRejected: this.#totalRejected,
      totalDuplicates: this.#totalDuplicates,
      listenerCount: this.#listeners.size,
      dedupe: this.#dedupe.stats,
      history: this.#history.stats,
    };
  }

  /** Issue #96: clears ONLY the bounded history (the "recent events" replay buffer a freshly-opened
   * console/OBS window snapshots via `list()`) — deliberately narrower than `dispose()`, which also
   * tears down listeners/dedupe and is reserved for app shutdown. Lets the Event History UI's
   * "clear history" action (scoped to "all", including production) empty the shared replay buffer
   * without disturbing live subscriptions (Trigger engine / console window / OBS window keep
   * receiving new events exactly as before). Never throws. */
  clearHistory(): void {
    this.#history.clear();
  }

  dispose(): void {
    this.#listeners.clear();
    this.#history.clear();
    this.#dedupe.clear();
  }
}
