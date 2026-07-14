import assert from "node:assert/strict";
import test from "node:test";
import { BackendRegistry } from "../../src/speech/backends/backend-registry.js";
import { BouyomiBackend, estimateBouyomiSpeakMs } from "../../src/speech/backends/bouyomi-backend.js";
import { VoiceVoxBackend } from "../../src/speech/backends/voicevox-backend.js";
import { WebSpeechBackend } from "../../src/speech/backends/web-speech-backend.js";
import { SpeechQueue } from "../../src/speech-queue.js";

class FakeUtterance { constructor(text) { this.text = text; FakeUtterance.items.push(this); } static items = []; }

test("Web Speech classifies completion, cancellation, error, and stale callbacks", async () => {
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const backend = new WebSpeechBackend({ synthesis, Utterance: FakeUtterance });
  const first = backend.play({ text: "one", voice: {} }, { executionId: "one" });
  const old = FakeUtterance.items.at(-1);
  const second = backend.play({ text: "two", voice: {} }, { executionId: "two" });
  assert.equal((await first).state, "cancelled");
  const current = FakeUtterance.items.at(-1);
  old.onend();
  current.onend();
  assert.equal((await second).state, "done");
  const failed = backend.play({ text: "bad", voice: {} }, { executionId: "bad" });
  FakeUtterance.items.at(-1).onerror({ error: "network" });
  assert.equal((await failed).state, "failed");
});

test("Bouyomi reports submitted and exposes remote clear", async () => {
  let cleared = 0;
  const backend = new BouyomiBackend({ talk: async () => ({ ok: true }), clear: async () => { cleared++; } }, { wait: async () => {} });
  assert.equal((await backend.play({ text: "hello", voice: {} }, { executionId: "b1" })).state, "submitted");
  await backend.clear();
  assert.equal(cleared, 1);
  assert.equal(backend.capabilities.reportsPlaybackCompletion, false);
});

test("estimateBouyomiSpeakMs scales with text length and speed, within a floor and ceiling", () => {
  assert.equal(estimateBouyomiSpeakMs("", 100), 400);
  assert.ok(estimateBouyomiSpeakMs("あ".repeat(60), 100) > estimateBouyomiSpeakMs("あ".repeat(30), 100));
  assert.ok(estimateBouyomiSpeakMs("あ".repeat(60), 200) < estimateBouyomiSpeakMs("あ".repeat(60), 100));
  assert.equal(estimateBouyomiSpeakMs("あ".repeat(10000), 100), 60_000);
});

