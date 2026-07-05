// コメントソースアダプタ (issue #11)
// 手動入力も実配信コメントも、同じインターフェースで CommentStore に流し込む。
//
// CommentSource インターフェース:
//   id: string                  — ソース識別子 (comment.source に入る)
//   label: string               — UI表示名
//   start(onComment): void      — onComment({ author, text, source }) を呼び始める
//   stop(): void                — 取得を止める
//
// YouTube Live Chat / Twitch IRC の実装方針は docs/comment-sources.md を参照。

export class ManualCommentSource {
  id = "manual";
  label = "手動入力";

  start(onComment) {
    this.onComment = onComment;
  }

  stop() {
    this.onComment = null;
  }

  // UIの入力フォームから呼ぶ
  submit({ author, text }) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed || !this.onComment) return null;
    return this.onComment({
      author: String(author ?? "").trim() || "名無し",
      text: trimmed,
      source: this.id,
    });
  }
}

function normalizeChannel(channel) {
  return String(channel ?? "").trim().replace(/^#/, "").toLowerCase();
}

function randomGuestNick() {
  return `justinfan${Math.floor(10000 + Math.random() * 90000)}`;
}

function parseTags(raw) {
  const tags = {};
  for (const part of raw.split(";")) {
    const [key, ...value] = part.split("=");
    if (!key) continue;
    tags[key] = value.join("=")
      .replace(/\\s/g, " ")
      .replace(/\\:/g, ";")
      .replace(/\\\\/g, "\\");
  }
  return tags;
}

export function parseTwitchIrcLine(line) {
  let rest = String(line ?? "").trim();
  if (!rest) return null;
  if (rest.startsWith("PING ")) {
    return { type: "ping", payload: rest.slice(5).trim() };
  }

  let tags = {};
  if (rest.startsWith("@")) {
    const tagEnd = rest.indexOf(" ");
    tags = parseTags(rest.slice(1, tagEnd));
    rest = rest.slice(tagEnd + 1);
  }

  const match = rest.match(/^:([^!\s]+)(?:![^\s]+)?\s+PRIVMSG\s+#([^\s]+)\s+:(.*)$/);
  if (!match) return null;

  const [, login, channel, text] = match;
  return {
    type: "message",
    author: tags["display-name"] || login,
    text,
    channel: normalizeChannel(channel),
  };
}

export class TwitchChatSource {
  id = "twitch";
  label = "Twitch";

  constructor(config = {}, { WebSocketImpl = globalThis.WebSocket, log = () => {} } = {}) {
    this.config = config;
    this.WebSocketImpl = WebSocketImpl;
    this.log = log;
    this.ws = null;
    this.onComment = null;
    this.channels = (config.channels ?? [config.channel]).map(normalizeChannel).filter(Boolean);
    this.nick = config.nick || randomGuestNick();
    this.url = config.url || "wss://irc-ws.chat.twitch.tv:443";
  }

  start(onComment) {
    if (!this.channels.length) throw new Error("Twitchチャンネルが設定されていません");
    if (!this.WebSocketImpl) throw new Error("このブラウザはWebSocketに対応していません");
    this.stop();
    this.onComment = onComment;
    this.ws = new this.WebSocketImpl(this.url);
    this.ws.addEventListener("open", () => this.#onOpen());
    this.ws.addEventListener("message", (event) => this.#onMessage(event.data));
    this.ws.addEventListener("error", () => this.log("Twitchチャット接続でエラーが発生しました", "error"));
    this.ws.addEventListener("close", () => this.log("Twitchチャット接続を終了しました"));
  }

  stop() {
    const ws = this.ws;
    this.ws = null;
    this.onComment = null;
    if (ws && ws.readyState < 2) ws.close();
  }

  #send(line) {
    if (this.ws?.readyState === 1) this.ws.send(line);
  }

  #onOpen() {
    this.#send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    this.#send("PASS SCHMOOPIIE");
    this.#send(`NICK ${this.nick}`);
    for (const channel of this.channels) this.#send(`JOIN #${channel}`);
    this.log(`Twitchチャットに接続しました: ${this.channels.map((c) => `#${c}`).join(", ")}`);
  }

  #onMessage(data) {
    for (const line of String(data ?? "").split(/\r?\n/)) {
      const parsed = parseTwitchIrcLine(line);
      if (!parsed) continue;
      if (parsed.type === "ping") {
        this.#send(`PONG ${parsed.payload}`);
        continue;
      }
      this.onComment?.({
        author: parsed.author,
        text: parsed.text,
        source: this.id,
        channel: parsed.channel,
      });
    }
  }
}

// 将来のYouTubeアダプタもこの形で追加する:
// export class YouTubeChatSource { id = "youtube"; start(onComment) { /* liveChatMessages polling */ } stop() {} }
