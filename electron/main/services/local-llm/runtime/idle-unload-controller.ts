// Issue #79: a pure, injectable-clock idle-countdown timer deciding WHEN a resident model should be
// proactively unloaded — a concern #45's LocalLlmService explicitly does not own (it has no idle
// timer of its own; it only reacts to explicit load()/unload()/generate() calls).
//
// Same `Clock` shape (now/setTimeout/clearTimeout) as #86's keepalive-watchdog.ts
// (electron/main/services/twitch/eventsub/keepalive-watchdog.ts) — deliberately re-declared here
// rather than imported: this module lives in an unrelated feature domain (local LLM runtime vs.
// Twitch EventSub transport), and the two timers' only real relationship is sharing this idiom
// ("injectable clock so tests never sleep real wall-clock time"), not any shared behavior or
// lifecycle. KeepaliveWatchdog fires unconditionally on deadline; this controller additionally
// re-checks a caller-supplied `isBusy()` predicate right before it would fire (see #scheduleFire())
// — "streaming/pending queue中はidle unloadを抑制... 継続してtouchが来なくても" (never let the idle
// timer fire while a generation is active or queued, regardless of how long since the last touch).
export type Clock = { now(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000; // 5 minutes of no activity before a resident model is proactively unloaded

/** Surfaced so a future UI can show "idle unload in N seconds" and offer a "keep loaded" action
 * (issue: "unload countdown eventとcancel actionを実装"). Mirrors local-llm's own
 * constructor-injected-callback event idiom (see contract.ts's `emitLoadProgress`) rather than a
 * subscribe()/EventEmitter model. */
export type IdleUnloadEvent =
  | { type: "armed"; deadlineMs: number; idleTimeoutMs: number; at: number }
  | { type: "cancelled"; reason: "touch" | "manual" | "suspended" | "stopped"; at: number }
  | { type: "deferred"; reason: "busy"; nextDeadlineMs: number; at: number }
  | { type: "fired"; at: number };

export type IdleUnloadControllerDeps = {
  clock?: Clock;
  idleTimeoutMs?: number;
  /** Called exactly once per actual firing (never while `isBusy()` reports true — see
   * #scheduleFire()). Never throws back into this controller; a rejecting/throwing callback is the
   * caller's own concern. */
  onIdleUnload: () => void;
  /** "配信・生成中に誤発火しない" — checked fresh at the moment the countdown would otherwise fire,
   * not only at arm()/touch() time. Wired by model-residency-manager.ts to LocalLlmService's current
   * state (+ pending queue depth, when available) — see that file's header comment. */
  isBusy: () => boolean;
  onEvent?: (event: IdleUnloadEvent) => void;
};

/** One countdown, armed explicitly (via `arm()`, e.g. right after a model finishes loading) and
 * reset by `touch()` on activity. Deliberately does NOT auto-arm in its constructor — unlike
 * KeepaliveWatchdog (which always has a live session to watch from the moment it's constructed),
 * this controller may exist for the manager's entire lifetime while no model is resident at all
 * (nothing to idle-unload), so arming is always an explicit, caller-driven decision. */
export class IdleUnloadController {
  readonly #clock: Clock;
  readonly #idleTimeoutMs: number;
  readonly #onIdleUnload: () => void;
  readonly #isBusy: () => boolean;
  readonly #onEvent: (event: IdleUnloadEvent) => void;
  #timer: unknown = null;
  #armedAtMs: number | null = null;
  #suspended = false;
  #stopped = false;

  constructor(deps: IdleUnloadControllerDeps) {
    this.#clock = deps.clock ?? systemClock;
    this.#idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#onIdleUnload = deps.onIdleUnload;
    this.#isBusy = deps.isBusy;
    this.#onEvent = deps.onEvent ?? (() => {});
  }

  /** Whether a countdown is currently ticking (a timer is actually scheduled). */
  get isArmed(): boolean {
    return this.#timer !== null;
  }

  /** The absolute deadline (clock time) the current countdown would fire at, or `null` if not
   * armed. Exposed for diagnostics/tests — "idle unload in N seconds" is `deadlineMs - clock.now()`. */
  get deadlineMs(): number | null {
    return this.#armedAtMs === null ? null : this.#armedAtMs + this.#idleTimeoutMs;
  }

  get idleTimeoutMs(): number {
    return this.#idleTimeoutMs;
  }

  /** (Re)starts the countdown from "now" — called once a model finishes loading/switching. No-op
   * while stopped or suspended (resume() re-arms explicitly instead — see that method). */
  arm(): void {
    if (this.#stopped || this.#suspended) return;
    this.#armedAtMs = this.#clock.now();
    this.#scheduleFire();
    this.#onEvent({ type: "armed", deadlineMs: this.deadlineMs as number, idleTimeoutMs: this.#idleTimeoutMs, at: this.#clock.now() });
  }

  /** "activity touchとidle timerを実装" — resets the countdown due to real activity (at minimum:
   * every generation start; ideally also every new enqueue). No-op if nothing is currently armed
   * (nothing to reset) or once stopped. */
  touch(): void {
    if (this.#stopped || this.#timer === null) return;
    this.#armedAtMs = this.#clock.now();
    this.#scheduleFire();
  }

  /** Explicit "keep loaded" / manual postpone action, or called internally once a model is
   * unloaded (nothing left to count down toward). Idempotent. */
  cancel(reason: "touch" | "manual" | "suspended" | "stopped" = "manual"): void {
    const wasArmed = this.#timer !== null;
    this.#clearTimer();
    this.#armedAtMs = null;
    if (wasArmed) this.#onEvent({ type: "cancelled", reason, at: this.#clock.now() });
  }

  /** OS suspend hook (issue: "app suspend/resume/quit時のpolicy... #78のHardwareProfileService.
   * onSuspendResume()と同様のhookを再利用"). Stops the countdown outright while suspended — elapsed
   * wall-clock time during sleep must never count as "idle" the instant the machine wakes. */
  suspend(): void {
    if (this.#suspended) return;
    this.#suspended = true;
    this.cancel("suspended");
  }

  /** OS resume hook — resumes accepting arm()/touch() calls again. Deliberately does NOT
   * automatically re-arm itself: model-residency-manager.ts's onResume() re-arms only if a model is
   * actually still resident (resume() itself has no way to know that). */
  resume(): void {
    this.#suspended = false;
  }

  /** Permanent shutdown (dispose()). No further arm()/touch() ever schedules a timer again. */
  stop(): void {
    this.#stopped = true;
    this.cancel("stopped");
  }

  #scheduleFire(): void {
    this.#clearTimer();
    const deadline = this.deadlineMs as number;
    const delay = Math.max(0, deadline - this.#clock.now());
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      if (this.#stopped || this.#suspended || this.#armedAtMs === null) return;
      if (this.#isBusy()) {
        // "継続してtouchが来なくても" — even though nothing called touch(), a live generation or a
        // non-empty pending queue means this is not actually idle; defer by re-arming a fresh
        // window instead of firing, and try again after that.
        this.#armedAtMs = this.#clock.now();
        this.#scheduleFire();
        this.#onEvent({ type: "deferred", reason: "busy", nextDeadlineMs: this.deadlineMs as number, at: this.#clock.now() });
        return;
      }
      this.#armedAtMs = null;
      this.#onEvent({ type: "fired", at: this.#clock.now() });
      this.#onIdleUnload();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
