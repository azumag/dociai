// issue #257 Phase 5 (#264, post-review fix): TranslationRuntimeが@huggingface/transformersを
// 遅延import (動的import()) することを直接検証する。トップレベル静的importに戻す変更が
// 紛れ込むと、packaged buildでMain process全体が起動不能になる regression (CI package-macos
// で実際に発生・確認済み) を二度と踏まないための回帰テスト。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { TranslationRuntime } from "./electron/main/services/translation/translation-runtime.ts";`,
      resolveDir: repoRoot,
      sourcefile: "translation-runtime-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    // @huggingface/transformers itself is never actually imported in this test (importModule is
    // always injected as a fake), but esbuild still needs to resolve `import("@huggingface/
    // transformers")` in translation-runtime.ts's default parameter expression at bundle time —
    // keeping its native deps external avoids dragging onnxruntime-node's .node binary into this.
    external: ["onnxruntime-node", "sharp"],
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-translation-runtime-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

function fakeTransformersModule(translateImpl) {
  const env = { cacheDir: "", allowRemoteModels: true };
  let pipelineCalls = 0;
  return {
    env,
    pipelineCalls: () => pipelineCalls,
    async pipeline(task, modelId) {
      pipelineCalls += 1;
      return translateImpl ?? (async (text) => [{ translation_text: `translated: ${text}` }]);
    },
  };
}

test("the constructor never imports @huggingface/transformers (lazy — regression test for the packaged-build startup hang)", async () => {
  const { modules, directory } = await loadModules();
  try {
    let importCalled = false;
    const runtime = new modules.TranslationRuntime({ cacheDir: "/tmp/unused", importModule: async () => { importCalled = true; return fakeTransformersModule(); } });
    assert.equal(importCalled, false);
    assert.equal(runtime.state, "idle");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("translate() imports the module exactly once, sets env.cacheDir/allowRemoteModels, and caches the translator across calls", async () => {
  const { modules, directory } = await loadModules();
  try {
    let importCount = 0;
    let capturedEnv = null;
    const runtime = new modules.TranslationRuntime({
      cacheDir: "/cache/translation-models",
      importModule: async () => {
        importCount += 1;
        const fake = fakeTransformersModule();
        capturedEnv = fake.env;
        return fake;
      },
    });
    assert.equal(await runtime.translate("hello", "en", "ja"), "translated: hello");
    assert.equal(runtime.state, "ready");
    assert.equal(importCount, 1);
    assert.equal(capturedEnv.cacheDir, "/cache/translation-models");
    assert.equal(capturedEnv.allowRemoteModels, false);

    assert.equal(await runtime.translate("world", "fr", "ja"), "translated: world");
    assert.equal(importCount, 1, "a second translate() call must reuse the already-loaded translator, not re-import");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a rejecting import surfaces as state: error without throwing uncaught, and a later call retries", async () => {
  const { modules, directory } = await loadModules();
  try {
    let attempt = 0;
    const runtime = new modules.TranslationRuntime({
      cacheDir: "/tmp/unused",
      importModule: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Cannot find module 'onnxruntime-node'");
        return fakeTransformersModule();
      },
    });
    await assert.rejects(runtime.translate("hello", "en", "ja"), /onnxruntime-node/);
    assert.equal(runtime.state, "error");
    assert.match(runtime.lastError.message, /onnxruntime-node/);

    // retries on the next call rather than staying permanently stuck in "error"
    assert.equal(await runtime.translate("hello", "en", "ja"), "translated: hello");
    assert.equal(runtime.state, "ready");
    assert.equal(attempt, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a hanging import is bounded by loadTimeoutMs instead of blocking forever (packaged-build hang regression)", async () => {
  const { modules, directory } = await loadModules();
  try {
    const runtime = new modules.TranslationRuntime({
      cacheDir: "/tmp/unused",
      loadTimeoutMs: 30,
      importModule: () => new Promise(() => {}), // never resolves — simulates the observed hang
    });
    await assert.rejects(runtime.translate("hello", "en", "ja"), /timeout/i);
    assert.equal(runtime.state, "error");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("concurrent translate() calls during the initial load share the same in-flight import (no duplicate imports)", async () => {
  const { modules, directory } = await loadModules();
  try {
    let importCount = 0;
    let releaseImport;
    const gate = new Promise((resolve) => { releaseImport = resolve; });
    const runtime = new modules.TranslationRuntime({
      cacheDir: "/tmp/unused",
      importModule: async () => { importCount += 1; await gate; return fakeTransformersModule(); },
    });
    const first = runtime.translate("a", "en", "ja");
    const second = runtime.translate("b", "en", "ja");
    assert.equal(runtime.state, "loading");
    releaseImport();
    await Promise.all([first, second]);
    assert.equal(importCount, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("dispose() resets to idle and a later translate() re-imports from scratch", async () => {
  const { modules, directory } = await loadModules();
  try {
    let importCount = 0;
    const runtime = new modules.TranslationRuntime({ cacheDir: "/tmp/unused", importModule: async () => { importCount += 1; return fakeTransformersModule(); } });
    await runtime.translate("hello", "en", "ja");
    assert.equal(importCount, 1);
    runtime.dispose();
    assert.equal(runtime.state, "idle");
    await runtime.translate("hello again", "en", "ja");
    assert.equal(importCount, 2, "dispose() must force a fresh import on next use, not silently reuse a disposed translator");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
