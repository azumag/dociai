// Issue #86: the top-level Main-process entry point future EventSub work (#87's subscription
// registry, #88's reconnect policy) builds on. For THIS issue its job is narrow: given a valid
// Twitch token (via #84's TwitchTokenProvider.getValidAccessToken(), reached here through #85's
// TwitchAuthCoordinator — see EventSubAuthSource below), open exactly one EventSubSession, surface
// its state/health, and support an explicit stop(). Reconnection POLICY itself (Twitch-specified
// reconnect-url following, ordinary backoff, notification dedupe) is explicitly #88's scope — this
// file never retries or reconnects on its own; it only classifies why a session ended (see
// eventsub-state.ts's EventSubCloseCategory) so a future #88 can decide what to do about it.
//
// "old session callback無視" at THIS layer: every session this service opens is created under a
// monotonically increasing `#generation` (same idiom as service-runtime.ts's ServiceRuntime and
// #84's TwitchTokenProvider `#sequence`/#85's `authGeneration`) — a session's own callbacks close
// over the generation they were opened under, so a superseded session's late callback can't drive
// this service's status backward even though eventsub-session.ts's own `#owns(socket)` guard
// already independently prevents that session's stale socket events from doing anything at all.
import { ServiceRuntime } from "../../service-runtime";
import { EventSubSession, DEFAULT_EVENTSUB_WS_URL } from "./eventsub-session";
import type { EventSubSocketConstructor } from "./eventsub-session";
import type { EventSubEnvelope } from "./eventsub-message-parser";
import { systemClock } from "./keepalive-watchdog";
import type { Clock } from "./keepalive-watchdog";
import { eventSubHealthStatus } from "./eventsub-state";
import type { EventSubCloseReason, EventSubServiceSnapshot, EventSubServiceStatus } from "./eventsub-state";

export { DEFAULT_EVENTSUB_WS_URL };
export type { EventSubSocketConstructor };

const SERVICE_ID = "twitch:eventsub";

/** The subset of #85's TwitchAuthCoordinator this service depends on, expressed as a structural
 * interface (not an import of the concrete class) — the same "depend on the shape, not the
 * class" seam model-download-service.ts uses for SecretStore. A real TwitchAuthCoordinator
 * satisfies this without any adapter; tests pass a minimal fake. */
export type EventSubAuthEvent = { generation: number; status: "unauthenticated" | "valid" | "reauth_required" };
export type EventSubAuthSource = {
  readonly authGeneration: number;
  getValidAccessToken(requiredScopes?: string[]): Promise<string>;
  subscribe(listener: (event: EventSubAuthEvent) => void): () => void;
};

/** "desired emptyのpreflight" — until #87's subscription registry exists there is nothing
 * concrete to check emptiness against beyond what the caller says it wants; `subscriptionTypes`
 * is a deliberately generic placeholder (`channel.subscribe`-shaped strings) for that future
 * registry to populate meaningfully. An empty list means "nothing to connect for" and is treated
 * exactly like `enabled: false`. */
export type EventSubDesiredState = { enabled: boolean; subscriptionTypes: readonly string[] };

