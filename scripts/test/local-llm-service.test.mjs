import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { NativeLoader } from "./electron/main/services/local-llm/native-loader.ts";`,
        `export { canTransitionLocalLlmState, assertLocalLlmTransition, InvalidLocalLlmTransitionError, LOCAL_LLM_STATE_TRANSITIONS } from "./electron/main/services/local-llm/local-llm-state.ts";`,
        `export { GenerationQueue } from "./electron/main/services/local-llm/generation-queue.ts";`,
        `export { LocalLlmError, isLocalLlmError, isCancellation, normalizeLocalLlmError, logLocalLlmError } from "./electron/main/services/local-llm/local-llm-errors.ts";`,
        `export { adaptMessages } from "./electron/main/services/local-llm/message-adapter.ts";`,
        `export { classifyMessageContent, validateMessages, validateGenerateInput, validateLoadModelInput } from "./electron/shared/local-llm/schemas.ts";`,
        `export { ModelRuntime } from "./electron/main/services/local-llm/model-runtime.ts";`,
        `export { LocalLlmService } from "./electron/main/services/local-llm/local-llm-service.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "local-llm-service-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    // Never let esbuild try to actually resolve/inline node-llama-cpp — native-loader.ts's default
    // `importModule` is `() => import("node-llama-cpp")`, referenced only as a fallback default
    // that every test here overrides with a fake. Marking it external keeps esbuild from touching
    // it at build time at all (matches node-llama-cpp's own Electron-bundling guidance).
    external: ["node-llama-cpp"],
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-local-llm-service-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Same technique as local-llm-model-repository.test.mjs's buildGgufBuffer: a real (spec-shaped)
 * GGUF byte buffer, good enough to exercise gguf-metadata-reader.ts's real header parser without
 * needing an actual runnable model. */
