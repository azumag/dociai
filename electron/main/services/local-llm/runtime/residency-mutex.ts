// Issue #79: serializes ModelResidencyManager's load/unload/switch operations onto a single queue
// so at most one of them ever mutates residency state at a time.
//
// Deliberately NOT a boolean flag ("locked = true/false") — same rationale as #84's
// token-refresh-mutex.ts (TokenRefreshMutex): a flag alone has a race window between "check the
// flag" and "set the flag" where two concurrent callers can both observe `false` and both proceed.
// This holds the actual queue TAIL as a Promise instead.
//
// This is a deliberate *generalization* of token-refresh-mutex.ts's shape, not a copy of its
// behavior: TokenRefreshMutex's `run()` coalesces concurrent callers into the SAME single in-flight
// operation (a second caller never runs `operation` again — it just joins the first one's result).
// That join semantics is wrong for residency: a queued unload() and a queued switch-to-a-different-
// model ensureLoaded() are DIFFERENT operations that must each actually run, just never
// concurrently with one another. So `runExclusive()` here chains onto the previous operation's
// settlement (whatever it was) and then genuinely invokes the new operation — a true FIFO queue of
// depth-1-at-a-time, not a de-duplication join. (De-duplication of a truly *duplicate* ensureLoaded
// call for the exact same model+plan is a separate concern, handled by
// model-residency-manager.ts's own keyed in-flight-promise tracking, which mirrors
// TokenRefreshMutex's join shape directly for that narrower case.)
export class ResidencyMutex {
  // Always a promise that resolves (never rejects) — see runExclusive()'s comment on why the next
  // queued operation must run regardless of whether the previous one succeeded or failed.
  #tail: Promise<void> = Promise.resolve();
  #depth = 0;

  /** True while at least one operation is running or queued behind the mutex. Diagnostics only —
   * nothing in this module branches on it. */
  get locked(): boolean {
    return this.#depth > 0;
  }

  /** How many operations are currently running or waiting their turn (0 when idle). */
  get queueDepth(): number {
    return this.#depth;
  }

  /** Queues `operation` to run once every previously-queued operation has settled, then runs it and
   * returns its own result (resolution or rejection) to THIS caller specifically — a failure never
   * leaks into the shared queue tail, so the next queued operation always gets its turn. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.#depth += 1;
    const resultPromise = this.#tail.then(operation);
    // Swallow the outcome for the shared tail only — `resultPromise` (returned below) still carries
    // the real resolution/rejection back to this call's own caller.
    this.#tail = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    // Deliberately NOT `resultPromise.finally(...)`: `.finally()`'s returned promise re-throws
    // `resultPromise`'s own rejection, and leaving THAT promise unattached (`void ...finally(...)`)
    // is an unhandled rejection every time an operation fails — even though `resultPromise` itself
    // is (or will be) properly handled by this method's own caller. A `.then(onFulfilled,
    // onRejected)` pair whose `onRejected` doesn't rethrow settles its own returned promise
    // successfully, so voiding it is safe.
    resultPromise.then(
      () => {
        this.#depth -= 1;
      },
      () => {
        this.#depth -= 1;
      },
    );
    return resultPromise;
  }

  /** Test/cleanup seam mirroring token-refresh-mutex.ts's own `waitForIdle()` — resolves once every
   * currently queued (including still-to-run) operation has settled, success or failure alike, and
   * never rejects itself. Used by ModelResidencyManager.dispose() so app-quit teardown can know it's
   * safe to consider residency fully settled without adding a new operation of its own to the queue. */
  async waitForIdle(): Promise<void> {
    await this.#tail;
  }
}
