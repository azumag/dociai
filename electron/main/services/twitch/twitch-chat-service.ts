import { parseIrcFrame } from "./irc-parser";
import { ServiceError } from "../service-error";
import { ServiceRuntime } from "../service-runtime";

const TWITCH_URL = "wss://irc-ws.chat.twitch.tv:443";
let sequence = 0;
type Socket = { readyState?: number; send(data: string): void; close(): void; on(event: string, listener: (...args: any[]) => void): void };
type WebSocketConstructor = new (url: string) => Socket;
type TwitchConfig = { channels?: unknown; channel?: unknown; nick?: unknown };
const channelsOf = (config: TwitchConfig) => (Array.isArray(config.channels) ? config.channels : [config.channel]).map((value) => String(value ?? "").replace(/^#/, "").trim().toLowerCase()).filter(Boolean);

export class TwitchChatService {
  readonly runtime = new ServiceRuntime("twitch");
  private socket: Socket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private config: TwitchConfig = {};
  private channels: string[] = [];
  private stopped = true;
  private attempt = 0;
  private sessionId = "";
  constructor(private readonly WebSocketImpl: WebSocketConstructor, private readonly onEvent: (event: { type: string; payload: unknown }) => void = () => {}) {}

  start(config: TwitchConfig): { state: string; sessionId: string; channels: string[]; attempt: number } {
    this.stop(); this.config = config ?? {}; this.channels = channelsOf(this.config);
    if (!this.channels.length) throw new ServiceError("BAD_REQUEST", "Twitch channels are required", { serviceId: "twitch", retryable: false });
    this.stopped = false; this.attempt = 0; this.sessionId = `twitch-main-${Date.now()}-${++sequence}`; this.#connect("start"); return this.snapshot();
  }

  stop(): { state: string; sessionId: string; channels: string[]; attempt: number } {
    this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    const socket = this.socket; this.socket = null; try { if (socket && (socket.readyState === undefined || socket.readyState < 2)) socket.close(); } catch {}
    const snapshot = this.snapshot("stopped"); this.onEvent({ type: "twitch:status", payload: snapshot }); return snapshot;
  }

  reconnect(): boolean { if (this.stopped) return false; this.#schedule("manual", 0); return true; }
  snapshot(state = this.socket ? "connecting" : (this.stopped ? "stopped" : "retrying")) { return { state, sessionId: this.sessionId, channels: [...this.channels], attempt: this.attempt }; }

  #connect(reason: string): void {
    if (this.stopped) return; this.socket?.close(); let socket: Socket;
    try { socket = new this.WebSocketImpl(TWITCH_URL); } catch { this.#schedule("network", 1_000); return; }
    this.socket = socket; this.onEvent({ type: "twitch:status", payload: this.snapshot("connecting") });
    socket.on("open", () => {
      if (this.socket !== socket || this.stopped) return;
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands"); socket.send("PASS SCHMOOPIIE"); socket.send(`NICK ${String(this.config.nick || `justinfan${Math.floor(10000 + Math.random() * 90000)}`)}`);
      for (const channel of this.channels) socket.send(`JOIN #${channel}`);
      this.attempt = 0; this.onEvent({ type: "twitch:status", payload: this.snapshot("connected") });
    });
    socket.on("message", (data: unknown) => this.#message(socket, Buffer.isBuffer(data) ? data.toString("utf8") : String(data)));
    socket.on("close", () => { if (this.socket === socket && !this.stopped) this.#schedule(reason || "socket closed", 1_000); });
    socket.on("error", () => { if (this.socket === socket && !this.stopped) this.#schedule("socket error", 1_000); });
  }

  #message(socket: Socket, data: string): void {
    if (this.socket !== socket || this.stopped) return;
    for (const event of parseIrcFrame(data)) {
      if (event.type === "ping") socket.send(`PONG ${event.payload}`);
      if (event.type === "reconnect") { try { socket.close(); } catch {} this.#schedule("server requested reconnect", 0); }
      // "bits" (issue #177): forwarded through to the Renderer's "twitch:comment" event unchanged
      // (src/platform/electron-services.js's ElectronTwitchSource passes the whole payload through)
      // so src/trigger-engine.js's handleComment() can recognize and exclude a cheer's own chat
      // message from firing a duplicate AI response — see that file's own header comment.
      if (event.type === "privmsg") this.onEvent({ type: "twitch:comment", payload: { author: event.author, text: event.text, source: "twitch", channel: event.channel, sessionId: this.sessionId, emotes: event.emotes ?? null, bits: event.bits ?? null } });
    }
  }

  #schedule(reason: string, minimumDelay: number): void {
    if (this.stopped || this.timer) return; this.socket = null;
    const delay = minimumDelay === 0 ? 0 : Math.min(30_000, Math.max(minimumDelay, 500 * (2 ** this.attempt))); this.attempt += 1;
    this.onEvent({ type: "twitch:status", payload: this.snapshot("retrying") }); this.timer = setTimeout(() => { this.timer = null; this.#connect(reason); }, delay);
  }

  dispose(): void { this.stop(); this.runtime.dispose(); }
}
