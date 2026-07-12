// Issue #84: coalesces concurrent refresh attempts into exactly one underlying refresh HTTP call.
//
// Deliberately NOT a boolean flag ("isRefreshing = true/false") — a flag alone has a race window
// between "check the flag" and "set the flag" where two concurrent callers can both observe
// `false` and both start a refresh. Instead this holds the actual in-flight Promise: `run()`
// synchronously (no `await` before the assignment) stores whatever Promise the first caller's
// operation returns, so every concurrent caller that reaches `run()` afterward — even one tick
// later — sees that same Promise already in place and simply awaits it, never invoking
// `operation` a second time. Same shape as DeviceCodeFlow's `#pending` and ModelDownloadService's
// `#pending` map (#76), specialized here to "at most one in-flight operation, period" since a
// token refresh (unlike a download) never has more than one logical target at a time.
export class TokenRefreshMutex {
  #inFlight: Promise<unknown> | undefined;

  /** True while a refresh attempt is in flight — read-only introspection for callers (e.g.
   * getValidAccessToken()) that want to join an already-running refresh instead of deciding
   * independently whether to start one. */
  get isRefreshing(): boolean {
    return this.#inFlight !== undefined;
  }

  /** The in-flight refresh Promise, if any — callers may `await` this directly to join it without
   * risking starting a second one via run(). */
  get current(): Promise<unknown> | undefined {
    return this.#inFlight;
  }

  /** Runs `operation` if nothing is currently in flight; otherwise returns the SAME in-flight
   * Promise without invoking `operation` again. Every concurrent caller therefore observes exactly
   * one underlying attempt and its single outcome (success or rejection alike). */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#inFlight) return this.#inFlight as Promise<T>;
    const promise = operation();
    this.#inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.#inFlight === promise) this.#inFlight = undefined;
    }
  }

  /** Test/cleanup seam: resolves once any in-flight refresh settles, success or failure alike —
   * never rejects. Used by app-quit teardown to know when it is safe to consider the mutex idle. */
  async waitForIdle(): Promise<void> {
    await this.#inFlight?.catch(() => {});
  }
}
