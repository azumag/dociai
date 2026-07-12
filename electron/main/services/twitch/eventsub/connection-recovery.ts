// Issue #88: "sleep/resume後のdeadline/watchdog再評価" / "online復帰でretryをcoalesce" — a small,
// mostly-pure bookkeeping class reconnect-coordinator.ts composes (the same "own a focused piece of
// mutable state, no I/O of its own" role revocation-handler.ts plays for subscription-reconciler.ts)
// for exactly two external triggers a real Electron Main process is expected to wire in:
// `powerMonitor.on("suspend"/"resume", ...)` (see #84's TwitchTokenProvider.onSystemResume() doc
// comment — this is the SAME hook shape, just a second consumer of it) and a network online/offline
// signal (e.g. Chromium's `navigator.onLine`-equivalent in Main, or a future dedicated check).
//
// Deliberately does NOT itself hold timers or sessions — reconnect-coordinator.ts owns those and
// calls into this file's methods to DECIDE what to do, then acts using its own state. This keeps
// the "was the system actually asleep, and for how long" and "did we just come back online"
// bookkeeping testable in isolation from the socket/backoff machinery.
import type { Clock } from "./keepalive-watchdog";
import { systemClock } from "./keepalive-watchdog";

export type ConnectionRecoveryDeps = { clock?: Clock };

export type SystemResumeInfo = { wasSuspended: boolean; sleptMs: number };

export class ConnectionRecovery {
  readonly #clock: Clock;
  #suspendedAtMs: number | null = null;
  #online = true;

  constructor(deps: ConnectionRecoveryDeps = {}) {
    this.#clock = deps.clock ?? systemClock;
  }

  get online(): boolean {
    return this.#online;
  }

  get suspended(): boolean {
    return this.#suspendedAtMs !== null;
  }

  /** Wire to `powerMonitor.on("suspend", ...)`. Idempotent (a second suspend notification before a
   * resume just keeps the original suspend timestamp). */
  onSystemSuspend(): void {
    if (this.#suspendedAtMs === null) this.#suspendedAtMs = this.#clock.now();
  }

  /** Wire to `powerMonitor.on("resume", ...)`, same hook shape as #84's TwitchTokenProvider.
   * onSystemResume(). Returns whether a suspend was actually recorded (a resume notification with
   * no prior suspend is a no-op the caller should ignore) and how long the system was asleep — a
   * deadline-holding caller (reconnect-coordinator.ts's pending backoff retry / specified-reconnect
   * grace deadline) is expected to re-check its own deadline against `clock.now()` immediately
   * afterward via isDeadlineExceeded() rather than trusting an already-armed timer to have fired
   * promptly: a real OS suspend can silently delay (or, on some platforms, entirely skip) a timer
   * that was due to fire while asleep. */
  onSystemResume(): SystemResumeInfo {
    if (this.#suspendedAtMs === null) return { wasSuspended: false, sleptMs: 0 };
    const sleptMs = Math.max(0, this.#clock.now() - this.#suspendedAtMs);
    this.#suspendedAtMs = null;
    return { wasSuspended: true, sleptMs };
  }

  /** True once `nowMs` has already passed a previously-recorded deadline — used by
   * reconnect-coordinator.ts right after onSystemResume() to decide "fire this pending
   * retry/fallback right now" vs "let the still-armed timer run its course". */
  isDeadlineExceeded(deadlineAtMs: number, nowMs: number = this.#clock.now()): boolean {
    return nowMs >= deadlineAtMs;
  }

  onNetworkOffline(): void {
    this.#online = false;
  }

  /** "online復帰でretryをcoalesce" — returns true only on the offline->online EDGE (a redundant
   * "online" notification while already online returns false), so a caller that coalesces a pending
   * backoff wait into an immediate retry never double-fires for two "online" events in a row. */
  onNetworkOnline(): boolean {
    const wasOffline = !this.#online;
    this.#online = true;
    return wasOffline;
  }
}
