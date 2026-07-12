// Issue #88: the layer eventsub-session.ts's own module doc comment points to — "this file never
// retries or reconnects on its own; it only classifies why a session ended... so a future #88 can
// decide what to do about it." This is that future #88: it owns EventSubSession instances directly
// (constructing them itself, the same way eventsub-service.ts does) rather than going through
// EventSubService, because a Twitch-SPECIFIED reconnect fundamentally needs to hold TWO live
// sessions at once (the retiring old one and the candidate new one) — something EventSubService's
// single-session, generation-guarded model has no room for.
//
// "reconnect中のold generation eventを拒否": extends, not duplicates, eventsub-session.ts's own
// `#owns(socket)` idiom one level up — every session-role field (#current/#candidate/#retiring) is
// checked by REFERENCE IDENTITY inside every callback closure (`this.#current === session`), the
// same "capture the reference, compare identity" technique #owns() uses, plus a monotonic
// `#generation` counter bumped on start()/stop()/dispose()/an auth change (the SAME idiom
// eventsub-service.ts/subscription-reconciler.ts/twitch-token-provider.ts/twitch-auth-coordinator.ts
// already use — see eventsub-service.ts's own doc comment for that idiom's lineage). Generation
// stays CONSTANT across an in-progress specified reconnect (old+new are both legitimately "this
// generation" simultaneously); the role-identity checks are what distinguish a session that's still
// one of the two currently-recognized sockets from one that's been fully superseded.
//
// "backoff計算...は#68の共有primitiveを利用": computeReconnectDelayMs() (reconnect-policy.ts)
// delegates the actual math to retry-policy.ts's `retryDelay` — see that file's own doc comment.
// The WAIT itself is a plain cancelable Clock timer (keepalive-watchdog.ts's `Clock` type, already
// used by every other file in this directory) rather than retry-policy.ts's AbortSignal-based
// `retryWithPolicy`: this coordinator is an event-driven state machine (a `session_reconnect`
// message can interrupt a backoff wait, sleep/resume can force an early re-check, "online" can
// coalesce a pending wait) rather than a single wrapped async operation, and a Clock timer is
// trivially both cancelable (clearTimeout) and independently, deterministically fast-forwardable in
// tests via the exact same manual-clock convention twitch-eventsub.test.mjs already established for
// eventsub-session.ts/keepalive-watchdog.ts.
import { EventSubSession, DEFAULT_EVENTSUB_WS_URL } from "./eventsub-session";
import type { EventSubCloseInfo, EventSubSocketConstructor } from "./eventsub-session";
import type { EventSubEnvelope } from "./eventsub-message-parser";
import { systemClock } from "./keepalive-watchdog";
import type { Clock } from "./keepalive-watchdog";
import type { EventSubCloseReason, EventSubSessionSnapshot } from "./eventsub-state";
import type { EventSubAuthEvent, EventSubAuthSource } from "./eventsub-service";
import {
  DEFAULT_RECONNECT_POLICY,
  DEFAULT_SPECIFIED_RECONNECT_GRACE_MS,
  DEFAULT_STABLE_CONNECTED_MS,
  computeReconnectDelayMs,
  isValidReconnectUrl,
  shouldRetryCloseCategory,
} from "./reconnect-policy";
import type { RetryPolicy } from "../../retry-policy";
import { NotificationDedupe } from "./notification-dedupe";
import type { NotificationDedupeStats } from "./notification-dedupe";
import { ConnectionRecovery } from "./connection-recovery";

export { DEFAULT_EVENTSUB_WS_URL };

/** The subset of #87's SubscriptionReconciler this coordinator depends on, expressed structurally
 * (the same "depend on the shape, not the class" seam every other Twitch service file in this repo
 * uses — EventSubAuthSource/SubscriptionReconcilerAuthSource). A real SubscriptionReconciler
 * satisfies this without any adapter (its onWelcome/retarget/onRevocation/onSessionEnded methods
 * already match); tests can also pass a plain call-counting fake. */