function buildGgufBuffer({ magic = "GGUF", version = 3, tensorCount = 0n, kvEntries = [] } = {}) {
  const parts = [Buffer.from(magic, "ascii")];
  const versionBuf = Buffer.alloc(4); versionBuf.writeUInt32LE(version, 0); parts.push(versionBuf);
  const tensorCountBuf = Buffer.alloc(8); tensorCountBuf.writeBigUInt64LE(BigInt(tensorCount), 0); parts.push(tensorCountBuf);
  const kvCountBuf = Buffer.alloc(8); kvCountBuf.writeBigUInt64LE(BigInt(kvEntries.length), 0); parts.push(kvCountBuf);
  for (const [key, value] of kvEntries) {
    const keyBuf = Buffer.from(key, "utf8");
    const keyLenBuf = Buffer.alloc(8); keyLenBuf.writeBigUInt64LE(BigInt(keyBuf.length), 0);
    const typeBuf = Buffer.alloc(4); typeBuf.writeUInt32LE(8, 0); // GGUF_TYPE.STRING
    const valueBuf = Buffer.from(value, "utf8");
    const valueLenBuf = Buffer.alloc(8); valueLenBuf.writeBigUInt64LE(BigInt(valueBuf.length), 0);
    parts.push(keyLenBuf, keyBuf, typeBuf, valueLenBuf, valueBuf);
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// Fake node-llama-cpp backend — structural shapes hand-verified against the real
// node-llama-cpp@3.19.0 package (see local-llm-service-integration.test.mjs, which runs the same
// code paths against the real module + a real tiny GGUF fixture).
// -------------------------------------------------------------------------------------------

function createFakeLlamaModule(overrides = {}) {
  const behavior = overrides.behavior ?? {};
  const disposedFlags = { models: [], contexts: [], sessions: [] };
  const disposeOrder = [];

  class FakeLlamaChatSession {
    constructor(options) {
      this.contextSequence = options.contextSequence;
      this.systemPrompt = options.systemPrompt ?? "";
      this.disposed = false;
      this._history = [{ type: "system", text: this.systemPrompt }];
      disposedFlags.sessions.push(this);
    }
    setChatHistory(history) {
      this._history = history;
    }
    async prompt(promptText, options = {}) {
      if (behavior.onPrompt) return behavior.onPrompt(promptText, options, this);
      const tokens = overrides.responseTokens ?? ["Hello", ",", " world", "!"];
      let text = "";
      for (const token of tokens) {
        await Promise.resolve();
        if (options.signal?.aborted) {
          const error = new DOMException("This operation was aborted", "AbortError");
          throw error;
        }
        text += token;
        options.onTextChunk?.(token);
      }
      return text;
    }
    dispose() {
      this.disposed = true;
      disposeOrder.push("session");
    }
  }

  class FakeLlamaContext {
    constructor(contextSize) {
      this.contextSize = contextSize;
      this.disposed = false;
      this._sequence = { id: Math.random() };
      disposedFlags.contexts.push(this);
    }
    getSequence() {
      return this._sequence;
    }
    async dispose() {
      this.disposed = true;
      disposeOrder.push("context");
    }
  }

  class FakeLlamaModel {
    constructor(modelPath) {
      this.modelPath = modelPath;
      this.size = overrides.sizeBytes ?? 123456;
      this.trainContextSize = overrides.trainContextSize ?? 4096;
      this.disposed = false;
      disposedFlags.models.push(this);
    }
    tokenize(text) {
      return Array.from({ length: Math.max(1, Math.ceil(text.length / 4)) }, (_, index) => index);
    }
    async createContext(options) {
      if (behavior.onCreateContext) return behavior.onCreateContext(options);
      return new FakeLlamaContext(options.contextSize ?? 2048);
    }
    async dispose() {
      this.disposed = true;
      disposeOrder.push("model");
    }
  }

  const llama = {
    gpu: overrides.gpu ?? false,
    async loadModel(options) {
      if (behavior.onLoadModel) return behavior.onLoadModel(options);
      return new FakeLlamaModel(options.modelPath);
    },
    async getVramState() {
      return { total: 0, used: 0, free: 0 };
    },
  };

  const module = {
    async getLlama() {
      if (behavior.onGetLlama) return behavior.onGetLlama();
      return llama;
    },
    LlamaChatSession: FakeLlamaChatSession,
    async getModuleVersion() {
      return "0.0.0-fake";
    },
  };

  return { module, llama, disposedFlags, disposeOrder };
}

function fakeNativeLoaderDeps(fakeModule) {
  return { importModule: async () => fakeModule.module };
}

async function writeFixtureModel(directory, id, options = {}) {
  const filePath = path.join(directory, `${id}.gguf`);
  await fs.writeFile(filePath, buildGgufBuffer({ kvEntries: [["general.architecture", "llama"], ["general.name", id]] }));
  return {
    id,
    displayName: options.displayName ?? id,
    architecture: "llama",
    path: filePath,
  };
}

function createFakeModelRepository(models) {
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

// =============================================================================================
// local-llm-state.ts
// =============================================================================================

test("local-llm-state: canTransitionLocalLlmState matches the issue's transition table exactly, including that only unavailable self-loops", async () => {
  const { modules } = await loadModules();
  const table = {
    unavailable: ["unavailable"],
    idle: ["loading"],
    loading: ["ready", "idle", "error"],
    ready: ["generating", "unloading", "loading"],
    generating: ["ready", "error", "unloading"],
    unloading: ["idle", "error"],
    error: ["idle", "loading", "unavailable"],
  };
  const statuses = Object.keys(table);
  for (const from of statuses) {
    for (const to of statuses) {
      const expected = table[from].includes(to);
      assert.equal(modules.canTransitionLocalLlmState(from, to), expected, `${from} -> ${to} expected ${expected}`);
    }
  }
});

test("local-llm-state: assertLocalLlmTransition throws InvalidLocalLlmTransitionError for a rejected transition and is silent for an allowed one", async () => {
  const { modules } = await loadModules();
  assert.doesNotThrow(() => modules.assertLocalLlmTransition("idle", "loading"));
  assert.throws(() => modules.assertLocalLlmTransition("idle", "ready"), modules.InvalidLocalLlmTransitionError);
  assert.throws(() => modules.assertLocalLlmTransition("ready", "ready"), modules.InvalidLocalLlmTransitionError);
});

// =============================================================================================
// native-loader.ts
// =============================================================================================

test("NativeLoader: converts a failed dynamic import into an unavailable result with diagnostics, and never re-invokes importModule after that", async () => {
  const { modules } = await loadModules();
  let calls = 0;
  const loader = new modules.NativeLoader({
    importModule: async () => { calls += 1; throw new Error("Cannot find module 'node-llama-cpp'"); },
    platform: "linux",
    arch: "x64",
  });
  const first = await loader.load();
  assert.equal(first.available, false);
  assert.match(first.reason, /Cannot find module/);
  assert.equal(first.diagnostics.platform, "linux");
  assert.equal(first.diagnostics.arch, "x64");
  assert.equal(first.diagnostics.backend, null);

  const second = await loader.load();
  assert.equal(second.available, false);
  assert.equal(calls, 1, "a second load() must reuse the memoized result, not re-import");
});

test("NativeLoader: converts a getLlama() failure (module imported fine, no usable backend) into unavailable", async () => {
  const { modules } = await loadModules();
  const loader = new modules.NativeLoader({
    importModule: async () => ({ getLlama: async () => { throw new Error("no backend found for this platform"); }, LlamaChatSession: class {} }),
  });
  const result = await loader.load();
  assert.equal(result.available, false);
  assert.match(result.reason, /no backend found/);
});

test("NativeLoader: reports available with backend/platform/arch/packageVersion diagnostics on success", async () => {
  const { modules } = await loadModules();
  const fake = createFakeLlamaModule({ gpu: "metal" });
  const loader = new modules.NativeLoader({ importModule: async () => fake.module, platform: "darwin", arch: "arm64" });
  const result = await loader.load();
  assert.equal(result.available, true);
  assert.equal(result.diagnostics.backend, "metal");
  assert.equal(result.diagnostics.platform, "darwin");
  assert.equal(result.diagnostics.arch, "arm64");
  assert.equal(result.diagnostics.packageVersion, "0.0.0-fake");
  assert.equal(result.diagnostics.runtimeMode, "dev");
});

test("NativeLoader: load() is single-flight — concurrent calls share the exact same import attempt", async () => {
  const { modules } = await loadModules();
  let calls = 0;
  let resolveImport;
  const importPromise = new Promise((resolve) => { resolveImport = resolve; });
  const fake = createFakeLlamaModule();
  const loader = new modules.NativeLoader({ importModule: async () => { calls += 1; return importPromise; } });

  const first = loader.load();
  const second = loader.load();
  resolveImport(fake.module);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(firstResult, secondResult);
});

test("NativeLoader: dispose() prevents any import attempt, even before load() was ever called", async () => {
  const { modules } = await loadModules();
  let calls = 0;
  const loader = new modules.NativeLoader({ importModule: async () => { calls += 1; return createFakeLlamaModule().module; } });
  loader.dispose();
  const result = await loader.load();
  assert.equal(result.available, false);
  assert.match(result.reason, /disposed/);
  assert.equal(calls, 0);
});

// =============================================================================================
// generation-queue.ts
// =============================================================================================

test("GenerationQueue: the first job is admitted directly into the active slot", async () => {
  const { modules } = await loadModules();
  const queue = new modules.GenerationQueue({ maxPending: 3 });
  const ticket = queue.enqueue({ requestId: "a", generation: 0 });
  assert.equal(queue.activeRequestId, "a");
  assert.equal(queue.pendingCount, 0);
  await ticket.waitForTurn(); // resolves immediately
});

test("GenerationQueue: admits up to maxPending pending jobs and rejects the next with QUEUE_FULL", async () => {
  const { modules } = await loadModules();
  const queue = new modules.GenerationQueue({ maxPending: 3 });
  queue.enqueue({ requestId: "active", generation: 0 });
  queue.enqueue({ requestId: "p1", generation: 0 });
  queue.enqueue({ requestId: "p2", generation: 0 });
  queue.enqueue({ requestId: "p3", generation: 0 });
  assert.equal(queue.pendingCount, 3);
  assert.throws(() => queue.enqueue({ requestId: "p4", generation: 0 }), (error) => modules.isLocalLlmError(error) && error.code === "QUEUE_FULL");
});

test("GenerationQueue: settleActive activates pending jobs strictly in FIFO order", async () => {
  const { modules } = await loadModules();
  const queue = new modules.GenerationQueue({ maxPending: 3 });
  const order = [];
  const active = queue.enqueue({ requestId: "active", generation: 0 });
  const p1 = queue.enqueue({ requestId: "p1", generation: 0 });
  const p2 = queue.enqueue({ requestId: "p2", generation: 0 });
  void active.waitForTurn().then(() => order.push("active"));
  void p1.waitForTurn().then(() => order.push("p1"));
  void p2.waitForTurn().then(() => order.push("p2"));

  await Promise.resolve();
  assert.deepEqual(order, ["active"]);

  queue.settleActive("active");
  assert.equal(queue.activeRequestId, "p1");
  await Promise.resolve();
  assert.deepEqual(order, ["active", "p1"]);

  queue.settleActive("p1");
  assert.equal(queue.activeRequestId, "p2");
  await Promise.resolve();
  assert.deepEqual(order, ["active", "p1", "p2"]);

  queue.settleActive("p2");
  assert.equal(queue.activeRequestId, null);
});

test("GenerationQueue: cancel() removes a pending job and rejects its ticket; returns false for the active job or an unknown id", async () => {
  const { modules } = await loadModules();
  const queue = new modules.GenerationQueue({ maxPending: 3 });
  queue.enqueue({ requestId: "active", generation: 0 });
  const pending = queue.enqueue({ requestId: "p1", generation: 0 });

  assert.equal(queue.cancel("does-not-exist"), false);
  assert.equal(queue.cancel("active"), false, "cancelling the active job is out of scope for this queue");

  assert.equal(queue.cancel("p1"), true);
  assert.equal(queue.pendingCount, 0);
  await assert.rejects(pending.waitForTurn(), (error) => modules.isLocalLlmError(error) && error.code === "CANCELLED");
});

test("GenerationQueue: cancelStaleGeneration only cancels pending jobs whose generation differs, leaving the active job alone", async () => {
  const { modules } = await loadModules();
  const queue = new modules.GenerationQueue({ maxPending: 3 });
  queue.enqueue({ requestId: "active", generation: 0 });
  const stale = queue.enqueue({ requestId: "stale", generation: 0 });
  const fresh = queue.enqueue({ requestId: "fresh", generation: 1 });

  const cancelled = queue.cancelStaleGeneration(1);
  assert.deepEqual(cancelled, ["stale"]);
  assert.equal(queue.pendingRequestIds.length, 1);
  assert.equal(queue.pendingRequestIds[0], "fresh");
  assert.equal(queue.activeRequestId, "active", "the active job's generation is not evaluated by this method");
  await assert.rejects(stale.waitForTurn());
  fresh.waitForTurn(); // still pending — must not reject
});

test("GenerationQueue: cancelAllPending rejects every pending ticket and empties the queue", async () => {
  const { modules } = await loadModules();
  const queue = new modules.GenerationQueue({ maxPending: 3 });
  queue.enqueue({ requestId: "active", generation: 0 });
  const p1 = queue.enqueue({ requestId: "p1", generation: 0 });
  const p2 = queue.enqueue({ requestId: "p2", generation: 0 });

  const cancelled = queue.cancelAllPending("shutting down");
  assert.deepEqual(cancelled.sort(), ["p1", "p2"]);
  assert.equal(queue.pendingCount, 0);
  await assert.rejects(p1.waitForTurn());
  await assert.rejects(p2.waitForTurn());
});

// =============================================================================================
// schemas.ts / message-adapter.ts
// =============================================================================================

test("classifyMessageContent: text and text-part arrays are accepted, image_url is flagged unsupported-capability, anything else is invalid (never silently stringified)", async () => {
  const { modules } = await loadModules();
  assert.deepEqual(modules.classifyMessageContent("hello"), { kind: "text", text: "hello" });
  assert.deepEqual(modules.classifyMessageContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]), { kind: "text", text: "a\nb" });
  assert.deepEqual(modules.classifyMessageContent([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]), { kind: "unsupported-capability", capability: "vision" });
  assert.deepEqual(modules.classifyMessageContent(42), { kind: "invalid" });
  assert.deepEqual(modules.classifyMessageContent({ weird: true }), { kind: "invalid" });
  assert.deepEqual(modules.classifyMessageContent([{ type: "tool_use", weird: true }]), { kind: "invalid" });
});

test("adaptMessages: merges system messages in order into one systemPrompt, preserves non-alternating turns, and requires the last message to be role user", async () => {
  const { modules } = await loadModules();
  const ok = modules.adaptMessages([
    { role: "system", content: "You are helpful." },
    { role: "system", content: "Be concise." },
    { role: "user", content: "hi" },
    { role: "user", content: "hi again" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "final question" },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.systemPrompt, "You are helpful.\n\nBe concise.");
  assert.equal(ok.value.prompt, "final question");
  assert.deepEqual(ok.value.history.map((item) => item.type), ["system", "user", "user", "model"]);
  assert.equal(ok.value.history[1].text, "hi");
  assert.equal(ok.value.history[2].text, "hi again");
  assert.deepEqual(ok.value.history[3].response, ["hello"]);

  const badLastRole = modules.adaptMessages([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
  assert.equal(badLastRole.ok, false);
  assert.match(badLastRole.reason, /last message must have role "user"/);

  const noTurns = modules.adaptMessages([{ role: "system", content: "only a system message" }]);
  assert.equal(noTurns.ok, false);

  const imageContent = modules.adaptMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }]);
  assert.equal(imageContent.ok, false);
  assert.equal(imageContent.capability, "vision");
});

test("validateMessages: enforces message count, per-message length, and predicted-token-budget limits", async () => {
  const { modules } = await loadModules();
  assert.equal(modules.validateMessages([]).ok, false);
  assert.equal(modules.validateMessages(Array.from({ length: 200 }, () => ({ role: "user", content: "x" }))).ok, false);
  assert.equal(modules.validateMessages([{ role: "user", content: "x".repeat(9000) }]).ok, false);
  const result = modules.validateMessages([{ role: "user", content: "x".repeat(400) }], { maxContextTokens: 10 });
  assert.equal(result.ok, false);
  assert.match(result.failure.reason, /predicted prompt tokens/);
  assert.equal(modules.validateMessages([{ role: "user", content: "hello" }]).ok, true);
});

// =============================================================================================
// local-llm-errors.ts
// =============================================================================================

test("LocalLlmError.toJSON() never exposes a stack trace or the underlying cause — only code/message/diagnosticId/retryable", async () => {
  const { modules } = await loadModules();
  const cause = new Error("ENOENT: /Users/someone/secret/path/model.gguf");
  const error = new modules.LocalLlmError("MODEL_NOT_FOUND", "the installed model's file could not be resolved", { cause });
  const shape = error.toJSON();
  assert.deepEqual(Object.keys(shape).sort(), ["code", "diagnosticId", "message", "retryable"]);
  assert.equal(shape.code, "MODEL_NOT_FOUND");
  assert.ok(shape.diagnosticId.length > 0);
  const serialized = JSON.stringify(shape);
  assert.ok(!serialized.includes("/Users/someone/secret/path"), "toJSON() must never leak a filesystem path from the cause");
  assert.ok(!serialized.includes("at ("), "toJSON() must never leak a stack trace");
});

test("normalizeLocalLlmError: classifies OOM / context-overflow / abort messages using node-llama-cpp's REAL message text, and defaults everything else to the given fallback code", async () => {
  const { modules } = await loadModules();
  // Real node-llama-cpp@3.19.0 messages, verified against node_modules/node-llama-cpp/dist source
  // during development — see local-llm-errors.ts's classifyNativeErrorMessage() doc comment.
  assert.equal(modules.normalizeLocalLlmError(new Error("Insufficient memory")).code, "OUT_OF_MEMORY", "InsufficientMemoryError's real default message");
  assert.equal(modules.normalizeLocalLlmError(new Error("A context size of 4096 is too large for the available VRAM")).code, "OUT_OF_MEMORY", "InsufficientMemoryError's real context-size message");
  assert.equal(modules.normalizeLocalLlmError(new Error("Failed to compress chat history for context shift due to a too long prompt")).code, "CONTEXT_OVERFLOW");
  assert.equal(modules.normalizeLocalLlmError(new Error("Failed to free up space for new tokens")).code, "CONTEXT_OVERFLOW", "LlamaContext's real token-eviction failure message");
  assert.equal(modules.normalizeLocalLlmError(new Error("no room left on the shelf")).code, "GENERATION_FAILED", "a message merely containing the substring 'oom' must NOT be misclassified as OUT_OF_MEMORY");
  const abortError = new DOMException("This operation was aborted", "AbortError");
  assert.equal(modules.normalizeLocalLlmError(abortError).code, "CANCELLED");
  assert.equal(modules.isCancellation(abortError), true);
  assert.equal(modules.normalizeLocalLlmError(new Error("totally unexpected"), "GENERATION_FAILED").code, "GENERATION_FAILED");
  const existing = new modules.LocalLlmError("QUEUE_FULL", "already a LocalLlmError");
  assert.equal(modules.normalizeLocalLlmError(existing), existing, "an existing LocalLlmError must be passed through unchanged");
});

test("logLocalLlmError: writes a structured, redacted log line keyed by the error's diagnosticId, without throwing", async () => {
  const { modules } = await loadModules();
  const originalError = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args);
  try {
    const error = new modules.LocalLlmError("GENERATION_FAILED", "boom", { cause: new Error("native detail") });
    modules.logLocalLlmError(error, { modelId: "fixture-model", apiKey: "should-be-redacted" });
  } finally {
    console.error = originalError;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0][0], /boom/);
  const fields = lines[0][1];
  assert.equal(fields.code, "GENERATION_FAILED");
  assert.equal(fields.modelId, "fixture-model");
  assert.equal(fields.causeMessage, "native detail");
  const serialized = JSON.stringify(lines[0]);
  assert.ok(serialized.includes("boom"), "sanity: the message itself must have been logged");
  assert.ok(!serialized.includes("should-be-redacted"), "apiKey-shaped fields must be redacted even in local-llm's own log fields");
});

