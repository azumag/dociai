import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

class FakeSocket {
  static instances = [];
  readyState = 0;
  sent = [];
  listeners = new Map();
  constructor(url) { this.url = url; FakeSocket.instances.push(this); }
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  send(line) { this.sent.push(line); }
  close() { this.readyState = 3; this.emit("close", {}); }
  emit(type, payload) { for (const callback of this.listeners.get(type) ?? []) callback(payload); }
  open() { this.readyState = 1; this.emit("open", {}); }
  message(data) { this.emit("message", { data }); }
}

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { decodeIrcTag, parseIrcFrame, parseIrcTags } from "./src/twitch-chat/twitch-irc-parser.js"; export { TwitchChatSession } from "./src/twitch-chat/twitch-chat-session.js"; export { TwitchChatSource, parseTwitchIrcLine } from "./src/comment-sources.js";`,
      resolveDir: path.resolve(new URL("../..", import.meta.url).pathname),
      sourcefile: "twitch-chat-test.js",
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-twitch-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

test("IRCv3 parser handles escaped tags, multiline frames, and nonfatal unknown lines", async () => {
  const { modules, directory } = await loadModules();
  try {
    assert.equal(modules.decodeIrcTag("one\\stwo\\:three\\r\\n\\\\"), "one two;three\r\n\\");
    const events = modules.parseIrcFrame("PING :tmi.twitch.tv\r\n@display-name=Foo\\sBar;emotes=1:0-2 :foo!foo@foo PRIVMSG #Channel :Kappa hello\r\n:foo!foo@foo PART #channel\r\n@emote-only=1 :tmi.twitch.tv ROOMSTATE #channel\r\n@msg-id=msg_banned :tmi.twitch.tv NOTICE #channel :banned\r\n:tmi.twitch.tv RECONNECT\r\nBROKENCOMMAND\r\n");
    assert.equal(events[0].type, "ping");
    assert.deepEqual(events[1], { type: "privmsg", login: "foo", author: "Foo Bar", channel: "channel", text: "Kappa hello", emotes: "1:0-2", tags: { "display-name": "Foo Bar", emotes: "1:0-2" } });
    assert.equal(events[2].type, "part");
    assert.equal(events[3].type, "roomstate");
    assert.equal(events[4].type, "notice");
    assert.equal(events[5].type, "reconnect");
    assert.equal(events[6].type, "unknown");
    assert.deepEqual(modules.parseTwitchIrcLine("PING :tmi.twitch.tv"), { type: "ping", payload: ":tmi.twitch.tv" });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("Twitch session owns one socket, tracks membership, and ignores stopped callbacks", async () => {
  const { modules, directory } = await loadModules();
  try {
    const comments = [];
    const statuses = [];
    const session = new modules.TwitchChatSession({ channels: ["One", "Two"], nick: "justinfan12345" }, { WebSocketImpl: FakeSocket, onComment: (comment) => comments.push(comment), onStatus: (status) => statuses.push(status) });
    assert.equal(session.start(), true);
    assert.equal(session.start(), false);
    const socket = session.socket;
    socket.open();
    assert.deepEqual(socket.sent, ["CAP REQ :twitch.tv/tags twitch.tv/commands", "PASS SCHMOOPIIE", "NICK justinfan12345", "JOIN #one", "JOIN #two"]);
    socket.message(":justinfan12345!j@j JOIN #one\r\n:justinfan12345!j@j JOIN #two\r\n@display-name=Viewer :viewer!v@v PRIVMSG #one :hello\r\n");
    assert.equal(session.snapshot().state, "connected");
    assert.deepEqual(session.snapshot().channels.map((entry) => entry.status), ["joined", "joined"]);
    assert.deepEqual(comments, [{ author: "Viewer", text: "hello", source: "twitch", channel: "one", emotes: null, sessionId: session.id }]);
    socket.message("UNKNOWNCOMMAND value\r\n");
    assert.equal(session.snapshot().parserErrors, 1);
    assert.equal(session.stop(), true);
    socket.message("@display-name=Old :old!o@o PRIVMSG #one :ignored\r\n");
    assert.equal(comments.length, 1);
    assert.ok(statuses.length > 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("Twitch source replaces an old session without allowing its messages through", async () => {
  const { modules, directory } = await loadModules();
  try {
    const received = [];
    const source = new modules.TwitchChatSource({ channels: ["channel"], nick: "justinfan12345" }, { WebSocketImpl: FakeSocket });
    source.start((comment) => received.push(comment));
    const first = source.ws;
    first.open();
    source.start((comment) => received.push(comment));
    const second = source.ws;
    second.open();
    first.message("@display-name=Old :old!o@o PRIVMSG #channel :ignored\r\n");
    second.message("@display-name=New :new!n@n PRIVMSG #channel :accepted\r\n");
    assert.deepEqual(received.map((comment) => comment.text), ["accepted"]);
    source.stop();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
