// Issue #79: remembers which (modelId, plan-shape) combination just failed with which resource-
// shaped error code, so a subsequent ensureLoaded() call for the exact same model+plan doesn't
// blindly retry into the same failure forever ("同じplanの無限retryを抑制").
//
// Scope: only the three codes local-llm-errors.ts (#45) actually reports for a *resource-shape*
// failure (retrying the identical plan would fail the identical way) are tracked — OUT_OF_MEMORY,
// BACKEND_INIT_FAILED, CONTEXT_CREATE_FAILED. Every other LocalLlmErrorCode (MODEL_NOT_FOUND,
// INVALID_REQUEST, ...) is deliberately never recorded here: those aren't "this plan doesn't fit
// this hardware" failures, so suppressing a retry would just be wrong.
const TRACKED_FAILURE_CODES: ReadonlySet<string> = new Set(["OUT_OF_MEMORY", "BACKEND_INIT_FAILED", "CONTEXT_CREATE_FAILED"]);

export function isTrackedFailureCode(code: string): boolean {
  return TRACKED_FAILURE_CODES.has(code);
}

export type RecordedFailure = {
  modelId: string;
  /** Caller-computed identity of the runtime plan that failed (model-residency-manager.ts's
   * `planKey()`) — this module never needs to know the plan's actual shape, only that two calls
   * asked for the "same" one. */
  planKey: string;
  code: string;
  message: string;
  firstFailedAtMs: number;
  lastFailedAtMs: number;
  /** How many times ensureLoaded() has hit this exact failure back-to-back (bumped by record(),
   * reset by forget()/a successful load for this key). */
  attempts: number;
};

export type RuntimeFailureHistoryDeps = {
  now?: () => number;
  /** Bounds memory growth across a long-running app session that tries many distinct models/plans
   * over time — oldest entry (by last-touched order) is evicted once exceeded. Never grows
   * unbounded ("10回switch後resource増加傾向なし"). */
  maxEntries?: number;
};

const DEFAULT_MAX_ENTRIES = 50;

function entryKey(modelId: string, planKey: string): string {
  return `${modelId}::${planKey}`;
}

/** Pure bookkeeping — no timers, no I/O. model-residency-manager.ts is the only caller: it records
 * a failure right after a tracked-code load error, looks failures up before attempting a load, and
 * forgets an entry once that exact model+plan loads successfully. */
export class RuntimeFailureHistory {
  readonly #now: () => number;
  readonly #maxEntries: number;
  // Map iteration order is insertion order; record() deletes-then-re-inserts on every touch so the
  // least-recently-touched entry is always the first one, which is what the eviction below relies
  // on (a simple LRU via Map, not a needless separate tracking structure).
  #entries = new Map<string, RecordedFailure>();

  constructor(deps: RuntimeFailureHistoryDeps = {}) {
    this.#now = deps.now ?? (() => Date.now());
    this.#maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Returns the recorded entry, or `null` if `code` isn't one of the tracked resource-shape codes
   * (nothing to remember). */
  record(modelId: string, planKey: string, code: string, message: string): RecordedFailure | null {
    if (!TRACKED_FAILURE_CODES.has(code)) return null;
    const key = entryKey(modelId, planKey);
    const existing = this.#entries.get(key);
    const now = this.#now();
    const entry: RecordedFailure = existing
      ? { ...existing, code, message, lastFailedAtMs: now, attempts: existing.attempts + 1 }
      : { modelId, planKey, code, message, firstFailedAtMs: now, lastFailedAtMs: now, attempts: 1 };
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (this.#entries.size > this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey !== undefined) this.#entries.delete(oldestKey);
    }
    return entry;
  }

  lookup(modelId: string, planKey: string): RecordedFailure | null {
    return this.#entries.get(entryKey(modelId, planKey)) ?? null;
  }

  /** Called after a successful load for this exact (modelId, planKey) — the plan clearly fits now
   * (hardware/model file may have changed since the last failure), so any memory of it failing is
   * stale. Also the manual "forget and retry anyway" seam. */
  forget(modelId: string, planKey: string): void {
    this.#entries.delete(entryKey(modelId, planKey));
  }

  forgetModel(modelId: string): void {
    const prefix = `${modelId}::`;
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  snapshot(): RecordedFailure[] {
    return [...this.#entries.values()];
  }
}
