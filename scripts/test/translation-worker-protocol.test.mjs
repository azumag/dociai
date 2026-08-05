// translation-worker.cjs (worker_threadエントリ) の実スレッドを跨ぐプロトコルテスト。
// esbuildでworker entryをbundleし、fake transformers module (importModulePath seam) を渡して
// 実Workerを起動し、warmup/translate/pingの往復を検証する。onnxruntime-nodeは一切ロードしない
// (externalのまま — importModulePathで差し替え、エンジンは実transformersをimportしない)。
// TranslationRuntimeの内部挙動自体はtranslation-runtime.test.mjsが担当する。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

function rpc(worker, message, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off("message", onMessage);
      reject(new Error(`timed out waiting for a "${message.type}" response`));
    }, timeoutMs);
    const onMessage = (response) => {
      if (response?.requestId === message.requestId) {
        clearTimeout(timer);
        worker.off("message", onMessage);
        resolve(response);
      }
    };
    worker.on("message", onMessage);
    worker.postMessage(message);
  });
}

test("translation-worker.cjs round-trips warmup, translate, and ping across a real worker thread", async () => {
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-translation-worker-test-"));
  try {
    const fakeTransformers = path.join(directory, "fake-transformers.mjs");
    await fs.writeFile(fakeTransformers, [
      'export const env = { cacheDir: "", allowRemoteModels: true };',
      'export async function pipeline(task, modelId) { return async (text) => [{ translation_text: "ok:" + text }]; }',
      "",
    ].join("\n"));
    const workerPath = path.join(directory, "translation-worker.cjs");
    await build({
      entryPoints: [path.join(repoRoot, "electron/main/services/translation/translation-worker.ts")],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node22",
      // @huggingface/transformersはimportModulePath seamで差し替えるため、このテストでは
      // bundleにもruntime importにも含めない。onnxruntime-node/sharpも到達しない。
      external: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
      outfile: workerPath,
      write: true,
    });

    const worker = new Worker(workerPath, { workerData: { cacheDir: "/cache/translation-models", importModulePath: fakeTransformers } });
    try {
      const warmup = await rpc(worker, { type: "warmup", requestId: "w1" });
      assert.equal(warmup.type, "warmup:ok");
      assert.equal(warmup.state, "ready");
      assert.equal(warmup.modelId, "Xenova/m2m100_418M");

      const translate = await rpc(worker, { type: "translate", requestId: "t1", text: "hello world", sourceLanguage: "en", targetLanguage: "ja" });
      assert.equal(translate.type, "translate:ok");
      assert.equal(translate.text, "ok:hello world");
      assert.equal(translate.state, "ready");

      const ping = await rpc(worker, { type: "ping", requestId: "p1" });
      assert.equal(ping.type, "pong");
      assert.equal(ping.state, "ready");
    } finally {
      await worker.terminate();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("translation-worker.cjs reports an engine load failure as an error response", async () => {
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-translation-worker-test-"));
  try {
    const fakeTransformers = path.join(directory, "fake-transformers.mjs");
    await fs.writeFile(fakeTransformers, [
      "export const env = { cacheDir: \"\", allowRemoteModels: true };",
      'export async function pipeline() { throw new Error("load refused"); }',
      "",
    ].join("\n"));
    const workerPath = path.join(directory, "translation-worker.cjs");
    await build({
      entryPoints: [path.join(repoRoot, "electron/main/services/translation/translation-worker.ts")],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node22",
      external: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
      outfile: workerPath,
      write: true,
    });

    const worker = new Worker(workerPath, { workerData: { cacheDir: "/cache/translation-models", importModulePath: fakeTransformers } });
    try {
      const warmup = await rpc(worker, { type: "warmup", requestId: "w1" });
      assert.equal(warmup.type, "warmup:error");
      assert.match(warmup.message, /load refused/);
      assert.equal(warmup.state, "error");
      assert.equal(warmup.lastError?.message, "load refused");
    } finally {
      await worker.terminate();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
