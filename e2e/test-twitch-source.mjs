import assert from "node:assert/strict";
import { validateConfig, applyDefaults } from "../src/config-loader.js";
import { TwitchChatSource, parseTwitchIrcLine } from "../src/comment-sources.js";

class MockWebSocket {
  static instances = [];

  readyState = 0;
  sent = [];
  listeners = new Map();

  constructor(url) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  send(line) {
    this.sent.push(line);
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data) {
    this.emit("message", { data });
  }
}

const parsed = parseTwitchIrcLine("@display-name=Azuma;badges= :azuma!azuma@azuma.tmi.twitch.tv PRIVMSG #DocIAI :AIさんこんにちは");
assert.deepEqual(parsed, {
  type: "message",
  author: "Azuma",
  text: "AIさんこんにちは",
  channel: "dociai",
});
assert.deepEqual(parseTwitchIrcLine("PING :tmi.twitch.tv"), { type: "ping", payload: ":tmi.twitch.tv" });
assert.equal(parseTwitchIrcLine(":tmi.twitch.tv 001 justinfan :Welcome"), null);

const baseConfig = {
  connectors: { mock_main: { provider: "mock" } },
  personas: [{ id: "p", name: "P", connector: "mock_main", systemPrompt: "test" }],
  triggers: { manual: { type: "manual" } },
  commentSources: {
    twitch: {
      enabled: true,
      channels: ["#DocIAI"],
      nick: "justinfan12345",
    },
  },
};

const validation = validateConfig(baseConfig);
assert.deepEqual(validation.errors, []);
const config = applyDefaults(baseConfig);
assert.equal(config.commentSources.twitch.enabled, true);

const received = [];
const logs = [];
const source = new TwitchChatSource(config.commentSources.twitch, {
  WebSocketImpl: MockWebSocket,
  log: (message, level = "info") => logs.push({ message, level }),
});
source.start((raw) => received.push(raw));

const ws = MockWebSocket.instances.at(-1);
assert.equal(ws.url, "wss://irc-ws.chat.twitch.tv:443");
ws.open();
assert.deepEqual(ws.sent, [
  "CAP REQ :twitch.tv/tags twitch.tv/commands",
  "PASS SCHMOOPIIE",
  "NICK justinfan12345",
  "JOIN #dociai",
]);
assert.ok(logs.some((entry) => entry.message.includes("#dociai")));

ws.message("PING :tmi.twitch.tv\r\n@display-name=Azuma :azuma!azuma@azuma.tmi.twitch.tv PRIVMSG #dociai :AIさんこんにちは\r\n");
assert.equal(ws.sent.at(-1), "PONG :tmi.twitch.tv");
assert.deepEqual(received, [
  {
    author: "Azuma",
    text: "AIさんこんにちは",
    source: "twitch",
    channel: "dociai",
  },
]);

source.stop();
assert.equal(ws.readyState, 3);

const invalid = validateConfig({
  ...baseConfig,
  commentSources: { twitch: { enabled: true, channels: [] } },
});
assert.ok(invalid.errors.some((error) => error.includes("commentSources.twitch.enabled")));

console.log("PASS | twitch comment source");