export type EventSubServiceDeps = {
  webSocketUrl?: string;
  clock?: Clock;
  welcomeTimeoutMs?: number;
  maxMessageBytes?: number;
  keepaliveGraceMs?: number;
  now?: () => number;
  /** "state/health snapshotをUIへ配送" — fired synchronously on every status/session-state
   * change, in addition to (not instead of) `runtime.health`'s report (below), the same
   * dual-delivery pattern AiService/TwitchChatService already use (`onEvent` for a raw event feed,
   * IntegrationHealth for the shared cross-service health snapshot). */
  onEvent?: (snapshot: EventSubServiceSnapshot) => void;
  onNotification?: (envelope: EventSubEnvelope) => void;
  onRevocation?: (envelope: EventSubEnvelope) => void;
  onReconnectRequested?: (envelope: EventSubEnvelope, reconnectUrl: string | null) => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

export class EventSubService {
  readonly runtime = new ServiceRuntime(SERVICE_ID);

  readonly #socketFactory: EventSubSocketConstructor;
  readonly #authSource: EventSubAuthSource;
  readonly #url: string;
  readonly #clock: Clock;
  readonly #welcomeTimeoutMs: number | undefined;
  readonly #maxMessageBytes: number | undefined;
  readonly #keepaliveGraceMs: number | undefined;
  readonly #now: () => number;
  readonly #onEvent: (snapshot: EventSubServiceSnapshot) => void;
  readonly #onNotification: (envelope: EventSubEnvelope) => void;
  readonly #onRevocation: (envelope: EventSubEnvelope) => void;
  readonly #onReconnectRequested: (envelope: EventSubEnvelope, reconnectUrl: string | null) => void;
  readonly #log: (message: string, fields?: Record<string, unknown>) => void;
  readonly #unsubscribeAuth: () => void;

  #session: EventSubSession | null = null;
  #lastSessionSnapshot: EventSubServiceSnapshot["session"] = null;
  #generation = 0;
  #sessionAuthGeneration: number | null = null;
  #status: EventSubServiceStatus = "idle";
  #disposed = false;

  constructor(socketFactory: EventSubSocketConstructor, authSource: EventSubAuthSource, deps: EventSubServiceDeps = {}) {
    this.#socketFactory = socketFactory;
    this.#authSource = authSource;
    this.#url = deps.webSocketUrl ?? DEFAULT_EVENTSUB_WS_URL;
    this.#clock = deps.clock ?? systemClock;
    this.#welcomeTimeoutMs = deps.welcomeTimeoutMs;
    this.#maxMessageBytes = deps.maxMessageBytes;
    this.#keepaliveGraceMs = deps.keepaliveGraceMs;
    this.#now = deps.now ?? (() => this.#clock.now());
    this.#onEvent = deps.onEvent ?? (() => {});
    this.#onNotification = deps.onNotification ?? (() => {});
    this.#onRevocation = deps.onRevocation ?? (() => {});
    this.#onReconnectRequested = deps.onReconnectRequested ?? (() => {});
    this.#log = deps.log ?? (() => {});
    this.#unsubscribeAuth = this.#authSource.subscribe((event) => this.#handleAuthEvent(event));
  }

  get snapshot(): EventSubServiceSnapshot {
    return { status: this.#status, session: this.#lastSessionSnapshot, updatedAtMs: this.#now() };
  }

  get status(): EventSubServiceStatus {
    return this.#status;
  }

  // -----------------------------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------------------------

  /** "disabled/auth not ready/desired emptyのpreflightを実装" — checked in that order (cheapest
   * synchronous checks first; `getValidAccessToken()` is only ever called once both cheaper
   * checks pass, so a disabled/empty-desired-state caller never pays for a token validate). Any
   * previously running session is always stopped first (reason "superseded") regardless of the
   * outcome below — start() is the single entry point for "what should be running right now". */
  async start(desired: EventSubDesiredState): Promise<EventSubServiceSnapshot> {
    if (this.#disposed) return this.snapshot;
    this.#generation += 1;
    const generation = this.#generation;
    this.#stopActiveSession("superseded");

    if (!desired.enabled) {
      this.#setStatus("disabled");
      return this.snapshot;
    }
    if (desired.subscriptionTypes.length === 0) {
      this.#setStatus("desired_empty");
      return this.snapshot;
    }

    this.#setStatus("starting");
    let token: string;
    try {
      // "有効tokenのみで接続開始できる" (#85): a valid token is only a PRECONDITION gate here.
      // Twitch's real EventSub WebSocket handshake carries no Authorization header at all — the
      // token is never sent to `#socketFactory`/over this connection. Full scope checking against
      // desired subscriptions is #87's concern (see this file's module doc comment).
      token = await this.#authSource.getValidAccessToken();
    } catch {
      if (generation !== this.#generation) return this.snapshot;
      this.#setStatus("auth_not_ready");
      return this.snapshot;
    }
    void token;
    if (generation !== this.#generation || this.#disposed) return this.snapshot;

    this.#openSession(generation, this.#authSource.authGeneration);
    return this.snapshot;
  }

  /** Explicit stop — never produces a retry/reconnect signal ("explicit stop/auth change/app
   * quitではretryを発行しない"). Idempotent. */
  stop(): EventSubServiceSnapshot {
    if (this.#disposed) return this.snapshot;
    this.#generation += 1;
    this.#stopActiveSession("explicit_stop");
    this.#setStatus("stopped");
    return this.snapshot;
  }

  /** App teardown: stops any active session (reason "app_quit", same no-retry category as an
   * explicit stop), unsubscribes from auth-generation notifications, and disposes the composed
   * ServiceRuntime (health listeners). Safe to call multiple times; every subsequent start()/
   * stop() call becomes a no-op afterward. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#unsubscribeAuth();
    this.#stopActiveSession("app_quit");
    this.#setStatus("stopped");
    this.runtime.dispose();
  }

  // -----------------------------------------------------------------------------------------

  #handleAuthEvent(event: EventSubAuthEvent): void {
    if (this.#disposed || !this.#session) return; // nothing running to react to; #86 never auto-(re)starts on its own
    if (event.status === "valid" && event.generation === this.#sessionAuthGeneration) return; // unrelated notify (e.g. account metadata refresh without a token change)
    this.#generation += 1;
    const reason: EventSubCloseReason = event.status === "valid" ? "auth_generation_changed" : "auth_not_ready";
    this.#stopActiveSession(reason);
    this.#setStatus(event.status === "valid" ? "stopped" : "auth_not_ready");
  }

  #openSession(generation: number, authGeneration: number): void {
    const session: EventSubSession = new EventSubSession(this.#url, this.#socketFactory, {
      clock: this.#clock,
      welcomeTimeoutMs: this.#welcomeTimeoutMs,
      maxMessageBytes: this.#maxMessageBytes,
      keepaliveGraceMs: this.#keepaliveGraceMs,
      onStateChange: (snapshot) => {
        // Always mirror the latest known session snapshot, even for a superseded/stale session —
        // this is passive data, never a decision. Only the SERVICE status transitions below are
        // gated by generation.
        this.#lastSessionSnapshot = snapshot;
        if (generation !== this.#generation) return;
        if (snapshot.state === "closed") return; // onClose (below) sets the final status
        this.#setStatus(snapshot.state === "connected" ? "running" : "starting");
      },
      onNotification: (envelope) => { if (generation === this.#generation) this.#onNotification(envelope); },
      onRevocation: (envelope) => { if (generation === this.#generation) this.#onRevocation(envelope); },
      onReconnectRequested: (envelope, url) => { if (generation === this.#generation) this.#onReconnectRequested(envelope, url); },
      onClose: () => {
        if (this.#session === session) this.#session = null;
        if (generation !== this.#generation) return;
        this.#setStatus("stopped");
      },
      log: this.#log,
    });
    this.#session = session;
    this.#sessionAuthGeneration = authGeneration;
    session.connect();
  }

  #stopActiveSession(reason: EventSubCloseReason): void {
    this.#session?.close(reason);
  }

  #setStatus(next: EventSubServiceStatus): void {
    this.#status = next;
    const snapshot = this.snapshot;
    this.#onEvent(snapshot);
    this.runtime.health.report({ type: "changed", serviceId: SERVICE_ID, status: eventSubHealthStatus(snapshot), at: this.#now() });
  }
}
