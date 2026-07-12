// Issue #86: a pure, injectable-clock timer wrapper watching one EventSub session's liveness.
// Deadline = last-message-time + keepalive_timeout_seconds (Twitch's own per-session value, from
// session_welcome) + a small fixed grace margin (DEFAULT_GRACE_MS below — our own defensive
// choice, not a number Twitch documents; see its comment). Exceeding the deadline fires the
// caller-supplied `onTimeout` callback exactly once — never throws, never crashes the process —
// the callback is expected to close the owning session with reason "keepalive_timeout"
// (eventsub-session.ts does this), not treat the watchdog itself as having failed.
//
// `Clock` mirrors request-registry.ts's own local Clock type (same three-method shape) so tests
// can drive the deadline with a fake, instantly-advanceable clock instead of sleeping real
// wall-clock time — required for the welcome-timeout/keepalive-timeout tests issue #86 asks for.

export type Clock = { now(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Twitch's docs don't specify a recommended grace margin on top of keepalive_timeout_seconds —
 * this is our own choice, to absorb ordinary scheduler/network jitter around the exact deadline
 * rather than closing a perfectly healthy session a few milliseconds early. Kept small and fixed
 * (not proportional to keepalive_timeout_seconds) since Twitch's own default keepalive window
 * (10s) is already generous relative to typical jitter. */
export const DEFAULT_KEEPALIVE_GRACE_MS = 5_000;

export type KeepaliveWatchdogDeps = { clock?: Clock; graceMs?: number };

export class KeepaliveWatchdog {
  readonly #clock: Clock;
  readonly #graceMs: number;
  readonly #timeoutSeconds: number;
  readonly #onTimeout: () => void;
  #lastMessageAtMs: number;
  #timer: unknown = null;
  #stopped = false;

  constructor(keepaliveTimeoutSeconds: number, onTimeout: () => void, deps: KeepaliveWatchdogDeps = {}) {
    this.#clock = deps.clock ?? systemClock;
    this.#graceMs = deps.graceMs ?? DEFAULT_KEEPALIVE_GRACE_MS;
    this.#timeoutSeconds = keepaliveTimeoutSeconds;
    this.#onTimeout = onTimeout;
    this.#lastMessageAtMs = this.#clock.now();
    this.#arm();
  }

  /** The absolute deadline (clock time) this watchdog currently expects a message by. Exposed for
   * tests/diagnostics — nothing here needs to read it back. */
  get deadlineMs(): number {
    return this.#lastMessageAtMs + this.#timeoutSeconds * 1000 + this.#graceMs;
  }

  get lastMessageAtMs(): number {
    return this.#lastMessageAtMs;
  }

  /** "notification/keepaliveでwatchdog deadlineを更新" — call on every message received after
   * welcome (keepalive, notification, and in practice any other recognized frame; Twitch's own
   * guidance is "expect *some* message, not specifically a keepalive, within the window"). No-op
   * once stopped, so a message that raced a close() can never resurrect a dead watchdog's timer. */
  reset(): void {
    if (this.#stopped) return;
    this.#lastMessageAtMs = this.#clock.now();
    this.#arm();
  }

  /** Idempotent: clears the underlying timer and prevents any further `reset()`/timer firing from
   * doing anything. Session.close() calls this unconditionally as part of its own cleanup. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearTimer();
  }

  #arm(): void {
    this.#clearTimer();
    const delay = Math.max(0, this.deadlineMs - this.#clock.now());
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      if (this.#stopped) return;
      this.#onTimeout();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
