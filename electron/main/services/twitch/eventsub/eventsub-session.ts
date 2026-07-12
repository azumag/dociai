// Issue #86: owns exactly one EventSub WebSocket connection's whole lifecycle — connect -> wait
// for session_welcome (with a timeout) -> track session.id/keepalive_timeout_seconds -> route
// subsequent frames to eventsub-message-parser.ts -> feed notification/keepalive (and any other
// recognized post-welcome frame) into keepalive-watchdog.ts -> close (with a reason) cleans up
// every socket listener and timer synchronously and idempotently.
//
// "old session callback無視": every socket event handler below is gated by `#owns(socket)`, which
// compares the captured `socket` reference against `this.#socket` — the exact same idiom
// src/twitch-chat/twitch-chat-session.js's `#owns()` and electron/main/services/twitch/twitch-
// chat-service.ts's `this.socket !== socket` checks already use in this repo. `#close()` clears
// `this.#socket` and flips `#closed` BEFORE anything else, so a message/close/error event for this
// session's OWN socket that was already queued when close() ran is a guaranteed no-op — it can
// never mutate state after this session is done, and (since each EventSubSession instance owns
// only its own private fields) it can never bleed into a *different*, later EventSubSession
// instance either.
import { ServiceError } from "../../service-error";
import {
  parseEventSubMessage,
  parseReconnectSession,
  parseWelcomeSession,
} from "./eventsub-message-parser";
import type { EventSubEnvelope } from "./eventsub-message-parser";
import { KeepaliveWatchdog, systemClock } from "./keepalive-watchdog";
import type { Clock } from "./keepalive-watchdog";
import {
  canTransitionSessionState,
  closeCategoryFor,
} from "./eventsub-state";
import type {
  EventSubCloseCategory,
  EventSubCloseReason,
  EventSubSessionSnapshot,
  EventSubSessionState,
} from "./eventsub-state";

const SERVICE_ID = "twitch:eventsub:session";

/** Twitch sends session_welcome within 10 seconds of the client opening the connection, per their
 * documented EventSub WebSocket behavior. Used as-is as the default; configurable for tests. */
export const DEFAULT_WELCOME_TIMEOUT_MS = 10_000;

export const DEFAULT_EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws";

/** Matches the shape `ws`'s WebSocket client (and electron/main/services/twitch/twitch-chat-
 * service.ts's own `Socket` type) exposes — a Node EventEmitter-style API (`.on(...)`), not the
 * browser `addEventListener` one, since this runs in the Electron Main process. */
export type EventSubSocket = {
  readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
  /** Optional: `ws`'s real WebSocket client has this (it's a plain Node EventEmitter). Called
   * defensively in close() so "socket listener/timerをSession.closeで全解除" is literally true,
   * not just true-in-effect via the `#owns(socket)` guard below. */
  removeAllListeners?(event?: string): void;
};
export type EventSubSocketConstructor = new (url: string) => EventSubSocket;

export type EventSubCloseInfo = { reason: EventSubCloseReason; category: EventSubCloseCategory; message?: string };