// =============================================================================================
// local-llm-service.ts — full state machine / queue / cancellation integration, mock backend
// =============================================================================================

async function setupService(options = {}) {
  const directory = await tempDir("dociai-local-llm-svc-");
  const fake = createFakeLlamaModule(options.fakeModuleOverrides);
  const models = options.models ?? [await writeFixtureModel(directory, "fixture-model")];
  const repository = createFakeModelRepository(models);
  const { modules } = await loadModules();
  const progressEvents = [];
  const service = new modules.LocalLlmService({
    modelRepository: repository,
    nativeLoaderDeps: options.unavailable ? { importModule: async () => { throw new Error("node-llama-cpp not installed"); } } : fakeNativeLoaderDeps(fake),
    maxPending: options.maxPending,
    emitLoadProgress: (event) => progressEvents.push(event),
  });
  return { modules, service, fake, models, directory, progressEvents };
}

async function cleanup(directory) {
  await fs.rm(directory, { recursive: true, force: true });
}

test("LocalLlmService.initialize(): native module unavailable -> capabilities.available=false and state becomes unavailable", async () => {
  const { service, directory } = await setupService({ unavailable: true });
  try {
    const capabilities = await service.initialize();
    assert.equal(capabilities.available, false);
    assert.match(capabilities.reason, /node-llama-cpp not installed/);
    assert.deepEqual(service.getState(), { status: "unavailable", reason: capabilities.reason });
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.initialize(): success reports backend/platform/arch and leaves state idle; a second call is memoized", async () => {
  const { service, fake, directory } = await setupService({ fakeModuleOverrides: { gpu: "metal" } });
  let importCalls = 0;
  const originalImport = fake.module.getLlama;
  fake.module.getLlama = async (...args) => { importCalls += 1; return originalImport(...args); };
  try {
    const first = await service.initialize();
    assert.equal(first.available, true);
    assert.equal(first.backend, "metal");
    assert.deepEqual(service.getState(), { status: "idle" });

    const second = await service.initialize();
    assert.deepEqual(second, first);
    assert.equal(importCalls, 1);
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.load(): unknown modelId -> MODEL_NOT_INSTALLED and state -> error", async () => {
  const { service, directory } = await setupService();
  try {
    await service.initialize();
    const context = service.createRequestContext();
    await assert.rejects(service.load({ modelId: "does-not-exist" }, context), (error) => error.code === "MODEL_NOT_INSTALLED");
    assert.equal(service.getState().status, "error");
    assert.equal(service.getState().error.code, "MODEL_NOT_INSTALLED");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.load(): missing file on disk -> MODEL_NOT_FOUND", async () => {
  const { service, directory, models } = await setupService();
  try {
    await service.initialize();
    await fs.rm(models[0].path);
    const context = service.createRequestContext();
    await assert.rejects(service.load({ modelId: "fixture-model" }, context), (error) => error.code === "MODEL_NOT_FOUND");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.load(): invalid GGUF magic bytes -> INVALID_GGUF", async () => {
  const directory = await tempDir("dociai-local-llm-svc-badgguf-");
  try {
    const badPath = path.join(directory, "bad.gguf");
    await fs.writeFile(badPath, Buffer.from("NOTAGGUFFILEATALL"));
    const { modules } = await loadModules();
    const fake = createFakeLlamaModule();
    const service = new modules.LocalLlmService({
      modelRepository: createFakeModelRepository([{ id: "bad-model", displayName: "Bad", path: badPath }]),
      nativeLoaderDeps: fakeNativeLoaderDeps(fake),
    });
    await service.initialize();
    const context = service.createRequestContext();
    await assert.rejects(service.load({ modelId: "bad-model" }, context), (error) => error.code === "INVALID_GGUF");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.load(): while native module is unavailable -> NATIVE_UNAVAILABLE, without attempting an invalid state transition", async () => {
  const { service, directory } = await setupService({ unavailable: true });
  try {
    await service.initialize();
    const context = service.createRequestContext();
    await assert.rejects(service.load({ modelId: "fixture-model" }, context), (error) => error.code === "NATIVE_UNAVAILABLE");
    assert.equal(service.getState().status, "unavailable");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.load(): success walks idle -> loading -> ready, reports progress phases in order, and returns a correctly-shaped summary", async () => {
  const { service, directory, progressEvents } = await setupService();
  try {
    await service.initialize();
    const context = service.createRequestContext();
    const summary = await service.load({ modelId: "fixture-model" }, context);
    assert.equal(summary.modelId, "fixture-model");
    assert.equal(summary.backend, "cpu");
    assert.ok(summary.contextSize > 0);
    assert.ok(summary.loadDurationMs >= 0);
    assert.deepEqual(service.getState(), { status: "ready", model: summary });

    const phases = progressEvents.map((event) => event.phase);
    assert.deepEqual(phases, ["resolving", "validating_path", "verifying_file", "initializing_backend", "loading_model", "creating_context", "creating_session", "finalizing"]);
    for (const event of progressEvents) assert.equal(event.modelId, "fixture-model");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.load(): switching to a different model while ready walks ready -> unloading -> idle -> loading -> ready and disposes the old runtime in order", async () => {
  const directory = await tempDir("dociai-local-llm-svc-switch-");
  try {
    const modelA = await writeFixtureModel(directory, "model-a");
    const modelB = await writeFixtureModel(directory, "model-b");
    const { modules } = await loadModules();
    const fake = createFakeLlamaModule();
    const repository = createFakeModelRepository([modelA, modelB]);
    const statuses = [];
    const service = new modules.LocalLlmService({ modelRepository: repository, nativeLoaderDeps: fakeNativeLoaderDeps(fake) });
    await service.initialize();

    await service.load({ modelId: "model-a" }, service.createRequestContext());
    assert.equal(service.getState().status, "ready");

    // Snapshot the dispose order before the switch (model-a's runtime disposal happens inside this call).
    const summaryB = await service.load({ modelId: "model-b" }, service.createRequestContext());
    assert.equal(summaryB.modelId, "model-b");
    assert.equal(service.getState().status, "ready");
    assert.equal(service.getState().model.modelId, "model-b");
    assert.deepEqual(fake.disposeOrder, ["session", "context", "model"]);
    void statuses;
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.load(): while generating without force -> BUSY; with force=true cancels the active generation and proceeds", async () => {
  const directory = await tempDir("dociai-local-llm-svc-force-");
  try {
    let releaseGeneration;
    const gate = new Promise((resolve) => { releaseGeneration = resolve; });
    const modelA = await writeFixtureModel(directory, "model-a");
    const modelB = await writeFixtureModel(directory, "model-b");
    const { modules } = await loadModules();
    const fake = createFakeLlamaModule({
      behavior: {
        // Races the gate against the abort signal, like real node-llama-cpp does: an aborted
        // generation must unwind promptly rather than waiting for anything else in flight.
        onPrompt: async (promptText, options) => {
          await Promise.race([gate, new Promise((resolve) => options.signal?.addEventListener("abort", resolve))]);
          if (options.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
          return "done";
        },
      },
    });
    const repository = createFakeModelRepository([modelA, modelB]);
    const service = new modules.LocalLlmService({ modelRepository: repository, nativeLoaderDeps: fakeNativeLoaderDeps(fake) });
    await service.initialize();
    await service.load({ modelId: "model-a" }, service.createRequestContext());

    const genContext = service.createRequestContext();
    const events = [];
    const genPromise = (async () => {
      for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "hi" }] }, genContext)) {
        events.push(event);
      }
    })();
    // Let generate() reach the "generating" state before attempting the switch.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(service.getState().status, "generating");

    await assert.rejects(service.load({ modelId: "model-b", force: false }, service.createRequestContext()), (error) => error.code === "BUSY");

    const summary = await service.load({ modelId: "model-b", force: true }, service.createRequestContext());
    assert.equal(summary.modelId, "model-b");
    releaseGeneration();
    await genPromise;
    assert.ok(events.some((event) => event.type === "cancelled"), "the forced-out generation must observe cancellation");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.generate(): MODEL_NOT_READY when idle or when modelId does not match the loaded model", async () => {
  const { service, directory } = await setupService();
  try {
    await service.initialize();
    const idleEvents = [];
    for await (const event of service.generate({ modelId: "fixture-model", messages: [{ role: "user", content: "hi" }] }, service.createRequestContext())) idleEvents.push(event);
    assert.equal(idleEvents.length, 1);
    assert.equal(idleEvents[0].type, "error");
    assert.equal(idleEvents[0].error.code, "MODEL_NOT_READY");

    await service.load({ modelId: "fixture-model" }, service.createRequestContext());
    const mismatchEvents = [];
    for await (const event of service.generate({ modelId: "some-other-model", messages: [{ role: "user", content: "hi" }] }, service.createRequestContext())) mismatchEvents.push(event);
    assert.equal(mismatchEvents[0].error.code, "MODEL_NOT_READY");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.generate(): full success path streams token events in order then a done event with correct text/metrics, and prompt text never appears in metrics", async () => {
  const { service, directory } = await setupService({ fakeModuleOverrides: { responseTokens: ["Hel", "lo", "!"] } });
  try {
    await service.initialize();
    await service.load({ modelId: "fixture-model" }, service.createRequestContext());
    const events = [];
    for await (const event of service.generate({ modelId: "fixture-model", messages: [{ role: "user", content: "hi there" }] }, service.createRequestContext())) events.push(event);

    assert.deepEqual(events.map((event) => event.type), ["token", "token", "token", "done"]);
    assert.deepEqual(events.slice(0, 3).map((event) => event.text), ["Hel", "lo", "!"]);
    const done = events[3];
    assert.equal(done.text, "Hello!");
    assert.equal(done.metrics.generatedTokens, 3);
    assert.equal(done.metrics.backend, "cpu");
    assert.ok(done.metrics.promptTokens > 0);
    assert.ok(done.metrics.totalGenerationMs >= 0);
    assert.ok(!JSON.stringify(done.metrics).includes("hi there"), "metrics must never include prompt text");
    assert.equal(service.getState().status, "ready", "generate() must transition back to ready when it completes");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.generate(): image content yields UNSUPPORTED_CAPABILITY; an unrecognized content shape yields INVALID_REQUEST — neither is silently stringified", async () => {
  const { service, directory } = await setupService();
  try {
    await service.initialize();
    await service.load({ modelId: "fixture-model" }, service.createRequestContext());

    const imageEvents = [];
    for await (const event of service.generate({ modelId: "fixture-model", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] }, service.createRequestContext())) imageEvents.push(event);
    assert.equal(imageEvents[0].error.code, "UNSUPPORTED_CAPABILITY");

    const weirdEvents = [];
    for await (const event of service.generate({ modelId: "fixture-model", messages: [{ role: "user", content: { totally: "unexpected" } }] }, service.createRequestContext())) weirdEvents.push(event);
    assert.equal(weirdEvents[0].error.code, "INVALID_REQUEST");
    assert.equal(service.getState().status, "ready");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.generate(): 1 active + up to 3 pending run FIFO; a 5th concurrent request gets QUEUE_FULL immediately", async () => {
  const directory = await tempDir("dociai-local-llm-svc-fifo-");
  try {
    const gates = new Map();
    const order = [];
    const modelA = await writeFixtureModel(directory, "model-a");
    const { modules } = await loadModules();
    const fake = createFakeLlamaModule({
      behavior: {
        onPrompt: async (promptText) => {
          order.push(`start:${promptText}`);
          await new Promise((resolve) => { gates.set(promptText, resolve); });
          order.push(`end:${promptText}`);
          return `reply-${promptText}`;
        },
      },
    });
    const service = new modules.LocalLlmService({ modelRepository: createFakeModelRepository([modelA]), nativeLoaderDeps: fakeNativeLoaderDeps(fake), maxPending: 3 });
    await service.initialize();
    await service.load({ modelId: "model-a" }, service.createRequestContext());

    function runOne(label) {
      const results = [];
      const promise = (async () => {
        for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: label }] }, service.createRequestContext())) results.push(event);
      })();
      return { promise, results };
    }

    const r1 = runOne("r1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const r2 = runOne("r2");
    const r3 = runOne("r3");
    const r4 = runOne("r4");
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A 5th concurrent request must be rejected with QUEUE_FULL immediately, without ever
    // being admitted (pending is already at its max of 3: r2, r3, r4).
    const r5events = [];
    for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "r5" }] }, service.createRequestContext())) r5events.push(event);
    assert.equal(r5events[0].error.code, "QUEUE_FULL");

    gates.get("r1")();
    await r1.promise;
    gates.get("r2")();
    await r2.promise;
    gates.get("r3")();
    await r3.promise;
    gates.get("r4")();
    await r4.promise;

    assert.deepEqual(order, ["start:r1", "end:r1", "start:r2", "end:r2", "start:r3", "end:r3", "start:r4", "end:r4"]);
    for (const r of [r1, r2, r3, r4]) assert.equal(r.results.at(-1).type, "done");
    assert.equal(service.getState().status, "ready");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.cancel(): a pending request is removed from the queue and observed as cancelled by its own generate() caller", async () => {
  const directory = await tempDir("dociai-local-llm-svc-cancel-pending-");
  try {
    let releaseActive;
    const activeGate = new Promise((resolve) => { releaseActive = resolve; });
    const modelA = await writeFixtureModel(directory, "model-a");
    const { modules } = await loadModules();
    const fake = createFakeLlamaModule({ behavior: { onPrompt: async () => { await activeGate; return "active-done"; } } });
    const service = new modules.LocalLlmService({ modelRepository: createFakeModelRepository([modelA]), nativeLoaderDeps: fakeNativeLoaderDeps(fake) });
    await service.initialize();
    await service.load({ modelId: "model-a" }, service.createRequestContext());

    const activeContext = service.createRequestContext("app", "active-req");
    const activeEvents = [];
    const activePromise = (async () => { for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "active" }] }, activeContext)) activeEvents.push(event); })();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const pendingContext = service.createRequestContext("app", "pending-req");
    const pendingEvents = [];
    const pendingPromise = (async () => { for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "pending" }] }, pendingContext)) pendingEvents.push(event); })();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(service.cancel("pending-req"), true);
    await pendingPromise;
    assert.deepEqual(pendingEvents, [{ type: "cancelled", requestId: "pending-req", at: pendingEvents[0].at }]);

    releaseActive();
    await activePromise;
    assert.equal(activeEvents.at(-1).type, "done");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.cancel(): cancelling the active request stops token delivery mid-stream, and the NEXT queued request still completes successfully", async () => {
  const directory = await tempDir("dociai-local-llm-svc-cancel-active-");
  try {
    const modelA = await writeFixtureModel(directory, "model-a");
    const { modules } = await loadModules();
    const fake = createFakeLlamaModule({
      behavior: {
        onPrompt: async (promptText, options) => {
          if (promptText !== "cancel-me") return "second-request-reply";
          const tokens = ["a", "b", "c", "d", "e"];
          let text = "";
          for (const token of tokens) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (options.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
            text += token;
            options.onTextChunk?.(token);
          }
          return text;
        },
      },
    });
    const service = new modules.LocalLlmService({ modelRepository: createFakeModelRepository([modelA]), nativeLoaderDeps: fakeNativeLoaderDeps(fake) });
    await service.initialize();
    await service.load({ modelId: "model-a" }, service.createRequestContext());

    const cancelContext = service.createRequestContext("app", "to-cancel");
    const cancelEvents = [];
    const cancelPromise = (async () => { for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "cancel-me" }] }, cancelContext)) cancelEvents.push(event); })();

    // Let a couple of tokens through, then cancel mid-stream.
    await new Promise((resolve) => setTimeout(resolve, 12));
    assert.equal(service.cancel("to-cancel"), true);
    await cancelPromise;

    assert.equal(cancelEvents.at(-1).type, "cancelled");
    const tokenCountAtCancel = cancelEvents.filter((event) => event.type === "token").length;
    assert.ok(tokenCountAtCancel < 5, "cancellation must stop token delivery before every token was produced");

    // "active cancel後に次request成功": the next request must run to completion normally.
    const nextEvents = [];
    for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "next" }] }, service.createRequestContext())) nextEvents.push(event);
    assert.equal(nextEvents.at(-1).type, "done");
    assert.equal(nextEvents.at(-1).text, "second-request-reply");
    assert.equal(service.getState().status, "ready");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.generate(): switching models (config generation change) cancels every still-pending request", async () => {
  const directory = await tempDir("dociai-local-llm-svc-gen-cancel-");
  try {
    const modelA = await writeFixtureModel(directory, "model-a");
    const modelB = await writeFixtureModel(directory, "model-b");
    let releaseActive;
    const activeGate = new Promise((resolve) => { releaseActive = resolve; });
    const { modules } = await loadModules();
    const fake = createFakeLlamaModule({
      behavior: {
        onPrompt: async (_p, options) => {
          await Promise.race([activeGate, new Promise((resolve) => options.signal?.addEventListener("abort", resolve))]);
          if (options.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
          return "ok";
        },
      },
    });
    const service = new modules.LocalLlmService({ modelRepository: createFakeModelRepository([modelA, modelB]), nativeLoaderDeps: fakeNativeLoaderDeps(fake) });
    await service.initialize();
    await service.load({ modelId: "model-a" }, service.createRequestContext());

    const activePromise = (async () => { const out = []; for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "active" }] }, service.createRequestContext())) out.push(event); return out; })();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const pendingEvents1 = [];
    const pendingPromise1 = (async () => { for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "p1" }] }, service.createRequestContext())) pendingEvents1.push(event); })();
    const pendingEvents2 = [];
    const pendingPromise2 = (async () => { for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "p2" }] }, service.createRequestContext())) pendingEvents2.push(event); })();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await service.load({ modelId: "model-b", force: true }, service.createRequestContext());
    releaseActive();
    await Promise.all([activePromise, pendingPromise1, pendingPromise2]);

    assert.equal(pendingEvents1.at(-1).type, "cancelled");
    assert.equal(pendingEvents2.at(-1).type, "cancelled");
    assert.equal(service.getState().status, "ready");
    assert.equal(service.getState().model.modelId, "model-b");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.unload(): idle is a no-op; ready disposes the runtime and returns to idle; generating requires force", async () => {
  const directory = await tempDir("dociai-local-llm-svc-unload-");
  try {
    const modelA = await writeFixtureModel(directory, "model-a");
    const { modules } = await loadModules();
    let releaseActive;
    const activeGate = new Promise((resolve) => { releaseActive = resolve; });
    const fake = createFakeLlamaModule({
      behavior: {
        onPrompt: async (_p, options) => {
          await Promise.race([activeGate, new Promise((resolve) => options.signal?.addEventListener("abort", resolve))]);
          if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
          return "ok";
        },
      },
    });
    const service = new modules.LocalLlmService({ modelRepository: createFakeModelRepository([modelA]), nativeLoaderDeps: fakeNativeLoaderDeps(fake) });
    await service.initialize();

    await service.unload({}, service.createRequestContext()); // idle -> no-op, must not throw
    assert.equal(service.getState().status, "idle");

    await service.load({ modelId: "model-a" }, service.createRequestContext());
    await service.unload({}, service.createRequestContext());
    assert.equal(service.getState().status, "idle");
    assert.deepEqual(fake.disposeOrder, ["session", "context", "model"]);

    await service.load({ modelId: "model-a" }, service.createRequestContext());
    fake.disposeOrder.length = 0;
    const genPromise = (async () => { for await (const _e of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "hi" }] }, service.createRequestContext())) { /* drain */ } })();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await assert.rejects(service.unload({}, service.createRequestContext()), (error) => error.code === "BUSY");
    await service.unload({ force: true }, service.createRequestContext());
    assert.equal(service.getState().status, "idle");
    releaseActive();
    await genPromise;
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.dispose(): idempotent, disposes any resident model, and subsequent calls fail cleanly instead of hanging", async () => {
  const { service, directory } = await setupService();
  try {
    await service.initialize();
    await service.load({ modelId: "fixture-model" }, service.createRequestContext());
    await service.dispose();
    await service.dispose(); // must not throw a second time

    await assert.rejects(service.load({ modelId: "fixture-model" }, service.createRequestContext()), (error) => error.code === "NATIVE_UNAVAILABLE");
    assert.equal(service.cancel("anything"), false);
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.dispose(): racing an in-flight load() rejects load() with a clean LocalLlmError and does not leak the model that finished loading in the background", async () => {
  const directory = await tempDir("dociai-local-llm-svc-dispose-race-load-");
  try {
    const modelA = await writeFixtureModel(directory, "model-a");
    const { modules } = await loadModules();
    let releaseLoad;
    const gate = new Promise((resolve) => { releaseLoad = resolve; });
    let modelDisposed = false;
    const fake = createFakeLlamaModule({ behavior: { onLoadModel: async (options) => { await gate; modelDisposed = false; const model = { modelPath: options.modelPath, size: 1, trainContextSize: 128, tokenize: () => [1], async createContext() { return { contextSize: 128, getSequence: () => ({}), dispose: async () => {} }; }, async dispose() { modelDisposed = true; } }; return model; } } });
    const service = new modules.LocalLlmService({ modelRepository: createFakeModelRepository([modelA]), nativeLoaderDeps: fakeNativeLoaderDeps(fake) });
    await service.initialize();

    const loadPromise = service.load({ modelId: "model-a" }, service.createRequestContext());
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(service.getState().status, "loading");

    await service.dispose();
    assert.equal(service.getState().status, "unavailable");

    releaseLoad();
    await assert.rejects(loadPromise, (error) => {
      assert.equal(error.constructor.name, "LocalLlmError", `expected a LocalLlmError (not a raw InvalidLocalLlmTransitionError), got ${error.constructor.name}: ${error.message}`);
      assert.equal(error.code, "NATIVE_UNAVAILABLE");
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(modelDisposed, true, "the model that finished loading after dispose() must still be disposed, not leaked");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.dispose(): racing an in-flight unload() resolves unload() cleanly instead of throwing a raw InvalidLocalLlmTransitionError", async () => {
  const directory = await tempDir("dociai-local-llm-svc-dispose-race-unload-");
  try {
    const modelA = await writeFixtureModel(directory, "model-a");
    const { modules } = await loadModules();
    let releaseDispose;
    const gate = new Promise((resolve) => { releaseDispose = resolve; });
    let modelDisposed = false;
    const fake = createFakeLlamaModule({ behavior: { onLoadModel: async (options) => ({ modelPath: options.modelPath, size: 1, trainContextSize: 128, tokenize: () => [1], async createContext() { return { contextSize: 128, getSequence: () => ({}), dispose: async () => {} }; }, async dispose() { await gate; modelDisposed = true; } }) } });
    const service = new modules.LocalLlmService({ modelRepository: createFakeModelRepository([modelA]), nativeLoaderDeps: fakeNativeLoaderDeps(fake) });
    await service.initialize();
    await service.load({ modelId: "model-a" }, service.createRequestContext());
    assert.equal(service.getState().status, "ready");

    const unloadPromise = service.unload({}, service.createRequestContext());
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(service.getState().status, "unloading");

    await service.dispose(); // races in while unload()'s own runtime.unload() still awaits `gate`
    assert.equal(service.getState().status, "unavailable");

    releaseDispose();
    await unloadPromise; // must resolve (void), not reject with InvalidLocalLlmTransitionError
    assert.equal(modelDisposed, true);
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService.dispose(): during an active generation, cancels it cleanly rather than hanging (app-quit scenario)", async () => {
  const directory = await tempDir("dociai-local-llm-svc-quit-");
  try {
    const modelA = await writeFixtureModel(directory, "model-a");
    const { modules } = await loadModules();
    const stuckGate = new Promise(() => {}); // deliberately never resolves on its own
    const fake = createFakeLlamaModule({ behavior: { onPrompt: async (_p, options) => { await Promise.race([stuckGate, new Promise((resolve) => options.signal?.addEventListener("abort", resolve))]); if (options.signal?.aborted) throw new DOMException("aborted", "AbortError"); return "unreachable"; } } });
    const service = new modules.LocalLlmService({ modelRepository: createFakeModelRepository([modelA]), nativeLoaderDeps: fakeNativeLoaderDeps(fake) });
    await service.initialize();
    await service.load({ modelId: "model-a" }, service.createRequestContext());

    const events = [];
    const genPromise = (async () => { for await (const event of service.generate({ modelId: "model-a", messages: [{ role: "user", content: "hi" }] }, service.createRequestContext())) events.push(event); })();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await Promise.race([
      service.dispose(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("dispose() did not resolve — app quit would hang")), 2000)),
    ]);
    await genPromise;
    assert.equal(events.at(-1).type, "cancelled");
  } finally {
    await cleanup(directory);
  }
});

test("LocalLlmService: in a native-unavailable environment, initialize() still resolves (app startup continues) and load()/generate() fail with NATIVE_UNAVAILABLE", async () => {
  const { service, directory } = await setupService({ unavailable: true });
  try {
    await assert.doesNotReject(service.initialize());
    await assert.rejects(service.load({ modelId: "fixture-model" }, service.createRequestContext()), (error) => error.code === "NATIVE_UNAVAILABLE");
    const events = [];
    for await (const event of service.generate({ modelId: "fixture-model", messages: [{ role: "user", content: "hi" }] }, service.createRequestContext())) events.push(event);
    assert.equal(events[0].error.code, "MODEL_NOT_READY");
  } finally {
    await cleanup(directory);
  }
});

// =============================================================================================
// Stability
// =============================================================================================

test("Stability: load/unload 10 times always ends idle with no leaked runtime state", async () => {
  const { service, directory } = await setupService();
  try {
    await service.initialize();
    for (let i = 0; i < 10; i += 1) {
      await service.load({ modelId: "fixture-model" }, service.createRequestContext());
      assert.equal(service.getState().status, "ready");
      await service.unload({}, service.createRequestContext());
      assert.equal(service.getState().status, "idle");
    }
  } finally {
    await cleanup(directory);
  }
});

test("Stability: generate/cancel 50 times never deadlocks; the queue always drains and state always returns to ready", async () => {
  const { service, directory } = await setupService({ fakeModuleOverrides: { responseTokens: ["a", "b", "c"] } });
  try {
    await service.initialize();
    await service.load({ modelId: "fixture-model" }, service.createRequestContext());
    for (let i = 0; i < 50; i += 1) {
      const context = service.createRequestContext("app", `req-${i}`);
      const events = [];
      const promise = (async () => { for await (const event of service.generate({ modelId: "fixture-model", messages: [{ role: "user", content: `msg-${i}` }] }, context)) events.push(event); })();
      if (i % 2 === 0) service.cancel(`req-${i}`);
      await promise;
      assert.ok(events.length > 0);
    }
    assert.equal(service.getState().status, "ready");
    assert.equal(service.cancel("does-not-exist"), false);
  } finally {
    await cleanup(directory);
  }
});