export type ReconnectSubscriptionSink = {
  /** Full reconcile — Helix list + create-as-needed. Called on every NORMAL (non-specified)
   * welcome, including the very first connect. */
  onWelcome(sessionId: string, atMs?: number): Promise<void> | void;
  /** "new welcome後に既存subscriptionを再作成せず引継ぐ" — called INSTEAD of onWelcome() for a
   * successful Twitch-specified reconnect: updates which session id future creates attach to,
   * without making any Helix call itself. */
  retarget?(sessionId: string, atMs?: number): void;
  onRevocation?(envelope: EventSubEnvelope): void;
  onSessionEnded?(): void;
};

export type ReconnectCoordinatorStatus =
  | "idle"
  | "connecting"
  | "reconnect_pending"
  | "specified_reconnect"
  | "running"
  | "auth_not_ready"
  | "stopped";

export type ReconnectDiagnosticEvent =
  | { type: "retry_scheduled"; attempt: number; delayMs: number; retryAtMs: number }
  | { type: "specified_reconnect_started"; reconnectUrl: string }
  | { type: "specified_reconnect_succeeded" }
  | { type: "specified_reconnect_fallback"; reason: string }
  | { type: "event_gap_warning"; message: string }
  | { type: "duplicate_dropped"; messageId: string }
  | { type: "stopped"; reason: string };

export type ReconnectCoordinatorSnapshot = {
  status: ReconnectCoordinatorStatus;
  attempt: number;
  session: EventSubSessionSnapshot | null;
  pendingRetryAtMs: number | null;
  online: boolean;
  dedupe: NotificationDedupeStats;
  updatedAtMs: number;
};

