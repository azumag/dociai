import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { TranslationService } from "./electron/main/services/translation/translation-service.ts"; export { ServiceError } from "./electron/main/services/service-error.ts";`,
      resolveDir: path.resolve(new URL("../..", import.meta.url).pathname),
      sourcefile: "translation-service-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    // translation-service.ts pulls in translation-runtime.ts -> @huggingface/transformers ->
    // onnxruntime-node (native .node binary, same reason scripts/electron/build.mjs keeps it
    // external). Tests inject a fake modelRuntime and never actually construct a real
    // TranslationRuntime, so onnxruntime-node's own code never runs here — it just needs to stay
    // unbundled so esbuild doesn't choke trying to parse its native binary as JS.
    external: ["onnxruntime-node", "sharp"],
    write: false,
  });
  // Written under node_modules/ (unlike ai-service.test.mjs's os.tmpdir() location) so Node's own
  // module resolution, walking up from this temp file, finds the REAL node_modules/onnxruntime-node
  // — kept external above rather than bundled, exactly like scripts/electron/build.mjs does for the
  // real app build. A location outside the repo (os.tmpdir()) has no ancestor node_modules at all.
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-translation-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function fakeRuntime(overrides = {}) {
  return {
    state: "ready",
    modelId: "fake-translation-model",
    lastError: null,
    translate: async (text) => `翻訳結果: ${text}`,
    warmUp: async () => {},
    dispose() {},
    ...overrides,
  };
}

const validInput = { text: "Thank you for the stream! That was a great match.", sourceLanguage: "en", targetLanguage: "ja" };

test("translate() resolves with the translated text, source/target languages, and modelId", async () => {
  const { modules, directory } = await loadModules();
  try {
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: fakeRuntime() });
    const result = await service.translate({ ...validInput, requestId: "req-1" });
    assert.equal(result.text, "翻訳結果: Thank you for the stream! That was a great match.");
    assert.equal(result.sourceLanguage, "en");
    assert.equal(result.targetLanguage, "ja");
    assert.equal(result.requestId, "req-1");
    assert.equal(result.modelId, "fake-translation-model");
    assert.equal(typeof result.durationMs, "number");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("rejects with BAD_REQUEST for empty text, oversized text, and unsupported languages", async () => {
  const { modules, directory } = await loadModules();
  try {
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: fakeRuntime() });
    await assert.rejects(service.translate({ ...validInput, text: "" }), (error) => error.code === "BAD_REQUEST");
    await assert.rejects(service.translate({ ...validInput, text: "   " }), (error) => error.code === "BAD_REQUEST");
    await assert.rejects(service.translate({ ...validInput, text: "x".repeat(1001) }), (error) => error.code === "BAD_REQUEST");
    await assert.rejects(service.translate({ ...validInput, sourceLanguage: "de" }), (error) => error.code === "BAD_REQUEST");
    await assert.rejects(service.translate({ ...validInput, targetLanguage: "en" }), (error) => error.code === "BAD_REQUEST");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("an empty translation result is treated as a failure, not a successful empty string", async () => {
  const { modules, directory } = await loadModules();
  try {
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: fakeRuntime({ translate: async () => "   " }) });
    await assert.rejects(service.translate(validInput), (error) => error.code === "UNKNOWN");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("a stale generation is rejected immediately as CANCELLED, without ever calling the model runtime", async () => {
  const { modules, directory } = await loadModules();
  try {
    let called = false;
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: fakeRuntime({ translate: async (text) => { called = true; return text; } }) });
    await assert.rejects(service.translate({ ...validInput, generation: 999 }), (error) => error.code === "CANCELLED");
    assert.equal(called, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("cancel(requestId) aborts the in-flight request's signal, and a late-arriving result is discarded as CANCELLED", async () => {
  const { modules, directory } = await loadModules();
  try {
    const gate = deferred();
    let observedSignal = null;
    const runtime = fakeRuntime({
      translate: async (text, sourceLanguage, targetLanguage, signal) => { observedSignal = signal; await gate.promise; return `翻訳結果: ${text}`; },
    });
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: runtime });
    const promise = service.translate({ ...validInput, requestId: "req-cancel" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.cancel("req-cancel"), true);
    assert.equal(observedSignal.aborted, true);
    gate.resolve("late result that must never surface");
    await assert.rejects(promise, (error) => error.code === "CANCELLED");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("the service's own timeoutMs marks a slow request stale; a result that arrives after the timeout is discarded as CANCELLED", async () => {
  const { modules, directory } = await loadModules();
  try {
    const gate = deferred();
    const runtime = fakeRuntime({ translate: async () => gate.promise });
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: runtime, timeoutMs: 20 });
    const promise = service.translate(validInput);
    await new Promise((resolve) => setTimeout(resolve, 60)); // let the 20ms timeout actually fire
    gate.resolve("翻訳結果（使われないはず）");
    await assert.rejects(promise, (error) => error.code === "CANCELLED");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("when a modelRepository is supplied, translate() rejects with UNAVAILABLE (not a model-load attempt) while the model is not installed", async () => {
  const { modules, directory } = await loadModules();
  try {
    let called = false;
    const runtime = fakeRuntime({ translate: async (text) => { called = true; return text; } });
    const modelRepository = { isInstalled: async () => false };
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: runtime, modelRepository });
    await assert.rejects(service.translate(validInput), (error) => error.code === "UNAVAILABLE" && /not installed/.test(error.message));
    assert.equal(called, false, "the model runtime must never be touched when the model isn't installed");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("when a modelRepository is supplied and the model IS installed, translate() proceeds normally", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelRepository = { isInstalled: async () => true };
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: fakeRuntime(), modelRepository });
    const result = await service.translate(validInput);
    assert.equal(result.text, `翻訳結果: ${validInput.text}`);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("warmUp() calls the model runtime's warmUp() so the model is resident before any real comment arrives", async () => {
  const { modules, directory } = await loadModules();
  try {
    let called = false;
    const runtime = fakeRuntime({ warmUp: async () => { called = true; } });
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: runtime });
    await service.warmUp();
    assert.equal(called, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("warmUp() never touches the model runtime when a modelRepository says the model isn't installed", async () => {
  const { modules, directory } = await loadModules();
  try {
    let called = false;
    const runtime = fakeRuntime({ warmUp: async () => { called = true; } });
    const modelRepository = { isInstalled: async () => false };
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: runtime, modelRepository });
    await service.warmUp();
    assert.equal(called, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("warmUp() swallows a model runtime load failure instead of throwing — it's fire-and-forget, failures surface via status() when a real translate() is attempted", async () => {
  const { modules, directory } = await loadModules();
  try {
    const runtime = fakeRuntime({ warmUp: async () => { throw new Error("boom"); } });
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: runtime });
    await service.warmUp(); // must not throw/reject
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("status() reflects the model runtime's own state/modelId/lastError", async () => {
  const { modules, directory } = await loadModules();
  try {
    const readyService = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: fakeRuntime({ state: "ready" }) });
    assert.deepEqual(readyService.status(), { state: "ready", modelId: "fake-translation-model" });

    const error = new Error("boom");
    const erroredService = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: fakeRuntime({ state: "error", lastError: error }) });
    assert.deepEqual(erroredService.status(), { state: "error", modelId: "fake-translation-model", lastError: { message: "boom" } });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("dispose() tears down both the request registry and the model runtime", async () => {
  const { modules, directory } = await loadModules();
  try {
    let disposed = false;
    const service = new modules.TranslationService({ cacheDir: "/tmp/unused", modelRuntime: fakeRuntime({ dispose: () => { disposed = true; } }) });
    service.dispose();
    assert.equal(disposed, true);
    await assert.rejects(service.translate(validInput), (error) => error.code === "UNAVAILABLE");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
