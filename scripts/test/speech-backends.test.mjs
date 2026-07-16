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

test("unavailable comment reader engines use its saved Web Speech voice on fallback", async () => {
  for (const engine of ["voicevox", "bouyomi"]) {
    FakeUtterance.items = [];
    const synthesis = { speak() {}, cancel() {}, getVoices: () => [{ name: "Kyoko", lang: "ja-JP" }] };
    const fallback = { enabled: true, engine: "webspeech", name: "Kyoko", rate: 0.8, pitch: 1.4 };
    const queue = new SpeechQueue({
      webSpeech: { synthesis, Utterance: FakeUtterance },
      resolveFallbackVoice: (personaId, voice, backendId) => personaId === "__comment_reader__" && backendId === "webspeech" ? fallback : voice,
    });
    queue.enqueue({ personaId: "__comment_reader__", personaName: "コメント読み上げ", text: engine, voice: { engine, pitch: -0.05 } });
    const utterance = FakeUtterance.items.at(-1);
    assert.equal(utterance.voice?.name, "Kyoko");
    assert.equal(utterance.rate, 0.8);
    assert.equal(utterance.pitch, 1.4);
    utterance.onend();
    await Promise.resolve();
    queue.dispose();
  }
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

test("estimateBouyomiSpeakMs's charsPerSecond is adjustable and defaults sanely", () => {
  const text = "あ".repeat(30);
  const slower = estimateBouyomiSpeakMs(text, 100, 3);
  const faster = estimateBouyomiSpeakMs(text, 100, 12);
  assert.ok(slower > faster, "charsPerSecondを下げると見積り時間は伸びる");
  assert.equal(estimateBouyomiSpeakMs(text, 100), estimateBouyomiSpeakMs(text, 100, 6), "charsPerSecond省略時は既定の6");
  // 0/負/非数値は既定値へフォールバックする (ゼロ除算防止)
  assert.equal(estimateBouyomiSpeakMs(text, 100, 0), estimateBouyomiSpeakMs(text, 100, 6));
  assert.equal(estimateBouyomiSpeakMs(text, 100, -5), estimateBouyomiSpeakMs(text, 100, 6));
  assert.equal(estimateBouyomiSpeakMs(text, 100, NaN), estimateBouyomiSpeakMs(text, 100, 6));
});

test("BouyomiBackend does not mistake a webspeech-scale rate for its own speed (regression)", async () => {
  // commentReader.rate (webspeech用、既定1.0) は棒読みちゃんのspeed (50-200スケール) とは
  // 別物であり、フォールバックとして流用すると speed=1 相当と誤解釈され待機が60秒に張り付く。
  const waited = [];
  const backend = new BouyomiBackend({ talk: async () => ({ ok: true }) }, {
    wait: (ms) => { waited.push(ms); return Promise.resolve(); },
  });
  // commentReader由来のvoiceには speed が無く rate:1 のみが乗る典型ケースを再現する
  await backend.play({ text: "短いコメント", voice: { rate: 1, pitch: 1 } }, { executionId: "c1" });
  assert.ok(waited[0] < 5000, `rateがspeedへ誤って伝播すると60秒に張り付く (実測 ${waited[0]}ms)`);
});

test("BouyomiBackend's charsPerSecond option lets the completion-wait estimate be tuned", async () => {
  const waitedDefault = [];
  const defaultBackend = new BouyomiBackend({ talk: async () => ({ ok: true }) }, {
    wait: (ms) => { waitedDefault.push(ms); return Promise.resolve(); },
  });
  await defaultBackend.play({ text: "あ".repeat(30), voice: {} }, { executionId: "d1" });

  const waitedTuned = [];
  const tunedBackend = new BouyomiBackend({ talk: async () => ({ ok: true }) }, {
    wait: (ms) => { waitedTuned.push(ms); return Promise.resolve(); },
    charsPerSecond: 3,
  });
  await tunedBackend.play({ text: "あ".repeat(30), voice: {} }, { executionId: "t1" });

  assert.ok(waitedTuned[0] > waitedDefault[0], "charsPerSecondを下げると同じ文章でも待機時間見積りが伸びる");
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

test("mic hold lets the currently playing item keep speaking, but withholds the next item until release", async () => {
  FakeUtterance.items = [];
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const queue = new SpeechQueue({ webSpeech: { synthesis, Utterance: FakeUtterance } });
  const current = queue.enqueue({ text: "current", voice: { engine: "webspeech" } });
  const next = queue.enqueue({ text: "next", voice: { engine: "webspeech" } });
  assert.equal(current.state, "speaking");
  assert.equal(next.state, "waiting");

  queue.hold("mic");
  await Promise.resolve();
  assert.equal(current.state, "speaking", "マイク発話中でも再生中の読み上げは中断しない");
  assert.equal(FakeUtterance.items.length, 1, "読み直しは発生せず、新しいUtteranceは作られない");

  FakeUtterance.items.at(-1).onend();
  await Promise.resolve();
  assert.equal(current.state, "done", "中断されなかったので自然に完了する");
  assert.equal(next.state, "waiting", "マイク保留中は次の項目が始まらない");
  assert.equal(FakeUtterance.items.length, 1);

  queue.release("mic");
  assert.equal(next.state, "speaking", "保留解除で次の項目が始まる");
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

test("runtime reload releases its internal hold even when there is no queue transfer", () => {
  const queue = new SpeechQueue();
  queue.prepareForRuntimeRestore();
  assert.equal(queue.paused, true);
  assert.equal(queue.restoreAfterRuntimeReload({ items: [], holdReasons: [] }), 0);
  assert.equal(queue.paused, false);
  queue.dispose();
});

test("runtime reload never restores a current item cleared immediately before transfer", async () => {
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const queue = new SpeechQueue({ webSpeech: { synthesis, Utterance: FakeUtterance } });
  queue.enqueue({ personaId: "p", personaName: "P", text: "must-clear", voice: { engine: "webspeech" } });
  await queue.clearAll();
  assert.deepEqual(queue.exportForRuntimeReload().items, []);
  queue.dispose();
});

test("runtime reload resumes the interrupted current item before a higher-priority pending item", () => {
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const queue = new SpeechQueue({ webSpeech: { synthesis, Utterance: FakeUtterance } });
  queue.prepareForRuntimeRestore();
  queue.restoreAfterRuntimeReload({
    items: [
      { personaId: "p", personaName: "P", text: "current", voice: { engine: "webspeech" }, priority: 0, runtimeReloadCurrent: true },
      { personaId: "p", personaName: "P", text: "pending-high", voice: { engine: "webspeech" }, priority: 10 },
    ],
    holdReasons: [],
  });
  assert.equal(queue.current?.text, "current");
  queue.dispose();
});

test("runtime reload protects transferred items and drops only candidate-start overflow", () => {
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const queue = new SpeechQueue({ policy: { maxPending: 1, maxPendingPerSource: 1 }, webSpeech: { synthesis, Utterance: FakeUtterance } });
  const transfer = { items: [{ id: "old", personaId: "p", personaName: "P", text: "old", source: "same", voice: { engine: "webspeech" } }], holdReasons: [] };
  queue.prepareForRuntimeRestore(transfer);
  const fresh = queue.enqueue({ personaId: "p", personaName: "P", text: "fresh", source: "same", voice: { engine: "webspeech" } });
  queue.restoreAfterRuntimeReload(transfer);
  assert.equal(fresh.state, "dropped");
  assert.equal(queue.current?.text, "old");
  queue.dispose();
});

test("candidate-start items merge into the shared transfer before rollback", () => {
  const transfer = { items: [{ id: "old", personaId: "p", personaName: "P", text: "old", voice: {} }], holdReasons: [] };
  const queue = new SpeechQueue();
  queue.prepareForRuntimeRestore(transfer);
  const fresh = queue.enqueue({ personaId: "p", personaName: "P", text: "fresh", voice: {} });
  assert.equal(queue.mergeIntoRuntimeTransfer(), 1);
  assert.deepEqual(transfer.items.map((item) => item.id), ["old", fresh.id]);
  assert.equal(queue.mergeIntoRuntimeTransfer(), 0, "merge is idempotent by item id");
  queue.dispose();
});

test("commentReaderIntervalMs paces successive comment reads", async () => {
  FakeUtterance.items = [];
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const queue = new SpeechQueue({
    webSpeech: { synthesis, Utterance: FakeUtterance },
    commentReaderIntervalMs: 400,
    isCommentReaderItem: (item) => item.personaId === "reader",
  });

  const first = queue.enqueue({ personaId: "reader", personaName: "コメント読み上げ", text: "one", voice: { engine: "webspeech" } });
  assert.equal(first.state, "speaking");
  FakeUtterance.items.at(-1).onend();
  await Promise.resolve();
  assert.equal(first.state, "done");

  const second = queue.enqueue({ personaId: "reader", personaName: "コメント読み上げ", text: "two", voice: { engine: "webspeech" } });
  assert.equal(second.state, "waiting", "間隔が空くまで次のコメントは読み上げを始めない");

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(second.state, "waiting", "間隔の途中ではまだ始まらない");

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(second.state, "speaking", "間隔が経過すると読み上げを開始する");

  FakeUtterance.items.at(-1).onend();
  await Promise.resolve();
  queue.dispose();
});

test("commentReaderIntervalMs does not delay a persona item queued after a comment finished reading", async () => {
  FakeUtterance.items = [];
  const synthesis = { speak() {}, cancel() {}, getVoices: () => [] };
  const queue = new SpeechQueue({
    webSpeech: { synthesis, Utterance: FakeUtterance },
    commentReaderIntervalMs: 5000,
    isCommentReaderItem: (item) => item.personaId === "reader",
  });

  const comment = queue.enqueue({ personaId: "reader", personaName: "コメント読み上げ", text: "one", voice: { engine: "webspeech" } });
  FakeUtterance.items.at(-1).onend();
  await Promise.resolve();
  assert.equal(comment.state, "done");

  const aiReply = queue.enqueue({ personaId: "ai", personaName: "AI", text: "reply", voice: { engine: "webspeech" } });
  assert.equal(aiReply.state, "speaking", "コメント読み上げ以外のアイテムは間隔の影響を受けない");

  FakeUtterance.items.at(-1).onend();
  await Promise.resolve();
  queue.dispose();
});
