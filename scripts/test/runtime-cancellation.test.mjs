import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { BrowserRuntimeController } from "./src/runtime/runtime-controller.js"; export { RequestCancelledError, StaleGenerationError, isCancellation } from "./src/runtime/request-registry.js"; export { createConnector } from "./src/connectors.js"; export { NewsReader } from "./src/news-reader.js";`,
      resolveDir: path.resolve(new URL("../..", import.meta.url).pathname),
      sourcefile: "runtime-cancellation-test.js",
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-runtime-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

test("Browser runtime cancels prior generations and guards stale completions", async () => {
  const { modules, directory } = await loadModules();
  try {
    const runtime = new modules.BrowserRuntimeController();
    const request = runtime.createRequest({ ownerId: "connector:0:mock", kind: "ai-chat" });
    assert.equal(runtime.requests.size, 1);
    const transition = runtime.beginTransition("config reload");
    assert.deepEqual(transition, { previous: 0, generation: 1, cancelledRequests: 1 });
    assert.equal(request.context.signal.aborted, true);
    assert.equal(runtime.requests.size, 0);
    assert.throws(() => runtime.guard(request.context), modules.RequestCancelledError);
    const current = runtime.createRequest({ ownerId: "connector:1:mock", kind: "ai-chat" });
    assert.doesNotThrow(() => runtime.guard(current.context));
    current.complete();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("Mock connector and NewsReader stop without stale UI or speech side effects", async () => {
  const { modules, directory } = await loadModules();
  try {
    const runtime = new modules.BrowserRuntimeController();
    const connector = modules.createConnector("slow", { provider: "mock", delayMs: 80 });
    const request = runtime.createRequest({ ownerId: "connector:0:slow", kind: "ai-chat" });
    const pending = connector.chat([{ role: "user", content: "hello" }], { signal: request.context.signal });
    runtime.beginTransition("config reload");
    await assert.rejects(pending, (error) => error.kind === "cancelled");

    const readerRuntime = new modules.BrowserRuntimeController();
    const readerRequest = readerRuntime.createRequest({ ownerId: "news:0", kind: "news-fetch" });
    const speech = [];
    const reads = [];
    const reader = new modules.NewsReader({
      config: { news: { enabled: true, maxItems: 1, sources: [{ type: "mock", name: "mock" }] } },
      getConnector: () => connector,
      personaRouter: { defaultPersona: () => ({ id: "p", name: "persona", enabled: true, voice: {} }) },
      contextBuilder: { build: () => ({ messages: [{ role: "user", content: "news" }], debugText: "debug" }) },
      speechQueue: { enqueue: (item) => speech.push(item) },
      onRead: (item) => reads.push(item),
    });
    const running = reader.run({ ...readerRequest.context, isCurrent: () => readerRuntime.isCurrent(readerRequest.context.generation) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    readerRuntime.beginTransition("config reload");
    await assert.rejects(running, (error) => modules.isCancellation(error));
    assert.equal(reads.length, 0);
    assert.equal(speech.length, 0);
    assert.equal(reader.readGuids.size, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
