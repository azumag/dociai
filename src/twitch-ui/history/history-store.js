// Issue #96: Renderer-side bounded history combining production events (synced from the
// Main-process StreamEventBus's own bounded history — see electron/main/services/stream-events/
// stream-event-history.ts, consumed here via `dociai.streamEvents.{list,clear}` + the "stream-event"
// push, #89) with simulation runs (which never touch the Main-process bus at all — #93's
// `simulateStreamEvent()` runs entirely in this Renderer, see src/simulation/stream-event-simulator.js
// — so THIS is the only place a simulation run is ever recorded anywhere).
//
// Deliberately NOT a second re-implementation of stream-event-history.ts's own byte-size-bounded
// trim math — that trimming is already solved, once, as the Main-process bus's own source of truth
// for production events (this store just consumes its already-trimmed snapshot/pushes). What THIS
// store bounds is its own combined (production + simulation + trace/status) view, which holds more
// than a raw StreamEvent (a status, an optional trace, prompt previews) and includes simulation
// entries the Main-process history never sees at all — so it follows the same established
// count-bounded "push, then trim the oldest once over the limit" idiom as
// src/triggers/trigger-trace.js's `TriggerTraceBuffer` / src/health/health-registry.js's own bounded
// `history` array, extended with simple update-by-id support (append-only ring buffers in this repo
// don't otherwise need in-place update; this store does, for the "pending -> handled/skipped/failed"
// status transition — see `updateStatus()` below).
//
// STATUS NOTE: no Main-process consumer in this app yet actually runs the #91/#93 matcher/planner/
// runner pipeline against a REAL production StreamEvent (only this Renderer's simulation path does,
// via `recordSimulation()`) — see this issue's own PR body for why that's out of scope here. A
// production entry is therefore recorded as "pending" and currently has no path that ever
// transitions it further; `updateStatus()` exists (and is directly tested) so a future consumer that
// DOES wire the real pipeline to production events has a ready-made, already-correct hook to call.
export const DEFAULT_HISTORY_MAX_ENTRIES = 500;

/** Derives a simulation run's history status purely from `simulateStreamEvent()`'s own real result
 * shape (`{ ok, matches, results }`) — never a second guess at what "handled" means, just reads the
 * real matcher/runner outcome. `"failed"` takes priority over `"handled"` when a run produced BOTH
 * (an operator needs to see the failure, not have it hidden behind an unrelated success). */
export function deriveSimulationStatus(result) {
  if (!result || result.ok === false) return "failed";
  const matches = Array.isArray(result.matches) ? result.matches : [];
  if (matches.length === 0) return "skipped";
  const executions = Array.isArray(result.results) ? result.results : [];
  if (executions.some((entry) => entry?.status === "fallback" || entry?.error)) return "failed";
  if (executions.some((entry) => entry?.status === "executed")) return "handled";
  return "skipped";
}

function keyFor(context, eventId) {
  return `${context}:${eventId}`;
}

export class EventHistoryStore {
  constructor({ maxEntries = DEFAULT_HISTORY_MAX_ENTRIES, clock = () => Date.now() } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("EventHistoryStore maxEntries must be a positive integer");
    this.maxEntries = maxEntries;
    this.clock = clock;
    this.entries = [];
    this.byKey = new Map();
    this.sequence = 0;
  }

