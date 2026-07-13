// Real-model integration coverage for the Local LLM inference service (#45).
//
// Fixture: scripts/test/fixtures/local-llm/stories260K.gguf (1.19 MB) — downloaded from
// https://huggingface.co/ggml-org/tiny-llamas (README: "Purely for testing and fun ;)"), hosted by
// ggml-org (the llama.cpp/GGUF maintainers themselves). It's a real, tiny (260K parameter) model
// trained on the TinyStories dataset (via Andrej Karpathy's llama2.c), converted to a genuinely
// loadable GGUF file — NOT a hand-crafted fake-header fixture. It was verified during development
// (see the PR description) to actually load, tokenize, and generate coherent short English text
// through the real node-llama-cpp@3.19.0 package on this machine (macOS/arm64, Metal backend).
// Its vocabulary is English-story-only (no Japanese training data), so a Japanese prompt produces
// fluent-looking but semantically nonsensical English output — this test suite verifies the
// *pipeline* (real load, real tokenize, real streaming generation, real cancellation, real
// dispose) actually works end-to-end with a real backend, not response quality.
//
// This file is intentionally NOT run by default alongside the mock-backend suite in isolation from
// network/environment concerns — it needs the real `node-llama-cpp` optional platform dependency to
// have installed correctly (see package.json's `dependencies`). It IS included in npm run
// test:unit's file list per the issue's instructions, since a real, tiny, checked-in fixture was
// obtained for this repo.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const fixturePath = path.join(repoRoot, "scripts/test/fixtures/local-llm/stories260K.gguf");

let modules;
let bundleDirectory;