export type EventSubSessionDeps = {
  clock?: Clock;
  welcomeTimeoutMs?: number;
  maxMessageBytes?: number;
  keepaliveGraceMs?: number;
  onStateChange?: (snapshot: EventSubSessionSnapshot) => void;
  onNotification?: (envelope: EventSubEnvelope) => void;
  onRevocation?: (envelope: EventSubEnvelope) => void;
  onReconnectRequested?: (envelope: EventSubEnvelope, reconnectUrl: string | null) => void;
  /** Fired exactly once, synchronously from inside close(), after every listener/timer this
   * session owns has already been torn down. */
  onClose?: (info: EventSubCloseInfo) => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

let sequence = 0;

export class EventSubSession {
  readonly id: string;
  readonly #url: string;
  readonly #socketFactory: EventSubSocketConstructor;
  readonly #clock: Clock;
  readonly #welcomeTimeoutMs: number;
  readonly #maxMessageBytes: number | undefined;
  readonly #keepaliveGraceMs: number | undefined;
  readonly #onStateChange: (snapshot: EventSubSessionSnapshot) => void;
  readonly #onNotification: (envelope: EventSubEnvelope) => void;
  readonly #onRevocation: (envelope: EventSubEnvelope) => void;
  readonly #onReconnectRequested: (envelope: EventSubEnvelope, reconnectUrl: string | null) => void;
  readonly #onClose: (info: EventSubCloseInfo) => void;
  readonly #log: (message: string, fields?: Record<string, unknown>) => void;

  #socket: EventSubSocket | null = null;
  #state: EventSubSessionState = "connecting";
  #sessionId: string | null = null;
  #keepaliveTimeoutSeconds: number | null = null;
  #lastMessageAtMs: number | null = null;
  #watchdog: KeepaliveWatchdog | null = null;
  #welcomeTimer: unknown = null;
  #closed = false;
  #closeInfo: EventSubCloseInfo | null = null;

  constructor(url: string, socketFactory: EventSubSocketConstructor, deps: EventSubSessionDeps = {}) {
    this.id = `eventsub-session-${Date.now()}-${++sequence}`;
    this.#url = url;
    this.#socketFactory = socketFactory;
    this.#clock = deps.clock ?? systemClock;
    this.#welcomeTimeoutMs = deps.welcomeTimeoutMs ?? DEFAULT_WELCOME_TIMEOUT_MS;
    this.#maxMessageBytes = deps.maxMessageBytes;
    this.#keepaliveGraceMs = deps.keepaliveGraceMs;
    this.#onStateChange = deps.onStateChange ?? (() => {});
    this.#onNotification = deps.onNotification ?? (() => {});
    this.#onRevocation = deps.onRevocation ?? (() => {});
    this.#onReconnectRequested = deps.onReconnectRequested ?? (() => {});
    this.#onClose = deps.onClose ?? (() => {});
    this.#log = deps.log ?? (() => {});
  }

  get snapshot(): EventSubSessionSnapshot {
    return {
      sessionId: this.#sessionId,
      state: this.#state,
      keepaliveTimeoutSeconds: this.#keepaliveTimeoutSeconds,
      lastMessageAtMs: this.#lastMessageAtMs,
      closeReason: this.#closeInfo?.reason ?? null,
      closeCategory: this.#closeInfo?.category ?? null,
    };
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Opens the underlying socket and wires every listener this session will ever have. Call once;
   * a second call is a no-op once this session has already started or closed. */
  connect(): void {
    if (this.#socket || this.#closed) return;
    let socket: EventSubSocket;
    try {
      socket = new this.#socketFactory(this.#url);
    } catch (error) {
      this.#close("socket_error", error instanceof Error ? error.message : "failed to construct EventSub WebSocket");
      return;
    }
    this.#socket = socket;
    socket.on("open", () => {
      if (!this.#owns(socket)) return;
      // "open後のwelcome timeoutを実装" — the 10-second budget starts once the socket is actually
      // open, not from connect()/socket construction (which would also count DNS/TCP handshake
      // time against Twitch's own window).
      this.#armWelcomeTimer();
      this.#setState("awaiting_welcome");
    });
    socket.on("message", (data: unknown, ...rest: unknown[]) => {
      if (!this.#owns(socket)) return;
      // ws's `message` event hands a Buffer for text frames by default (see electron/main/
      // services/twitch/twitch-chat-service.ts's identical conversion) — never assume `data` is
      // already a string.
      void rest;
      this.#onMessage(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    });
    socket.on("close", () => {
      if (!this.#owns(socket)) return;
      this.#close("socket_closed");
    });
    socket.on("error", (error: unknown) => {
      if (!this.#owns(socket)) return;
      this.#close("socket_error", error instanceof Error ? error.message : "EventSub socket error");
    });
    this.#emitState();
  }

  /** Explicit stop — never produces a recovery/reconnect signal (category "explicit_stop"; see
   * eventsub-state.ts). `reason` defaults to "explicit_stop" but callers that own the *why* (app
   * quit, this session being superseded by a fresh one, an auth-generation change) pass the more
   * specific reason so #88's future reconnect policy and any diagnostics can tell them apart. */
  close(reason: EventSubCloseReason = "explicit_stop", message?: string): void {
    this.#close(reason, message);
  }

  #owns(socket: EventSubSocket): boolean {
    return !this.#closed && this.#socket === socket;
  }

  #onMessage(raw: string): void {
    if (this.#closed) return;
    this.#lastMessageAtMs = this.#clock.now();
    const result = parseEventSubMessage(raw, { maxBytes: this.#maxMessageBytes });
    if (!result.ok) {
      this.#close("protocol_error", `${result.reason}: ${result.message}`);
      return;
    }

    if (this.#sessionId === null) {
      // welcome前の不正messageをprotocol errorへ分類: only session_welcome is acceptable as the
      // very first frame.
      if (result.kind !== "known" || result.messageType !== "session_welcome") {
        this.#close("protocol_error", `expected session_welcome as the first message, got ${result.kind === "known" ? result.messageType : `unknown:${result.messageType}`}`);
        return;
      }
      this.#handleWelcome(result.envelope);
      return;
    }

    if (result.kind === "unknown") {
      this.#log("received an unrecognized EventSub message_type; ignoring", { messageType: result.messageType });
      this.#watchdog?.reset();
      return;
    }

    switch (result.messageType) {
      case "session_welcome":
        this.#close("protocol_error", "received a second session_welcome on an already-established session");
        return;
      case "session_keepalive":
        this.#watchdog?.reset();
        return;
      case "notification":
        this.#watchdog?.reset();
        this.#onNotification(result.envelope);
        return;
      case "session_reconnect": {
        this.#watchdog?.reset();
        const reconnect = parseReconnectSession(result.envelope.payload);
        this.#onReconnectRequested(result.envelope, reconnect?.reconnectUrl ?? null);
        return;
      }
      case "revocation":
        this.#watchdog?.reset();
        this.#onRevocation(result.envelope);
        return;
    }
  }

  #handleWelcome(envelope: EventSubEnvelope): void {
    const welcome = parseWelcomeSession(envelope.payload);
    if (!welcome) {
      this.#close("protocol_error", "session_welcome payload is missing session.id/keepalive_timeout_seconds");
      return;
    }
    this.#clearWelcomeTimer();
    this.#sessionId = welcome.id;
    this.#keepaliveTimeoutSeconds = welcome.keepaliveTimeoutSeconds;
    this.#watchdog = new KeepaliveWatchdog(welcome.keepaliveTimeoutSeconds, () => this.#close("keepalive_timeout"), { clock: this.#clock, graceMs: this.#keepaliveGraceMs });
    this.#setState("connected");
  }

  #armWelcomeTimer(): void {
    this.#welcomeTimer = this.#clock.setTimeout(() => {
      this.#welcomeTimer = null;
      if (this.#closed || this.#sessionId !== null) return;
      this.#close("welcome_timeout", `no session_welcome within ${this.#welcomeTimeoutMs}ms`);
    }, this.#welcomeTimeoutMs);
  }

  #clearWelcomeTimer(): void {
    if (this.#welcomeTimer !== null) {
      this.#clock.clearTimeout(this.#welcomeTimer);
      this.#welcomeTimer = null;
    }
  }

  #setState(next: EventSubSessionState): void {
    if (next === this.#state) return;
    if (!canTransitionSessionState(this.#state, next)) throw new ServiceError("CONFLICT", `invalid EventSub session state transition: ${this.#state} -> ${next}`, { serviceId: SERVICE_ID, retryable: false });
    this.#state = next;
    this.#emitState();
  }

  /** "socket listener/timerをSession.closeで全解除" — synchronous and idempotent: every listener
   * this session registered was gated by `#owns()` above (which reads `this.#closed`/`this.#socket`
   * — both are updated here BEFORE the socket is actually asked to close), so nothing registered
   * by connect() can run again after this returns, no matter how it was triggered. */
  #close(reason: EventSubCloseReason, message?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearWelcomeTimer();
    this.#watchdog?.stop();
    this.#watchdog = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      try {
        socket.removeAllListeners?.();
      } catch {
        // best-effort: a socket implementation that throws from removeAllListeners still gets
        // close() called below, and is already unreachable via #owns() regardless.
      }
      try {
        socket.close();
      } catch (error) {
        this.#log("error while closing EventSub socket", { errorName: error instanceof Error ? error.name : typeof error });
      }
    }
    this.#closeInfo = { reason, category: closeCategoryFor(reason), ...(message ? { message } : {}) };
    this.#setState("closed");
    this.#onClose(this.#closeInfo);
  }

  #emitState(): void {
    this.#onStateChange(this.snapshot);
  }
}
