import { ChannelMembership } from "./channel-membership.js";
import { parseIrcFrame } from "./twitch-irc-parser.js";
import { TwitchChatState } from "./twitch-chat-state.js";
import { classifyNotice } from "./twitch-chat-errors.js";

let sequence = 0;
const channel = (value) => String(value ?? "").trim().replace(/^#/, "").toLowerCase();
const guestNick = () => `justinfan${Math.floor(10000 + Math.random() * 90000)}`;

export class TwitchChatSession {
  constructor(config = {}, { WebSocketImpl = globalThis.WebSocket, log = () => {}, onComment = () => {}, onStatus = () => {}, onDisconnect = () => {}, now = Date.now } = {}) {
    this.id = `twitch-session-${++sequence}`;
    this.WebSocketImpl = WebSocketImpl;
    this.log = log;
    this.onComment = onComment;
    this.onStatus = onStatus;
    this.onDisconnect = onDisconnect;
    this.now = now;
    this.url = config.url || "wss://irc-ws.chat.twitch.tv:443";
    this.nick = config.nick || guestNick();
    this.channels = (config.channels ?? [config.channel]).map(channel).filter(Boolean);
    this.state = new TwitchChatState();
    this.membership = new ChannelMembership(this.channels);
    this.socket = null;
    this.active = false;
    this.parserErrors = 0;
    this.lastActivityAt = null;
    this.disconnectNotified = false;
  }

  start() {
    if (this.active) return false;
    if (!this.WebSocketImpl) throw new Error("このブラウザはWebSocketに対応していません");
    if (!this.channels.length) throw new Error("Twitchチャンネルが設定されていません");
    this.active = true;
    this.state.transition("connecting", "start");
    const socket = this.socket = new this.WebSocketImpl(this.url);
    socket.addEventListener("open", () => { if (this.#owns(socket)) this.#open(); });
    socket.addEventListener("message", (event) => { if (this.#owns(socket)) this.#message(event.data); });
    socket.addEventListener("error", () => { if (this.#owns(socket)) this.#error("socket error"); });
    socket.addEventListener("close", () => { if (this.#owns(socket)) this.#closed(); });
    this.#status();
    return true;
  }

  stop() {
    if (!this.active && !this.socket) return false;
    this.active = false;
    const socket = this.socket;
    this.socket = null;
    this.state.transition("stopped", "stop");
    if (socket && socket.readyState < 2) socket.close();
    this.#status();
    return true;
  }

  snapshot() { return { sessionId: this.id, state: this.state.value, parserErrors: this.parserErrors, channels: this.membership.snapshot(), lastActivityAt: this.lastActivityAt }; }
  #owns(socket) { return this.active && this.socket === socket; }
  #send(line) { if (this.socket?.readyState === 1) this.socket.send(line); }
  #open() {
    this.state.transition("authenticating", "socket open");
    this.#send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    this.#send("PASS SCHMOOPIIE");
    this.#send(`NICK ${this.nick}`);
    this.state.transition("joining", "anonymous credentials sent");
    for (const name of this.channels) this.#send(`JOIN #${name}`);
    this.log(`Twitchチャットに接続しました: ${this.channels.map((name) => `#${name}`).join(", ")}`);
    this.#status();
  }
  #message(frame) {
    this.lastActivityAt = this.now();
    for (const event of parseIrcFrame(frame)) {
      if (event.type === "malformed" || event.type === "unknown") { this.parserErrors += 1; continue; }
      if (event.type === "ping") { this.#send(`PONG ${event.payload}`); continue; }
      if (event.type === "reconnect") { this.#disconnect("server requested reconnect", { immediate: true }); this.stop(); return; }
      if (event.type === "join" && event.login === this.nick.toLowerCase()) this.membership.joined(event.channel);
      if (event.type === "part" && event.login === this.nick.toLowerCase()) this.membership.parted(event.channel);
      if (event.type === "notice" && event.channel) { const failure = classifyNotice(event); this.membership.failed(event.channel, failure.message, { permanent: failure.permanent, code: failure.code }); }
      // "bits" tag (issue #177): present on a real cheer's own chat PRIVMSG line — Twitch delivers a
      // cheer's message text (if any) as an ordinary chat message the user typed using a Cheermote,
      // WITH this tag, in addition to the separate channel.cheer EventSub notification. Forwarded
      // through so a comment consumer (src/trigger-engine.js's handleComment()) can recognize and
      // exclude it from firing a SECOND, duplicate AI response for the same real-world cheer — see
      // that file's own header comment for the full double-fire investigation.
      if (event.type === "privmsg") { this.membership.message(event.channel); this.onComment({ author: event.author, text: event.text, source: "twitch", channel: event.channel, emotes: event.emotes, bits: event.tags?.bits ? Number(event.tags.bits) : null, sessionId: this.id }); }
      if (this.membership.allJoined()) this.state.transition("connected", "channel membership resolved");
    }
    this.#status();
  }
  #error(reason) { this.state.transition("error", reason); this.log(`Twitchチャット接続でエラーが発生しました: ${reason}`, "error"); this.#status(); this.#disconnect(reason); }
  #closed() { if (!this.active) return; this.#error("socket closed"); }
  #disconnect(reason, options = {}) { if (this.disconnectNotified) return; this.disconnectNotified = true; this.onDisconnect({ reason, ...options }); }
  #status() { this.onStatus(this.snapshot()); }
}