test.before(async () => {
  const result = await build({
    stdin: {
      contents: [
        `export { LocalLlmService } from "./electron/main/services/local-llm/local-llm-service.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "local-llm-service-integration-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    // Real node-llama-cpp must stay external (never bundled — see native-loader.ts's header
    // comment and node-llama-cpp's own Electron-bundling guidance) AND this bundle file must live
    // somewhere Node's ESM resolution can actually find the repo's node_modules from, which a
    // system tmpdir (os.tmpdir(), used by every other *.test.mjs in this repo) cannot do. Placing
    // it under the repo's own node_modules/ satisfies both: it's already gitignored, and Node's
    // module resolution walks up from here and finds node_modules/node-llama-cpp one level up.
    external: ["node-llama-cpp"],
    write: false,
  });
  bundleDirectory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-local-llm-integration-"));
  const file = path.join(bundleDirectory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  modules = await import(file);
});

test.after(async () => {
  if (bundleDirectory) await fs.rm(bundleDirectory, { recursive: true, force: true });
});

function createModelRepository(models) {
  const byId = new Map(models.map((model) => [model.id, model]));
  return {
    async getInstalled(modelId) {
      return byId.get(modelId) ?? null;
    },
    async resolveInstalledModelPath(modelId) {
      const model = byId.get(modelId);
      if (!model) throw new Error(`model ${modelId} not found`);
      return model.path;
    },
  };
}

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function drain(iterable) {
  return (async () => {
    const events = [];
    for await (const event of iterable) events.push(event);
    return events;
  })();
}

/**
 * Forces CPU-only inference (real node-llama-cpp, real dynamic import — only the `gpu` option is
 * overridden) rather than the default "auto" GPU-preferring backend selection. This is a real,
 * reproduced-during-development robustness issue, not a theoretical one: when this file's test
 * suite runs concurrently with the rest of the repo's `npm run test:unit` (many other test files'
 * child processes running at the same time, several of them driving real Electron/GPU-adjacent
 * work), a real Metal backend crash was observed — a native `GGML_ASSERT(buft) failed` abort deep
 * in llama.cpp's ggml-metal graph-optimization code during context creation — that takes down the
 * entire test process (a C++ abort(), not a catchable JS exception). This tiny 260K-parameter
 * fixture gains nothing from GPU acceleration anyway, so forcing CPU here sidesteps GPU/Metal
 * driver contention entirely without reducing what this suite actually covers (our own
 * service/queue/state-machine plumbing against the real node-llama-cpp API, not backend-specific
 * behavior). Real (non-test) callers must never set this — native-loader.ts's own default remains
 * "auto".
 */
function createService(modelRepository, overrides = {}) {
  return new modules.LocalLlmService({ modelRepository, nativeLoaderDeps: { getLlamaOptions: { gpu: false } }, ...overrides });
}

// =============================================================================================
// Feasibility sanity check — real node-llama-cpp actually reports a usable backend on this box.
// =============================================================================================

test("real node-llama-cpp: capability probe reports a usable backend on this machine", async () => {
  const service = new modules.LocalLlmService({ modelRepository: createModelRepository([]) });
  try {
    const capabilities = await service.initialize();
    assert.equal(capabilities.available, true, `expected node-llama-cpp to report a usable backend; got: ${JSON.stringify(capabilities)}`);
    assert.ok(capabilities.backend, "expected a non-empty backend name (e.g. cpu/metal/cuda/vulkan)");
  } finally {
    await service.dispose();
  }
});

// =============================================================================================
// Sequential real-model flow: load -> generate (Japanese) -> streaming order -> cancel -> next
// request succeeds -> unload -> reload.
// =============================================================================================

test("real model: loads the tiny fixture GGUF end-to-end", async () => {
  const repository = createModelRepository([{ id: "tiny-stories", displayName: "Tiny Stories 260K", path: fixturePath }]);
  const service = createService(repository);
  try {
    await service.initialize();
    const summary = await service.load({ modelId: "tiny-stories", contextSize: 256 }, service.createRequestContext());
    assert.equal(summary.modelId, "tiny-stories");
    assert.ok(summary.sizeBytes > 0);
    assert.ok(summary.contextSize > 0);
    assert.ok(summary.trainContextSize === undefined || summary.trainContextSize > 0);
    assert.deepEqual(service.getState(), { status: "ready", model: summary });
  } finally {
    await service.dispose();
  }
});

test("real model: generates a response to a short Japanese prompt without crashing, with tokens streaming in order and matching the final text", async () => {
  const repository = createModelRepository([{ id: "tiny-stories", displayName: "Tiny Stories 260K", path: fixturePath }]);
  const service = createService(repository);
  try {
    await service.initialize();
    await service.load({ modelId: "tiny-stories", contextSize: 256 }, service.createRequestContext());

    const events = await drain(service.generate({ modelId: "tiny-stories", messages: [{ role: "user", content: "こんにちは、調子はどう?" }], maxTokens: 16 }, service.createRequestContext()));

    const tokenEvents = events.filter((event) => event.type === "token");
    const doneEvent = events.at(-1);
    assert.equal(doneEvent.type, "done", `expected the stream to end with "done", got: ${JSON.stringify(events.map((e) => e.type))}`);
    assert.ok(tokenEvents.length > 0, "expected at least one streamed token event");
    assert.equal(tokenEvents.map((event) => event.text).join(""), doneEvent.text, "concatenated streamed tokens must equal the final text, in order");
    assert.ok(doneEvent.text.length > 0, "the model must produce some non-empty output for a real prompt");
    assert.equal(doneEvent.metrics.generatedTokens, tokenEvents.length);
    assert.ok(doneEvent.metrics.promptTokens > 0);
    assert.ok(doneEvent.metrics.totalGenerationMs >= 0);
    assert.equal(doneEvent.metrics.backend, service.getCapabilities().backend);
    assert.ok(!JSON.stringify(doneEvent.metrics).includes("こんにちは"), "metrics must never contain prompt text");
  } finally {
    await service.dispose();
  }
});

test("real model: cancelling an active generation stops it, and the next request still completes successfully", async () => {
  const repository = createModelRepository([{ id: "tiny-stories", displayName: "Tiny Stories 260K", path: fixturePath }]);
  const service = createService(repository);
  try {
    await service.initialize();
    // contextSize is clamped to the fixture's real trainContextSize (128) by model-runtime.ts's
    // load(), regardless of the larger value requested here — maxTokens below is sized to fit
    // within that clamped 128-token budget (schemas.ts's validateGenerateInput rejects a maxTokens
    // that exceeds the model's actual context size).
    await service.load({ modelId: "tiny-stories", contextSize: 256 }, service.createRequestContext());

    // This fixture is tiny (260K params) and generates extremely fast — a fixed wall-clock delay
    // before cancelling is not a reliable way to land "mid-stream" (generation can complete in well
    // under 30ms). Instead: consume the async generator manually and cancel right after observing
    // the FIRST token event, which guarantees we're mid-stream regardless of how fast the model
    // runs, as long as more than one token is requested.
    const cancelContext = service.createRequestContext("app", "to-cancel");
    const cancelIterator = service.generate({ modelId: "tiny-stories", messages: [{ role: "user", content: "Tell me a long story about a dragon and a castle." }], maxTokens: 60 }, cancelContext);
    const cancelEvents = [];
    const first = await cancelIterator.next();
    assert.equal(first.done, false);
    cancelEvents.push(first.value);
    assert.equal(first.value.type, "token", `expected the first event to be a token, got: ${JSON.stringify(first.value)}`);

    const cancelled = service.cancel("to-cancel");
    assert.equal(cancelled, true);
    for await (const event of cancelIterator) cancelEvents.push(event);
    assert.equal(cancelEvents.at(-1).type, "cancelled");

    const nextEvents = await drain(service.generate({ modelId: "tiny-stories", messages: [{ role: "user", content: "Hi" }], maxTokens: 8 }, service.createRequestContext()));
    assert.equal(nextEvents.at(-1).type, "done");
    assert.ok(nextEvents.at(-1).text.length > 0);
    assert.equal(service.getState().status, "ready");
  } finally {
    await service.dispose();
  }
});

test("real model: unload then reload the same model succeeds and generation works again afterward", async () => {
  const repository = createModelRepository([{ id: "tiny-stories", displayName: "Tiny Stories 260K", path: fixturePath }]);
  const service = createService(repository);
  try {
    await service.initialize();
    await service.load({ modelId: "tiny-stories", contextSize: 256 }, service.createRequestContext());
    await service.unload({}, service.createRequestContext());
    assert.equal(service.getState().status, "idle");

    await service.load({ modelId: "tiny-stories", contextSize: 256 }, service.createRequestContext());
    assert.equal(service.getState().status, "ready");
    const events = await drain(service.generate({ modelId: "tiny-stories", messages: [{ role: "user", content: "Hi" }], maxTokens: 8 }, service.createRequestContext()));
    assert.equal(events.at(-1).type, "done");
  } finally {
    await service.dispose();
  }
});

test("real model: an oversized prompt against a tiny context reports CONTEXT_OVERFLOW rather than crashing the process", async () => {
  const repository = createModelRepository([{ id: "tiny-stories", displayName: "Tiny Stories 260K", path: fixturePath }]);
  const service = createService(repository);
  try {
    await service.initialize();
    // node-llama-cpp's context-shift compaction turns out to be quite resilient: during
    // development, a *moderately* small context (16-32) combined with an even huge oversized
    // prompt (up to ~870 real tokens) was repeatedly observed to succeed anyway by aggressively
    // truncating the history rather than throwing. What reliably reproduces a real
    // CONTEXT_OVERFLOW is instead a genuinely tiny ABSOLUTE context size (verified: 8 fails
    // consistently, 16 already succeeds even against the same oversized prompt) — the failure
    // path needs enough minimum headroom for its own internal batch/eval bookkeeping regardless of
    // how oversized the prompt is. This also deliberately uses Japanese text rather than a long
    // English string: schemas.ts's own pre-flight validation only has a rough chars-per-token
    // *estimate* (~4 chars/token, tuned for English) to protect against wildly oversized requests
    // before they ever reach the model — a merely-long English prompt gets rejected by that
    // pre-check as INVALID_REQUEST before it can ever reach node-llama-cpp. This fixture's
    // vocabulary is English-story-only, so out-of-vocabulary Japanese text tokenizes byte-by-byte
    // (verified: 12 Japanese characters -> 35 real tokens, ~3 tokens/char) — short enough by
    // *character* count (predicted ~3 tokens) to sail past the chars/4 pre-check against this
    // test's 8-token context budget, while still being ~4x more real tokens than the context holds.
    await service.load({ modelId: "tiny-stories", contextSize: 8 }, service.createRequestContext());

    const overflowPrompt = "こんにちは、調子はどう?";
    const events = await drain(service.generate({ modelId: "tiny-stories", messages: [{ role: "user", content: overflowPrompt }], maxTokens: 8 }, service.createRequestContext()));
    const last = events.at(-1);
    assert.equal(last.type, "error", `expected an error event for an oversized prompt, got: ${JSON.stringify(events.map((e) => e.type))}`);
    assert.equal(last.error.code, "CONTEXT_OVERFLOW");
  } finally {
    await service.dispose();
  }
});

test("real model: an invalid GGUF file (truncated tensor data, valid header) fails load() without crashing the process", async () => {
  const directory = await tempDir("dociai-local-llm-invalid-gguf-");
  try {
    // Keep the real magic/version/tensor_count/kv_count/metadata header intact (so this passes
    // gguf-metadata-reader.ts's cheap magic-bytes check) but truncate before the real tensor
    // payload, so the REAL node-llama-cpp loader is the one that rejects it — this is deliberately
    // different from the mock-backend suite's INVALID_GGUF case, which only exercises our own
    // header pre-check with a bad magic byte, never node-llama-cpp's own loader.
    const fullBuffer = await fs.readFile(fixturePath);
    const truncatedPath = path.join(directory, "truncated.gguf");
    await fs.writeFile(truncatedPath, fullBuffer.subarray(0, 4096));

    const repository = createModelRepository([{ id: "truncated", displayName: "Truncated", path: truncatedPath }]);
    const service = createService(repository);
    try {
      await service.initialize();
      await assert.rejects(
        service.load({ modelId: "truncated" }, service.createRequestContext()),
        (error) => ["INVALID_GGUF", "BACKEND_INIT_FAILED"].includes(error.code),
      );
      assert.equal(service.getState().status, "error");
    } finally {
      await service.dispose();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
