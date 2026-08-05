// TranslationRuntimeClient (worker_threadファサード) のユニットテスト。
// 実workerは起動せず、workerFactoryにfake workerを注入して、メッセージ往復・状態反映・
// timeout・abort・dispose・worker異常を検証する。実スレッドを跨ぐプロトコル検証は
// translation-worker-protocol.test.mjsが担当する。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { TranslationRuntimeClient } from "./electron/main/services/translation/translation-runtime-client.ts"; export { probeTranslationWorker } from "./electron/main/services/translation/translation-runtime-client.ts";`,
      resolveDir: repoRoot,
      sourcefile: "translation-runtime-client-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-translation-client-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

function fakeWorker() {
  const listeners = new Map();
  const worker = {
    posted: [],
    terminated: false,
    postMessage(message) { worker.posted.push(message); },
    terminate() { worker.terminated = true; return Promise.resolve(1); },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
  };
  return worker;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("warmUp() posts a warmup message and resolves once the worker reports ready", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => worker });
    const promise = client.warmUp();
    await flush();
    assert.equal(worker.posted[0].type, "warmup");
    assert.equal(client.state, "loading", "state must be optimistically 'loading' while the response is pending");
    worker.emit("message", { type: "warmup:ok", requestId: worker.posted[0].requestId, state: "ready", modelId: "Xenova/m2m100_418M" });
    await promise;
    assert.equal(client.state, "ready");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("translate() posts a translate message and resolves with the translated text", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => worker });
    const promise = client.translate("hello", "en", "ja");
    await flush();
    const message = worker.posted[0];
    assert.deepEqual(message, { type: "translate", requestId: message.requestId, text: "hello", sourceLanguage: "en", targetLanguage: "ja" });
    worker.emit("message", { type: "translate:ok", requestId: message.requestId, text: "こんにちは", state: "ready", modelId: "Xenova/m2m100_418M" });
    assert.equal(await promise, "こんにちは");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a warmup error response rejects warmUp() and records lastError with state 'error'", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => worker });
    const promise = client.warmUp();
    await flush();
    worker.emit("message", { type: "warmup:error", requestId: worker.posted[0].requestId, message: "model not found", state: "error", modelId: "Xenova/m2m100_418M", lastError: { message: "model not found" } });
    await assert.rejects(promise, /model not found/);
    assert.equal(client.state, "error");
    assert.equal(client.lastError?.message, "model not found");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a translate error response rejects translate() with the worker's message", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => worker });
    const promise = client.translate("hello", "en", "ja");
    await flush();
    worker.emit("message", { type: "translate:error", requestId: worker.posted[0].requestId, message: "boom", state: "error", modelId: "Xenova/m2m100_418M" });
    await assert.rejects(promise, /boom/);
    assert.equal(client.state, "error");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a pre-aborted signal rejects translate() without spawning a worker or posting a message", async () => {
  const { modules, directory } = await loadModules();
  try {
    let spawnCount = 0;
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => { spawnCount += 1; return fakeWorker(); } });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.translate("hello", "en", "ja", controller.signal), (error) => error.name === "AbortError");
    assert.equal(spawnCount, 0, "an already-aborted request must not spawn the worker or trigger a model load");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("an aborted translate() signal rejects with AbortError and a late worker response is ignored", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => worker });
    const controller = new AbortController();
    const promise = client.translate("hello", "en", "ja", controller.signal);
    await flush();
    controller.abort();
    await assert.rejects(promise, (error) => error.name === "AbortError");
    // 遅れて届いた応答は要求を解決せず、状態だけ反映する
    worker.emit("message", { type: "translate:ok", requestId: worker.posted[0].requestId, text: "後から届いた結果", state: "ready", modelId: "Xenova/m2m100_418M" });
    await flush();
    assert.equal(client.state, "ready");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("dispose() terminates the worker, resets to idle, and later calls are rejected", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => worker });
    const promise = client.warmUp();
    await flush();
    client.dispose();
    assert.equal(worker.terminated, true);
    assert.equal(client.state, "idle");
    await assert.rejects(promise, /disposed/);
    await assert.rejects(client.translate("hi", "en", "ja"), /disposed/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a worker 'error' event rejects pending requests and flips state to 'error'", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => worker });
    const promise = client.warmUp();
    await flush();
    worker.emit("error", new Error("crash"));
    await assert.rejects(promise, /crashed/);
    assert.equal(client.state, "error");
    // 次の要求では新しいworkerを起動してやり直せる
    const second = fakeWorker();
    let factoryCalls = 0;
    client.dispose();
    const client2 = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => { factoryCalls += 1; return second; } });
    const retry = client2.warmUp();
    await flush();
    second.emit("message", { type: "warmup:ok", requestId: second.posted[0].requestId, state: "ready", modelId: "Xenova/m2m100_418M" });
    await retry;
    assert.equal(factoryCalls, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("an unexpected worker 'exit' rejects pending requests and flips state to 'error'", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => worker });
    const promise = client.warmUp();
    await flush();
    worker.emit("exit", 1);
    await assert.rejects(promise, /exited unexpectedly/);
    assert.equal(client.state, "error");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("warmUp() is bounded by loadTimeoutMs when the worker never responds, and state reconciles on a late response", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", loadTimeoutMs: 30, workerFactory: () => worker });
    const promise = client.warmUp();
    await flush();
    await assert.rejects(promise, /timeout/i);
    assert.equal(client.state, "loading", "a timed-out warmup leaves the optimistic 'loading' state until the late response");
    worker.emit("message", { type: "warmup:ok", requestId: worker.posted[0].requestId, state: "ready", modelId: "Xenova/m2m100_418M" });
    await flush();
    assert.equal(client.state, "ready", "the late response must still reconcile the mirrored state");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("concurrent first uses share a single worker spawn (no double spawn race)", async () => {
  const { modules, directory } = await loadModules();
  try {
    let spawnCount = 0;
    const workers = [];
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => { spawnCount += 1; const worker = fakeWorker(); workers.push(worker); return worker; } });
    const warmup = client.warmUp();
    const translate = client.translate("hi", "en", "ja");
    await flush();
    assert.equal(spawnCount, 1, "concurrent first uses must not spawn two workers");
    assert.equal(workers[0].posted.length, 2);
    workers[0].emit("message", { type: "warmup:ok", requestId: workers[0].posted[0].requestId, state: "ready", modelId: "Xenova/m2m100_418M" });
    workers[0].emit("message", { type: "translate:ok", requestId: workers[0].posted[1].requestId, text: "こんにちは", state: "ready", modelId: "Xenova/m2m100_418M" });
    await Promise.all([warmup, translate]);
    assert.equal(spawnCount, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a stale exit from an old worker must not tear down a newly spawned worker (teardown identity guard)", async () => {
  const { modules, directory } = await loadModules();
  try {
    const workers = [];
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => { const worker = fakeWorker(); workers.push(worker); return worker; } });
    const firstAttempt = client.warmUp();
    await flush();
    const first = workers[0];
    first.emit("error", new Error("crash"));
    await assert.rejects(firstAttempt, /crashed/);

    // 新しいworkerがspawnされた後、旧workerのexitイベントが遅れて届く — 健康な新workerを殺さない。
    const secondAttempt = client.warmUp();
    await flush();
    assert.equal(workers.length, 2);
    const second = workers[1];
    first.emit("exit", 1);
    assert.equal(second.terminated, false, "a stale exit from the old worker must not terminate the healthy new worker");
    assert.equal(client.state, "loading", "the second worker must still be usable");

    second.emit("message", { type: "warmup:ok", requestId: second.posted[0].requestId, state: "ready", modelId: "Xenova/m2m100_418M" });
    await secondAttempt;
    assert.equal(client.state, "ready");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("dispose() while a spawn is in flight terminates the fresh worker and rejects the in-flight call", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const client = new modules.TranslationRuntimeClient({ cacheDir: "/cache", workerFactory: () => worker });
    const promise = client.warmUp();
    client.dispose();
    await assert.rejects(promise, /disposed/);
    assert.equal(worker.terminated, true, "a worker spawned right before dispose must be terminated, not leaked");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("probeTranslationWorker() returns the worker state on a pong and terminates the worker", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const originalPost = worker.postMessage.bind(worker);
    worker.postMessage = (message) => {
      originalPost(message);
      queueMicrotask(() => worker.emit("message", { type: "pong", requestId: message.requestId, state: "idle", modelId: "Xenova/m2m100_418M" }));
    };
    const result = await modules.probeTranslationWorker({ cacheDir: "/cache", workerFactory: () => worker });
    assert.deepEqual(result, { ok: true, state: "idle", modelId: "Xenova/m2m100_418M" });
    assert.equal(worker.terminated, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("probeTranslationWorker() returns ok:false when the worker never responds", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const result = await modules.probeTranslationWorker({ cacheDir: "/cache", workerFactory: () => worker, timeoutMs: 30 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /did not respond/);
    assert.equal(worker.terminated, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("probeTranslationWorker() surfaces a worker error as a reason", async () => {
  const { modules, directory } = await loadModules();
  try {
    const worker = fakeWorker();
    const originalPost = worker.postMessage.bind(worker);
    worker.postMessage = (message) => {
      originalPost(message);
      queueMicrotask(() => worker.emit("error", new Error("worker exploded")));
    };
    const result = await modules.probeTranslationWorker({ cacheDir: "/cache", workerFactory: () => worker });
    assert.equal(result.ok, false);
    assert.match(result.reason, /worker exploded/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