export type ReconnectCoordinatorDeps = {
  webSocketUrl?: string;
  clock?: Clock;
  welcomeTimeoutMs?: number;
  maxMessageBytes?: number;
  keepaliveGraceMs?: number;
  policy?: RetryPolicy;
  stableConnectedMs?: number;
  specifiedReconnectGraceMs?: number;
  random?: () => number;
  dedupe?: NotificationDedupe;
  recovery?: ConnectionRecovery;
  subscriptionSink?: ReconnectSubscriptionSink;
  /** Defaults to reconnect-policy.ts's real isValidReconnectUrl() — the production scheme/host
   * check against Twitch's own `*.wss.twitch.tv` family. Overridable ONLY so tests can exercise the
   * old/new dual-socket dance against a local `ws://127.0.0.1` fixture standing in for Twitch;
   * every call site in this file that decides whether to trust a `reconnect_url` goes through this
   * function, never the module-level isValidReconnectUrl() directly, so a test that does NOT
   * override this dependency is exercising the exact real validator. */
  isReconnectUrlValid?: (url: string) => boolean;
  onEvent?: (snapshot: ReconnectCoordinatorSnapshot) => void;
  onNotification?: (envelope: EventSubEnvelope) => void;
  onDiagnostic?: (event: ReconnectDiagnosticEvent) => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

const NOOP_SINK: ReconnectSubscriptionSink = { onWelcome: () => {} };

export class ReconnectCoordinator {
  readonly #url: string;
  readonly #socketFactory: EventSubSocketConstructor;
  readonly #authSource: EventSubAuthSource;
  readonly #clock: Clock;
  readonly #welcomeTimeoutMs: number | undefined;
  readonly #maxMessageBytes: number | undefined;
  readonly #keepaliveGraceMs: number | undefined;
  readonly #policy: RetryPolicy;
  readonly #stableConnectedMs: number;
  readonly #specifiedReconnectGraceMs: number;
  readonly #random: () => number;
  readonly #dedupe: NotificationDedupe;
  readonly #recovery: ConnectionRecovery;
  readonly #subscriptionSink: ReconnectSubscriptionSink;
  readonly #isReconnectUrlValid: (url: string) => boolean;
  readonly #onEvent: (snapshot: ReconnectCoordinatorSnapshot) => void;
  readonly #onNotification: (envelope: EventSubEnvelope) => void;
  readonly #onDiagnostic: (event: ReconnectDiagnosticEvent) => void;
  readonly #log: (message: string, fields?: Record<string, unknown>) => void;
  readonly #unsubscribeAuth: () => void;

  #generation = 0;
  #attempt = 0;
  #status: ReconnectCoordinatorStatus = "idle";
  #current: EventSubSession | null = null;
  #candidate: EventSubSession | null = null;
  #retiring: EventSubSession | null = null;
  #lastSessionSnapshot: EventSubSessionSnapshot | null = null;
  #sessionAuthGeneration: number | null = null;
  #pendingReconnectTimer: unknown = null;
  #pendingReconnectAtMs: number | null = null;
  #stableTimer: unknown = null;
  #graceTimer: unknown = null;
  #graceDeadlineAtMs: number | null = null;
  #disposed = false;

  constructor(socketFactory: EventSubSocketConstructor, authSource: EventSubAuthSource, deps: ReconnectCoordinatorDeps = {}) {
    this.#socketFactory = socketFactory;
    this.#authSource = authSource;
    this.#url = deps.webSocketUrl ?? DEFAULT_EVENTSUB_WS_URL;
    this.#clock = deps.clock ?? systemClock;
    this.#welcomeTimeoutMs = deps.welcomeTimeoutMs;
    this.#maxMessageBytes = deps.maxMessageBytes;
    this.#keepaliveGraceMs = deps.keepaliveGraceMs;
    this.#policy = deps.policy ?? DEFAULT_RECONNECT_POLICY;
    this.#stableConnectedMs = deps.stableConnectedMs ?? DEFAULT_STABLE_CONNECTED_MS;
    this.#specifiedReconnectGraceMs = deps.specifiedReconnectGraceMs ?? DEFAULT_SPECIFIED_RECONNECT_GRACE_MS;
    this.#random = deps.random ?? Math.random;
    this.#dedupe = deps.dedupe ?? new NotificationDedupe({ clock: this.#clock });
    this.#recovery = deps.recovery ?? new ConnectionRecovery({ clock: this.#clock });
    this.#subscriptionSink = deps.subscriptionSink ?? NOOP_SINK;
    this.#isReconnectUrlValid = deps.isReconnectUrlValid ?? isValidReconnectUrl;
    this.#onEvent = deps.onEvent ?? (() => {});
    this.#onNotification = deps.onNotification ?? (() => {});
    this.#onDiagnostic = deps.onDiagnostic ?? (() => {});
    this.#log = deps.log ?? (() => {});
    this.#unsubscribeAuth = this.#authSource.subscribe((event) => this.#handleAuthEvent(event));
  }

  get snapshot(): ReconnectCoordinatorSnapshot {
    return {
      status: this.#status,
      attempt: this.#attempt,
      session: this.#lastSessionSnapshot,
      pendingRetryAtMs: this.#pendingReconnectAtMs,
      online: this.#recovery.online,
      dedupe: this.#dedupe.stats,
      updatedAtMs: this.#clock.now(),
    };
  }

  get status(): ReconnectCoordinatorStatus {
    return this.#status;
  }

  get dedupeStats(): NotificationDedupeStats {
    return this.#dedupe.stats;
  }

  // -----------------------------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.#disposed) return;
    this.#generation += 1;
    const generation = this.#generation;
    this.#teardownSessionsAndTimers("superseded");
    this.#attempt = 0;
    this.#status = "connecting";
    this.#emit();

    let token: string;
    try {
      token = await this.#authSource.getValidAccessToken();
    } catch {
      if (generation !== this.#generation) return;
      this.#status = "auth_not_ready";
      this.#emit();
      return;
    }
    void token;
    if (generation !== this.#generation || this.#disposed) return;
    this.#sessionAuthGeneration = this.#authSource.authGeneration;
    this.#attemptConnect(generation);
  }

  /** Explicit stop — never schedules a retry ("explicit stop...をretry対象外にする"). Idempotent. */
  stop(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#teardownSessionsAndTimers("explicit_stop");
    this.#subscriptionSink.onSessionEnded?.();
    this.#status = "stopped";
    this.#diagnostic({ type: "stopped", reason: "explicit_stop" });
    this.#emit();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeAuth();
    this.#generation += 1;
    this.#teardownSessionsAndTimers("app_quit");
    this.#status = "stopped";
    this.#emit();
  }

  // -----------------------------------------------------------------------------------------
  // Sleep/resume + network online/offline ("sleep/resume後のdeadline/watchdog再評価" /
  // "online復帰でretryをcoalesce") — same hook shape as #84's TwitchTokenProvider.onSystemResume().
  // -----------------------------------------------------------------------------------------

  onSystemSuspend(): void {
    this.#recovery.onSystemSuspend();
  }

  onSystemResume(): void {
    const { wasSuspended } = this.#recovery.onSystemResume();
    if (!wasSuspended || this.#disposed) return;
    const now = this.#clock.now();
    const generation = this.#generation;

    if (this.#pendingReconnectAtMs !== null && this.#pendingReconnectTimer !== null && this.#recovery.isDeadlineExceeded(this.#pendingReconnectAtMs, now)) {
      this.#clock.clearTimeout(this.#pendingReconnectTimer);
      this.#pendingReconnectTimer = null;
      this.#pendingReconnectAtMs = null;
      this.#attemptConnect(generation);
      return;
    }

    if (this.#graceDeadlineAtMs !== null && this.#recovery.isDeadlineExceeded(this.#graceDeadlineAtMs, now)) {
      const retiring = this.#retiring;
      const candidate = this.#candidate;
      this.#clearGraceTimer();
      this.#candidate = null;
      if (candidate && !candidate.closed) candidate.close("welcome_timeout", "specified reconnect grace deadline exceeded across system sleep");
      this.#fallbackToNormalReconnect(generation, retiring, "grace deadline exceeded across system sleep");
    }
  }

  onNetworkOffline(): void {
    this.#recovery.onNetworkOffline();
  }

  /** "online復帰でretryをcoalesce" — if a backoff wait is currently pending, fire it immediately
   * instead of waiting out the remainder; a redundant "online" notification while already online
   * (or while nothing is pending) is a no-op, never a duplicate reconnect attempt. */
  onNetworkOnline(): void {
    const coalesced = this.#recovery.onNetworkOnline();
    if (!coalesced || this.#disposed) return;
    if (this.#pendingReconnectTimer === null) return;
    this.#clock.clearTimeout(this.#pendingReconnectTimer);
    this.#pendingReconnectTimer = null;
    this.#pendingReconnectAtMs = null;
    const generation = this.#generation;
    this.#diagnostic({ type: "retry_scheduled", attempt: this.#attempt, delayMs: 0, retryAtMs: this.#clock.now() });
    this.#attemptConnect(generation);
  }

  // -----------------------------------------------------------------------------------------
  // Auth ("explicit stop/auth error...をretry対象外にする" — routes #85's auth-generation-changed
  // events the same way eventsub-service.ts's own #handleAuthEvent already does)
  // -----------------------------------------------------------------------------------------

  #handleAuthEvent(event: EventSubAuthEvent): void {
    if (this.#disposed) return;
    const hasWork = this.#current !== null || this.#candidate !== null || this.#retiring !== null || this.#pendingReconnectTimer !== null;
    if (!hasWork) return;
    if (event.status === "valid" && event.generation === this.#sessionAuthGeneration) return;
    const reason: EventSubCloseReason = event.status === "valid" ? "auth_generation_changed" : "auth_not_ready";
    this.#generation += 1;
    this.#teardownSessionsAndTimers(reason);
    this.#subscriptionSink.onSessionEnded?.();
    this.#status = event.status === "valid" ? "idle" : "auth_not_ready";
    this.#diagnostic({ type: "stopped", reason });
    this.#emit();
  }

  // -----------------------------------------------------------------------------------------
  // Normal connect path
  // -----------------------------------------------------------------------------------------

  #attemptConnect(generation: number): void {
    if (this.#disposed || generation !== this.#generation) return;
    this.#status = "connecting";
    const session = new EventSubSession(this.#url, this.#socketFactory, {
      clock: this.#clock,
      welcomeTimeoutMs: this.#welcomeTimeoutMs,
      maxMessageBytes: this.#maxMessageBytes,
      keepaliveGraceMs: this.#keepaliveGraceMs,
      onStateChange: (snapshot) => {
        // Only mirror this session's snapshot while it is still `#current` — a deliberately
        // demoted/retired session (see #beginSpecifiedReconnect) also fires onStateChange when it
        // is later closed, and that must never clobber a newer, already-promoted session's
        // snapshot (see #onSessionClosed's own identical guard).
        if (this.#current === session) this.#lastSessionSnapshot = snapshot;
        if (generation !== this.#generation || this.#current !== session) return;
        if (snapshot.state === "connected" && snapshot.sessionId) this.#handleWelcome(generation, session, snapshot.sessionId);
        this.#emit();
      },
      onNotification: (envelope) => this.#deliverNotification(envelope),
      onRevocation: (envelope) => this.#subscriptionSink.onRevocation?.(envelope),
      onReconnectRequested: (_envelope, reconnectUrl) => {
        if (generation !== this.#generation || this.#current !== session) return;
        this.#beginSpecifiedReconnect(generation, session, reconnectUrl);
      },
      onClose: (info) => this.#onSessionClosed(generation, session, info, null),
      log: this.#log,
    });
    this.#current = session;
    session.connect();
    this.#emit();
  }

  #handleWelcome(generation: number, session: EventSubSession, sessionId: string): void {
    if (generation !== this.#generation || this.#current !== session) return;
    this.#status = "running";
    if (this.#attempt > 0) {
      this.#diagnostic({ type: "event_gap_warning", message: `reconnected after ${this.#attempt} backoff attempt(s); notifications during the outage were not replayed` });
    }
    void Promise.resolve(this.#subscriptionSink.onWelcome(sessionId, this.#clock.now())).catch((error) => {
      this.#log("subscription sink onWelcome() failed", { errorName: error instanceof Error ? error.name : typeof error });
    });
    this.#armStableTimer(generation, session);
  }

  /** Shared by both the plain #attemptConnect() path and the specified-reconnect candidate path
   * (see #beginSpecifiedReconnect) — a session's role (current/candidate/retiring) is resolved by
   * REFERENCE at the moment it actually closes, not fixed at wiring time, so a candidate that was
   * later promoted to `#current` still gets normal reconnect handling once IT eventually closes. */
  #onSessionClosed(generation: number, session: EventSubSession, info: EventSubCloseInfo, retiringWhenCandidate: EventSubSession | null): void {
    const wasCandidate = this.#candidate === session;
    const wasCurrent = this.#current === session;
    const wasRetiring = this.#retiring === session;
    if (wasCandidate) this.#candidate = null;
    if (wasCurrent) this.#current = null;
    if (wasRetiring) this.#retiring = null;
    if (!wasCandidate && !wasCurrent) return; // a deliberately-retired session closing is expected — must never clobber a newer, already-promoted session's snapshot
    this.#lastSessionSnapshot = session.snapshot;
    if (generation !== this.#generation) return;

    if (wasCandidate) {
      this.#clearGraceTimer();
      this.#fallbackToNormalReconnect(generation, retiringWhenCandidate, `candidate session closed before welcome (${info.reason})`);
      return;
    }
    this.#handleNormalSessionClosed(generation, info);
  }

  #handleNormalSessionClosed(generation: number, info: EventSubCloseInfo): void {
    this.#clearStableTimer();
    this.#subscriptionSink.onSessionEnded?.();
    if (!shouldRetryCloseCategory(info.category)) {
      this.#status = info.category === "auth" ? "auth_not_ready" : "stopped";
      this.#diagnostic({ type: "stopped", reason: info.reason });
      this.#emit();
      return;
    }
    this.#scheduleReconnect(generation);
  }

  #scheduleReconnect(generation: number): void {
    if (generation !== this.#generation) return;
    this.#attempt += 1;
    const delayMs = computeReconnectDelayMs(this.#attempt, this.#policy, this.#random);
    const retryAtMs = this.#clock.now() + delayMs;
    this.#pendingReconnectAtMs = retryAtMs;
    this.#status = "reconnect_pending";
    this.#diagnostic({ type: "retry_scheduled", attempt: this.#attempt, delayMs, retryAtMs });
    this.#emit();
    this.#pendingReconnectTimer = this.#clock.setTimeout(() => {
      this.#pendingReconnectTimer = null;
      this.#pendingReconnectAtMs = null;
      this.#attemptConnect(generation);
    }, delayMs);
  }

  #armStableTimer(generation: number, session: EventSubSession): void {
    this.#clearStableTimer();
    this.#stableTimer = this.#clock.setTimeout(() => {
      this.#stableTimer = null;
      if (generation !== this.#generation || this.#current !== session) return;
      this.#attempt = 0; // "接続継続時間によるattempt reset" — this outage-recovery sequence is over
    }, this.#stableConnectedMs);
  }

  #clearStableTimer(): void {
    if (this.#stableTimer !== null) {
      this.#clock.clearTimeout(this.#stableTimer);
      this.#stableTimer = null;
    }
  }

  // -----------------------------------------------------------------------------------------
  // Twitch-specified reconnect ("old sessionをretiring、新socketをcandidateとして同時所有" /
  // "new welcomeまでold socketを維持" / "new welcome後に既存subscriptionを再作成せず引継ぐ" /
  // "grace deadline超過時に通常新規接続へfallback")
  // -----------------------------------------------------------------------------------------

  #beginSpecifiedReconnect(generation: number, retiring: EventSubSession, reconnectUrl: string | null): void {
    if (generation !== this.#generation || this.#current !== retiring) return;

    if (!reconnectUrl || !this.#isReconnectUrlValid(reconnectUrl)) {
      this.#diagnostic({ type: "specified_reconnect_fallback", reason: "reconnect_url failed scheme/host validation" });
      this.#current = null;
      this.#fallbackToNormalReconnect(generation, retiring, "reconnect_url failed scheme/host validation");
      return;
    }

    this.#status = "specified_reconnect";
    this.#current = null;
    this.#retiring = retiring;
    this.#diagnostic({ type: "specified_reconnect_started", reconnectUrl });

    const candidate = new EventSubSession(reconnectUrl, this.#socketFactory, {
      clock: this.#clock,
      welcomeTimeoutMs: this.#welcomeTimeoutMs,
      maxMessageBytes: this.#maxMessageBytes,
      keepaliveGraceMs: this.#keepaliveGraceMs,
      onStateChange: (snapshot) => {
        if (generation !== this.#generation || this.#candidate !== candidate) return;
        if (snapshot.state === "connected" && snapshot.sessionId) this.#handleSpecifiedWelcome(generation, retiring, candidate, snapshot.sessionId);
      },
      onNotification: (envelope) => this.#deliverNotification(envelope),
      onRevocation: (envelope) => this.#subscriptionSink.onRevocation?.(envelope),
      onReconnectRequested: (_envelope, url) => {
        if (generation !== this.#generation) return;
        // A second reconnect-request arriving on the still-promoted-and-running former candidate
        // is a perfectly normal future specified reconnect; one arriving on a not-yet-welcomed
        // candidate is unspecified by Twitch and simply ignored rather than recursively chained.
        if (this.#current === candidate) this.#beginSpecifiedReconnect(generation, candidate, url);
      },
      onClose: (info) => this.#onSessionClosed(generation, candidate, info, retiring),
      log: this.#log,
    });
    this.#candidate = candidate;
    this.#graceDeadlineAtMs = this.#clock.now() + this.#specifiedReconnectGraceMs;
    this.#graceTimer = this.#clock.setTimeout(() => {
      this.#graceTimer = null;
      this.#graceDeadlineAtMs = null;
      if (generation !== this.#generation || this.#candidate !== candidate) return;
      this.#candidate = null;
      candidate.close("welcome_timeout", "specified reconnect grace deadline exceeded");
      this.#fallbackToNormalReconnect(generation, retiring, "grace deadline exceeded before candidate welcome");
    }, this.#specifiedReconnectGraceMs);
    candidate.connect();
    this.#emit();
  }

  #handleSpecifiedWelcome(generation: number, retiring: EventSubSession, candidate: EventSubSession, sessionId: string): void {
    if (generation !== this.#generation || this.#candidate !== candidate) return;
    this.#clearGraceTimer();
    this.#subscriptionSink.retarget?.(sessionId, this.#clock.now());
    this.#candidate = null;
    this.#retiring = null;
    this.#current = candidate;
    this.#attempt = 0; // a successful specified reconnect is inherently healthy
    this.#status = "running";
    this.#armStableTimer(generation, candidate);
    this.#diagnostic({ type: "specified_reconnect_succeeded" });
    this.#lastSessionSnapshot = candidate.snapshot;
    this.#emit();
    // "new welcomeまでold socketを維持" — only NOW, after the new session has proven itself, is the
    // old one torn down. Reason "superseded" (explicit_stop category) so its own onClose is a no-op
    // here (see #onSessionClosed's wasRetiring branch) rather than triggering anything.
    retiring.close("superseded");
  }

  #fallbackToNormalReconnect(generation: number, retiring: EventSubSession | null, reason: string): void {
    if (generation !== this.#generation) return;
    this.#diagnostic({ type: "specified_reconnect_fallback", reason });
    if (retiring && !retiring.closed) {
      retiring.close("reconnect_abandoned", reason);
    } else if (this.#retiring === retiring) {
      this.#retiring = null;
    }
    this.#status = "reconnect_pending";
    this.#scheduleReconnect(generation);
  }

  #clearGraceTimer(): void {
    if (this.#graceTimer !== null) {
      this.#clock.clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
    this.#graceDeadlineAtMs = null;
  }

  // -----------------------------------------------------------------------------------------
  // Notification delivery ("message_id TTL/LRU dedupeをold/new sessionで共有")
  // -----------------------------------------------------------------------------------------

  #deliverNotification(envelope: EventSubEnvelope): void {
    const messageId = envelope.metadata.messageId;
    const isNew = !messageId || this.#dedupe.shouldDeliver(messageId, this.#clock.now());
    if (isNew) {
      this.#onNotification(envelope);
      return;
    }
    this.#diagnostic({ type: "duplicate_dropped", messageId });
  }

  // -----------------------------------------------------------------------------------------

  #teardownSessionsAndTimers(reason: EventSubCloseReason): void {
    if (this.#pendingReconnectTimer !== null) {
      this.#clock.clearTimeout(this.#pendingReconnectTimer);
      this.#pendingReconnectTimer = null;
    }
    this.#pendingReconnectAtMs = null;
    this.#clearStableTimer();
    this.#clearGraceTimer();
    const sessions = [this.#current, this.#candidate, this.#retiring];
    this.#current = null;
    this.#candidate = null;
    this.#retiring = null;
    for (const session of sessions) {
      if (session && !session.closed) session.close(reason);
    }
  }

  #emit(): void {
    this.#onEvent(this.snapshot);
  }

  #diagnostic(event: ReconnectDiagnosticEvent): void {
    this.#onDiagnostic(event);
  }
}
