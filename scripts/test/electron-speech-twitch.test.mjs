import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadModules() {
  const result = await build({ stdin: { contents: `export { VoiceVoxService } from "./electron/main/services/speech/voicevox-service.ts"; export { BouyomiService } from "./electron/main/services/speech/bouyomi-service.ts"; export { TwitchChatService } from "./electron/main/services/twitch/twitch-chat-service.ts";`, resolveDir: path.resolve(new URL("../..", import.meta.url).pathname), sourcefile: "speech-twitch-test.ts", loader: "ts" }, bundle: true, format: "esm", platform: "node", write: false });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-speech-twitch-")); const file = path.join(directory, "modules.mjs"); await fs.writeFile(file, result.outputFiles[0].text); return { modules: await import(file), directory };
}

test("Main speech services validate local endpoints and return safe results", async () => {
  const { modules, directory } = await loadModules();
  try {
    const calls = [];
    const fetchFn = async (url, init = {}) => { calls.push({ url: String(url), init }); if (String(url).includes("speakers")) return new Response(JSON.stringify([{ name: "Speaker", styles: [{ id: 3, name: "Normal" }] }]), { status: 200 }); if (String(url).includes("audio_query")) return new Response(JSON.stringify({ accent_phrases: [], pitchScale: 0 }), { status: 200 }); if (String(url).includes("synthesis")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/wav" } }); return new Response("", { status: 200 }); };
    const voicevox = new modules.VoiceVoxService(fetchFn); assert.equal((await voicevox.speakers()).speakers[0].label, "Speaker / Normal"); assert.equal((await voicevox.synthesize({ text: "hello", speaker: 3 })).audio.byteLength, 3); await assert.rejects(voicevox.synthesize({ text: "hello", speaker: 3, baseUrl: "https://example.com" }), /local HTTP URL/);
    const bouyomi = new modules.BouyomiService(fetchFn); assert.equal((await bouyomi.talk({ text: "hello" })).submitted, true); assert.equal((await bouyomi.clear()).cleared, true); assert.ok(calls.every(({ url }) => new URL(url).hostname === "127.0.0.1"));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("Main Twitch service handles PING, PRIVMSG, reconnect, and stop", async () => {
  const { modules, directory } = await loadModules();
  try {
    const events = [];
    class FakeSocket { static instances = []; readyState = 1; listeners = new Map(); sent = []; constructor(url) { this.url = url; FakeSocket.instances.push(this); } on(type, listener) { this.listeners.set(type, listener); } send(value) { this.sent.push(value); } close() { this.readyState = 3; this.listeners.get("close")?.(); } emit(type, value) { this.listeners.get(type)?.(value); } }
    const service = new modules.TwitchChatService(FakeSocket, (event) => events.push(event)); service.start({ channels: ["#room"] }); const socket = FakeSocket.instances[0]; socket.emit("open"); socket.emit("message", ":server PING :token\r\n@display-name=Alice :alice!u@h PRIVMSG #room :hello\r\n"); assert.ok(socket.sent.includes("PONG :token")); const helloComment = events.find((event) => event.type === "twitch:comment"); assert.equal(helloComment.payload.text, "hello"); assert.equal(helloComment.payload.bits, null, "issue #177: an ordinary chat message must not carry a bits value");
    // Issue #177 double-fire investigation: a real cheer's own chat message carries a "bits" IRC
    // tag — forwarded through unchanged so src/trigger-engine.js's handleComment() can exclude it
    // from firing a duplicate AI response alongside the separate channel.cheer EventSub event.
    socket.emit("message", "@display-name=Cheerer;bits=100 :cheerer!u@h PRIVMSG #room :Cheer100 nice stream!\r\n");
    const cheerComment = events.filter((event) => event.type === "twitch:comment").at(-1);
    assert.equal(cheerComment.payload.text, "Cheer100 nice stream!");
    assert.equal(cheerComment.payload.bits, 100);
    service.stop(); assert.equal(service.snapshot().state, "stopped"); assert.equal(socket.url, "wss://irc-ws.chat.twitch.tv:443");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
