import assert from "node:assert/strict";
import { BouyomiClient, BouyomiError } from "../src/bouyomi.js";
import { applyDefaults, validateConfig } from "../src/config-loader.js";
import { SpeechQueue } from "../src/speech-queue.js";

let request;
globalThis.fetch = async (url) => {
  request = new URL(url);
  return { ok: true, status: 200 };
};

const client = new BouyomiClient({ baseUrl: "http://127.0.0.1:50080/", timeoutMs: 1234 });
await client.talk("テスト読み上げ", { voice: 2, volume: 80, speed: 120, tone: 90 });
assert.equal(request.pathname, "/Talk");
assert.equal(request.searchParams.get("text"), "テスト読み上げ");
assert.equal(request.searchParams.get("voice"), "2");
assert.equal(request.searchParams.get("volume"), "80");
assert.equal(request.searchParams.get("speed"), "120");
assert.equal(request.searchParams.get("tone"), "90");

await client.clear();
assert.equal(request.pathname, "/Clear");

const bridged = [];
const bridgeClient = new BouyomiClient({ bridge: {
  talk: async (payload) => { bridged.push(payload); return { ok: true }; },
  clear: async () => ({ ok: true }),
} });
await bridgeClient.talk("Electron経由");
assert.equal(bridged[0].text, "Electron経由");

const queue = new SpeechQueue({ bouyomi: bridgeClient });
const queued = queue.enqueue({ personaId: "reader", personaName: "コメント読み上げ", text: "キュー経由", voice: { engine: "bouyomi" } });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(bridged.at(-1).text, "キュー経由");
// /Talk自体は即応答するが、実際の再生完了通知が無いため見積もり時間分は "speaking" のまま保持され、
// 他backendとの被り (コメント読み上げとAI読み上げの重複) を防ぐ
assert.equal(queued.state, "speaking");
await new Promise((resolve) => setTimeout(resolve, 1000));
assert.equal(queued.state, "submitted");

const cfg = applyDefaults({
  connectors: { mock: { provider: "mock" } },
  personas: [{ id: "p", name: "P", connector: "mock", voice: { engine: "bouyomi" } }],
  triggers: {},
  bouyomi: { enabled: true },
  commentReader: { enabled: true, engine: "bouyomi" },
});
assert.equal(cfg.bouyomi.baseUrl, "http://127.0.0.1:50080");
assert.deepEqual(validateConfig(cfg).errors, []);

globalThis.fetch = async () => { throw new TypeError("offline"); };
await assert.rejects(() => client.talk("失敗"), (error) => error instanceof BouyomiError && error.kind === "network");

console.log("PASS | 棒読みちゃん /Talk・/Clear・Electron bridge・設定検証");