test("Bouyomi waits out the estimated speaking time before reporting completion, but cancel interrupts it immediately", async () => {
  const waited = [];
  const backend = new BouyomiBackend({ talk: async () => ({ ok: true }) }, {
    wait: (ms, signal) => { waited.push(ms); return new Promise((resolve) => { if (signal?.aborted) return resolve(); signal?.addEventListener("abort", resolve, { once: true }); resolve(); }); },
  });
  const result = await backend.play({ text: "コメントを読み上げます", voice: {} }, { executionId: "b1" });
  assert.equal(result.state, "submitted");
  assert.equal(waited.length, 1);
  assert.ok(waited[0] > 0);

  const slowBackend = new BouyomiBackend({ talk: async () => ({ ok: true }) });
  const playPromise = slowBackend.play({ text: "あ".repeat(500), voice: {} }, { executionId: "long" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const startedCancelAt = Date.now();
  slowBackend.cancel("long");
  const cancelled = await playPromise;
  assert.equal(cancelled.state, "cancelled");
  assert.ok(Date.now() - startedCancelAt < 500, "推定発話時間(最大60秒)を待たずにキャンセルされる");
});

test("SpeechQueue keeps a later backend silent until Bouyomi's estimated comment-reading time elapses", async () => {
  FakeUtterance.items = [];
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const bouyomiClient = { talk: async () => ({ ok: true }), clear: async () => {} };
  const queue = new SpeechQueue({ webSpeech: { synthesis, Utterance: FakeUtterance }, bouyomi: bouyomiClient });

  const comment = queue.enqueue({ personaId: "reader", personaName: "コメント読み上げ", text: "a", voice: { engine: "bouyomi" } });
  const aiReply = queue.enqueue({ personaId: "ai", personaName: "AI", text: "reply", voice: { engine: "webspeech" } });
  assert.equal(comment.state, "speaking");
  assert.equal(aiReply.state, "waiting");

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(aiReply.state, "waiting", "棒読みちゃんの推定発話時間中はAI応答を開始しない (音声の被り防止)");
  assert.equal(FakeUtterance.items.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(comment.state, "submitted");
  assert.equal(aiReply.state, "speaking");
  assert.equal(FakeUtterance.items.length, 1);

  FakeUtterance.items.at(-1).onend();
  await Promise.resolve();
  assert.equal(aiReply.state, "done");
  queue.dispose();
});

test("VOICEVOX owns and releases audio listeners and Blob URLs", async () => {
  const revoked = [];
  let urlSequence = 0;
  class FakeAudio {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
    play() { queueMicrotask(() => this.listeners.get("ended")?.()); return Promise.resolve(); }
    pause() {}
  }
  const backend = new VoiceVoxBackend({ synth: async () => new Blob(["wav"]) }, {
    AudioImpl: FakeAudio,
    urlApi: { createObjectURL: () => `blob:${++urlSequence}`, revokeObjectURL: (url) => revoked.push(url) },
  });
  for (let index = 0; index < 100; index++) {
    assert.equal((await backend.play({ text: "テスト。", voice: { speaker: 1 } }, { executionId: `v${index}` })).state, "done");
    assert.equal(backend.execution, null);
  }
  assert.equal(revoked.length, 100);
});

test("registry rejects or warns about mixed Bouyomi ordering", () => {
  assert.throws(() => new BackendRegistry({ strictOrdering: true }).validateMix(["bouyomi", "webspeech"]), /順序は保証できません/);
  const warnings = [];
  new BackendRegistry({ onWarning: (warning) => warnings.push(warning) }).validateMix(["bouyomi", "voicevox"]);
  assert.equal(warnings.length, 1);
});

test("SpeechQueue resumes held Web Speech from the beginning and guards strict mixing", async () => {
  FakeUtterance.items = [];
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const queue = new SpeechQueue({ webSpeech: { synthesis, Utterance: FakeUtterance }, strictOrdering: true });
  const item = queue.enqueue({ text: "resume me", voice: { engine: "webspeech" } });
  assert.equal(item.state, "speaking");
  queue.stop();
  await Promise.resolve();
  assert.equal(item.state, "waiting");
  queue.resume();
  assert.equal(item.state, "speaking");
  FakeUtterance.items.at(-1).onend();
  await Promise.resolve();
  assert.equal(item.state, "done");

  const mixed = new SpeechQueue({ webSpeech: { synthesis, Utterance: FakeUtterance }, bouyomi: { talk: async () => {}, clear: async () => {} }, strictOrdering: true });
  mixed.enqueue({ text: "remote", voice: { engine: "bouyomi" } });
  assert.throws(() => mixed.enqueue({ text: "local", voice: { engine: "webspeech" } }), /順序は保証できません/);
  mixed.dispose();
});

test("unavailable backend returns a terminal failure", async () => {
  const queue = new SpeechQueue({ webSpeech: { synthesis: null, Utterance: null } });
  const item = queue.enqueue({ text: "no backend", voice: { engine: "voicevox" } });
  await Promise.resolve();
  assert.equal(item.state, "failed");
});

test("multiple hold reasons resume only after every reason is released", async () => {
  FakeUtterance.items = [];
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const queue = new SpeechQueue({ webSpeech: { synthesis, Utterance: FakeUtterance } });
  const item = queue.enqueue({ text: "held", voice: { engine: "webspeech" } });
  queue.hold("manual");
  queue.hold("mic");
  await Promise.resolve();
  assert.deepEqual(queue.holdReasons, ["manual", "mic"]);
  assert.equal(item.state, "waiting");
  queue.release("manual");
  assert.equal(item.state, "waiting");
  queue.release("mic");
  assert.equal(item.state, "speaking");
  queue.dispose();
});

test("same-tick terminal races settle once and teardown cancels all work", async () => {
  FakeUtterance.items = [];
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const queue = new SpeechQueue({ webSpeech: { synthesis, Utterance: FakeUtterance } });
  const current = queue.enqueue({ text: "current", voice: { engine: "webspeech" } });
  const oldUtterance = FakeUtterance.items.at(-1);
  const pending = queue.enqueue({ text: "pending", voice: { engine: "webspeech" } });
  queue.skip();
  oldUtterance.onend();
  await Promise.resolve();
  assert.equal(current.state, "skipped");
  assert.equal(queue.scheduler.history.items.filter((item) => item.id === current.id).length, 1);
  queue.teardown();
  await Promise.resolve();
  assert.equal(pending.state, "cancelled");
  assert.equal(queue.snapshot().activeExecution, null);
});

test("remote clear failures are retained in diagnostics", async () => {
  const queue = new SpeechQueue({ bouyomi: { talk: async () => {}, clear: async () => { throw new Error("offline"); } } });
  await queue.clearAll();
  assert.deepEqual(queue.snapshot().remoteClear, { status: "failed", error: "offline" });
});
