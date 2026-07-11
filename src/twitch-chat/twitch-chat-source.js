import { ReconnectPolicy } from "./reconnect-policy.js";
import { TwitchChatSession } from "./twitch-chat-session.js";
import { twitchHealth } from "./twitch-chat-health.js";

const systemClock = { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (timer) => clearTimeout(timer) };
const defaultPlatform = {
  isOnline: () => globalThis.navigator?.onLine !== false,
  subscribe({ online, offline, resume }) {
    globalThis.addEventListener?.("online", online);
    globalThis.addEventListener?.("offline", offline);
    const visibility = () => { if (globalThis.document?.visibilityState === "visible") resume(); };
    globalThis.document?.addEventListener?.("visibilitychange", visibility);
    return () => {
      globalThis.removeEventListener?.("online", online);
      globalThis.removeEventListener?.("offline", offline);
      globalThis.document?.removeEventListener?.("visibilitychange", visibility);
    };
  },
};

export class TwitchChatSource {
  id = "twitch";
  label = "Twitch";
  constructor(config = {}, { WebSocketImpl = globalThis.WebSocket, SessionImpl = TwitchChatSession, log = () => {}, onStatus = () => {}, clock = systemClock, platform = defaultPlatform, random = Math.random } = {}) {
    this.config = config;
    this.WebSocketImpl = WebSocketImpl;
    this.SessionImpl = SessionImpl;
    this.log = log;
    this.onStatus = onStatus;
    this.clock = clock;
    this.platform = platform;
    this.policy = new ReconnectPolicy({ ...(config.reconnect ?? {}), random });
    this.session = null;
    this.ws = null;
    this.onComment = null;
    this.status = { state: "idle", channels: [], attempt: 0, nextRetryAt: null, offline: false, lastActivityAt: null };
    this.retryTimer = null;
    this.attempt = 0;
    this.stopped = true;
    this.permanentFailure = false;
    this.unsubscribePlatform = null;
  }

  start(onComment) {
    this.stop();
    this.stopped = false;
    this.permanentFailure = false;
    this.onComment = onComment;
    this.unsubscribePlatform = this.platform.subscribe({ online: () => this.#online(), offline: () => this.#offline(), resume: () => this.#resume() });
    if (this.platform.isOnline()) this.#connect("start");
    else this.#offline();
  }
  stop() {
    this.stopped = true;
    this.#clearRetry();
    this.unsubscribePlatform?.();
    this.unsubscribePlatform = null;
    this.session?.stop();
    this.session = null;
    this.ws = null;
    this.onComment = null;
    this.#publish({ state: "stopped", nextRetryAt: null });
  }
  reconnectNow() { if (this.stopped || !this.platform.isOnline()) return false; this.#clearRetry(); this.attempt = 0; this.permanentFailure = false; this.#connect("manual"); return true; }
  snapshot() { return { ...this.status, channels: (this.status.channels ?? []).map((entry) => ({ ...entry })) }; }

  #connect(reason) {
    if (this.stopped || this.permanentFailure || !this.platform.isOnline()) return;
    this.#clearRetry();
    this.session?.stop();
    const session = this.session = new this.SessionImpl(this.config, {
      WebSocketImpl: this.WebSocketImpl,
      log: this.log,
      onComment: (raw) => {
        if (this.session !== session || this.stopped) return;
        const { sessionId, emotes, ...comment } = raw;
        this.onComment?.({ ...comment, ...(emotes ? { emotes } : {}) });
      },
      onStatus: (status) => {
        if (this.session !== session || this.stopped) return;
        if (this.retryTimer && (status.state === "error" || status.state === "stopped")) return;
        const now = this.clock.now();
        const connected = status.state === "connected";
        if (connected && this.status.connectedAt && now - this.status.connectedAt >= this.policy.resetAfterMs) this.attempt = 0;
        const channels = status.channels ?? [];
        const allPermanent = channels.length > 0 && channels.every((entry) => entry.status === "failed" && entry.permanent);
        this.#publish({ ...status, connectedAt: connected ? (this.status.connectedAt ?? now) : null, lastActivityAt: status.lastActivityAt ?? this.status.lastActivityAt, attempt: this.attempt, nextRetryAt: null, offline: false });
        if (allPermanent) { this.permanentFailure = true; this.#clearRetry(); this.session?.stop(); }
      },
      onDisconnect: (event) => { if (this.session === session) this.#schedule(event); },
      now: this.clock.now,
    });
    this.ws = session.socket;
    this.#publish({ state: "connecting", reason, nextRetryAt: null, offline: false });
    session.start();
    this.ws = session.socket;
  }
  #schedule({ reason = "socket closed", immediate = false, permanent = false } = {}) {
    if (this.stopped || permanent || !this.platform.isOnline() || this.retryTimer) return false;
    if (this.status.connectedAt && this.clock.now() - this.status.connectedAt >= this.policy.resetAfterMs) this.attempt = 0;
    const delay = immediate ? 0 : this.policy.delay(++this.attempt);
    const nextRetryAt = this.clock.now() + delay;
    this.#publish({ state: "retrying", reason, attempt: this.attempt, nextRetryAt });
    this.retryTimer = this.clock.setTimeout(() => { this.retryTimer = null; this.#connect(reason); }, delay);
    return true;
  }
  #clearRetry() { if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer); this.retryTimer = null; }
  #offline() { if (this.stopped) return; this.#clearRetry(); this.session?.stop(); this.session = null; this.ws = null; this.#publish({ state: "offline", offline: true, nextRetryAt: null }); }
  #online() { if (!this.stopped) { this.#publish({ offline: false }); this.#connect("online"); } }
  #resume() { if (this.stopped || this.permanentFailure || !this.platform.isOnline()) return; const staleAfter = Number(this.config.staleAfterMs ?? 90_000); if (!this.status.lastActivityAt || this.clock.now() - this.status.lastActivityAt > staleAfter) this.#connect("resume-stale"); }
  #publish(patch) { this.status = { ...this.status, ...patch }; this.status.health = twitchHealth(this.status); this.onStatus(this.snapshot()); }
}