  #trim() {
    while (this.entries.length > this.maxEntries) {
      const removed = this.entries.shift();
      if (removed) this.byKey.delete(removed.id);
    }
  }

  #replaceEntries(kept) {
    this.entries = kept;
    this.byKey = new Map(kept.map((entry) => [entry.id, entry]));
  }

  /** Records one production `PublishedStreamEvent` (`{ context: "production", publishedAtMs, event
   * }`, the exact shape both `dociai.streamEvents.list()`'s snapshot entries and the live
   * "stream-event" push deliver). Idempotent by `(context, event.id)` — calling this twice for the
   * same event (e.g. the initial snapshot fetch and a live push racing/overlapping on the same
   * event, both legitimate per #89's own delivery guarantees) is a no-op the second time, "event
   * 同期を実装" without ever duplicating a row. Returns the (possibly pre-existing) entry, or `null`
   * for a malformed input. */
  recordProduction(published) {
    const event = published?.event;
    if (!event?.id) return null;
    const id = keyFor("production", event.id);
    const existing = this.byKey.get(id);
    if (existing) return existing;
    const entry = Object.freeze({
      id,
      seq: ++this.sequence,
      event,
      context: "production",
      receivedAtMs: typeof published.publishedAtMs === "number" ? published.publishedAtMs : this.clock(),
      status: "pending",
      trace: null,
      promptPreviews: Object.freeze([]),
    });
    this.entries.push(entry);
    this.byKey.set(id, entry);
    this.#trim();
    return entry;
  }

  /** Records one COMPLETE simulation run (`event` + the real `simulateStreamEvent()` `result`, plus
   * any `promptPreviews` the caller already built via `buildStreamEventContext()` for this run's
   * ai-response plans — see src/twitch-ui/views/simulation.js). Unlike `recordProduction()`, a
   * simulation entry is always fully resolved (status derived immediately via
   * `deriveSimulationStatus()`) since `simulateStreamEvent()` never returns a partial/pending
   * result. */
  recordSimulation({ event, result, promptPreviews = [], now } = {}) {
    if (!event) return null;
    const eventId = event.id ?? `sim-unnamed-${this.sequence + 1}`;
    const id = `${keyFor("simulation", eventId)}:${this.sequence + 1}`;
    const entry = Object.freeze({
      id,
      seq: ++this.sequence,
      event,
      context: "simulation",
      receivedAtMs: typeof now === "number" ? now : this.clock(),
      status: deriveSimulationStatus(result),
      trace: result ?? null,
      promptPreviews: Object.freeze([...promptPreviews]),
    });
    this.entries.push(entry);
    this.byKey.set(id, entry);
    this.#trim();
    return entry;
  }

  /** Updates an existing entry's status/trace/promptPreviews in place, by store `id` — the hook a
   * future "real production trigger pipeline" consumer would call to transition a `"pending"` entry
   * onward (see this module's own header comment for why nothing in this app calls it yet). Returns
   * the updated (new, frozen) entry, or `null` if `id` isn't currently held. */
  updateStatus(id, { status, trace, promptPreviews } = {}) {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    const previous = this.entries[index];
    const updated = Object.freeze({
      ...previous,
      status: status ?? previous.status,
      trace: trace !== undefined ? trace : previous.trace,
      promptPreviews: promptPreviews ? Object.freeze([...promptPreviews]) : previous.promptPreviews,
    });
    this.entries[index] = updated;
    this.byKey.set(id, updated);
    return updated;
  }

  /** Oldest-first snapshot — a shallow copy, so a caller (a view's render pass) can never mutate the
   * store's own internal array. */
  list() {
    return [...this.entries];
  }

  get(id) {
    return this.byKey.get(id) ?? null;
  }

  stats() {
    return Object.freeze({
      size: this.entries.length,
      maxEntries: this.maxEntries,
      production: this.entries.filter((entry) => entry.context === "production").length,
      simulation: this.entries.filter((entry) => entry.context === "simulation").length,
    });
  }

  /**
   * Clears entries per an operator-chosen scope — "clear history対象を確認dialogで選択":
   *   - `"all"` (default): every entry.
   *   - `"production"` / `"simulation"`: only entries of that context.
   *   - `{ olderThanMs }`: every entry received more than `olderThanMs` milliseconds ago, regardless
   *     of context.
   * Returns the number of entries removed. Never throws on an unrecognized scope (a no-op, 0
   * removed) — a confirmation dialog driving this should only ever pass one of the shapes above.
   */
  clear(scope = "all") {
    const before = this.entries.length;
    if (scope === "all") {
      this.entries = [];
      this.byKey.clear();
      return before;
    }
    if (scope === "production" || scope === "simulation") {
      this.#replaceEntries(this.entries.filter((entry) => entry.context !== scope));
      return before - this.entries.length;
    }
    if (scope && typeof scope === "object" && Number.isFinite(scope.olderThanMs)) {
      const cutoff = this.clock() - scope.olderThanMs;
      this.#replaceEntries(this.entries.filter((entry) => entry.receivedAtMs >= cutoff));
      return before - this.entries.length;
    }
    return 0;
  }
}
