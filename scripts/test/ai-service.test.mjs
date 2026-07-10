import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { AiService } from "./electron/main/services/ai/ai-service.ts"; export { ServiceError } from "./electron/main/services/service-error.ts";`,
      resolveDir: path.resolve(new URL("../..", import.meta.url).pathname),
      sourcefile: "ai-service-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-ai-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

function dependencies(connectors, secrets = {}) {
  return {
    configRepository: { getPublic: async () => ({ config: { connectors }, revision: "test", warnings: [] }) },
    secretStore: { getForService: async (key) => secrets[key] ?? null },
  };
}

function input(id, options = {}) {
  return { connectorId: id, requestId: `${id}-request`, messages: [{ role: "user", content: "hello" }], options };
}

test("AiService resolves secrets in Main, normalizes OpenAI response, and never returns a secret", async () => {
  const { modules, directory } = await loadModules();
  try {
    const seen = [];
    const { configRepository, secretStore } = dependencies({ openrouter: { provider: "openrouter", model: "model", apiKeySecretRef: "connectors.openrouter.apiKey", retries: 0 } }, { "connectors.openrouter.apiKey": "test-secret" });
    const service = new modules.AiService(configRepository, secretStore, async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: " answer " } }], usage: { total_tokens: 3 } }), { status: 200 });
    });
    const result = await service.chat(input("openrouter"));
    assert.deepEqual(result, { text: "answer", usage: { total_tokens: 3 }, requestId: "openrouter-request" });
    assert.equal(seen[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(seen[0].headers.Authorization, "Bearer test-secret");
    assert.equal(seen[0].headers["HTTP-Referer"], "https://dociai.local");
    assert.doesNotMatch(JSON.stringify(result), /test-secret/);
    assert.doesNotMatch(JSON.stringify(seen[0].body), /test-secret/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("AiService delivers SSE tokens with request/generation and rejects empty streams", async () => {
  const { modules, directory } = await loadModules();
  try {
    const tokens = [];
    const { configRepository, secretStore } = dependencies({ stream: { provider: "openai", model: "model", apiKeySecretRef: "connectors.stream.apiKey", retries: 0 } }, { "connectors.stream.apiKey": "test-secret" });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}],"usage":{"total_tokens":2}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const service = new modules.AiService(configRepository, secretStore, async () => new Response(stream, { status: 200 }), (event) => tokens.push(event));
    const result = await service.chat(input("stream", { stream: true }));
    assert.equal(result.text, "hello world");
    assert.equal(result.usage.total_tokens, 2);
    assert.deepEqual(tokens.map((event) => event.text), ["hello", " world"]);
    assert.ok(tokens.every((event) => event.requestId === "stream-request" && event.generation === 0));

    const miniMaxStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"mini"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" max"}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n'));
        controller.close();
      },
    });
    const miniMax = dependencies({ minimax: { provider: "minimax", model: "MiniMax-M3", apiKeySecretRef: "connectors.minimax.apiKey", retries: 0 } }, { "connectors.minimax.apiKey": "test-secret" });
    const miniMaxTokens = [];
    const miniMaxService = new modules.AiService(miniMax.configRepository, miniMax.secretStore, async () => new Response(miniMaxStream, { status: 200 }), (event) => miniMaxTokens.push(event.text));
    const miniMaxResult = await miniMaxService.chat(input("minimax", { stream: true }));
    assert.equal(miniMaxResult.text, "mini max");
    assert.equal(miniMaxResult.usage.output_tokens, 2);
    assert.deepEqual(miniMaxTokens, ["mini", " max"]);

    const empty = new modules.AiService(configRepository, secretStore, async () => new Response("data: [DONE]\n\n", { status: 200 }));
    await assert.rejects(empty.chat(input("stream", { stream: true })), (error) => error.code === "EMPTY");

    const staleTokens = [];
    const staleStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"old"}}]}\n\ndata: {"choices":[{"delta":{"content":" result"}}]}\n\n'));
        controller.close();
      },
    });
    let staleService;
    staleService = new modules.AiService(configRepository, secretStore, async () => new Response(staleStream, { status: 200 }), (event) => {
      staleTokens.push(event.text);
      staleService.runtime.reload();
    });
    await assert.rejects(staleService.chat(input("stream", { stream: true })), (error) => error.code === "CANCELLED");
    assert.deepEqual(staleTokens, ["old"]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("AiService maps provider failures, missing configuration, and cancellation", async () => {
  const { modules, directory } = await loadModules();
  try {
    for (const [status, code] of [[400, "BAD_REQUEST"], [401, "AUTH"], [403, "AUTH"], [429, "RATE_LIMIT"], [500, "SERVER"]]) {
      const { configRepository, secretStore } = dependencies({ remote: { provider: "openai", model: "model", apiKeySecretRef: "connectors.remote.apiKey", retries: 0 } }, { "connectors.remote.apiKey": "test-secret" });
      const service = new modules.AiService(configRepository, secretStore, async () => new Response("{}", { status }));
      await assert.rejects(service.chat(input("remote")), (error) => error.code === code);
    }
    const missing = dependencies({ remote: { provider: "openai", model: "model", apiKeySecretRef: "connectors.remote.apiKey" } });
    await assert.rejects(new modules.AiService(missing.configRepository, missing.secretStore).chat(input("remote")), (error) => error.code === "AUTH");
    const noModel = dependencies({ remote: { provider: "openai", apiKeySecretRef: "connectors.remote.apiKey" } }, { "connectors.remote.apiKey": "test-secret" });
    await assert.rejects(new modules.AiService(noModel.configRepository, noModel.secretStore).chat(input("remote")), (error) => error.code === "BAD_REQUEST");
    const badUrl = dependencies({ remote: { provider: "openai", model: "model", baseUrl: "", apiKeySecretRef: "connectors.remote.apiKey" } }, { "connectors.remote.apiKey": "test-secret" });
    await assert.rejects(new modules.AiService(badUrl.configRepository, badUrl.secretStore).chat(input("remote")), (error) => error.code === "BAD_REQUEST");

    const cancellable = dependencies({ remote: { provider: "openai", model: "model", apiKeySecretRef: "connectors.remote.apiKey", retries: 0 } }, { "connectors.remote.apiKey": "test-secret" });
    const service = new modules.AiService(cancellable.configRepository, cancellable.secretStore, async (_url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })));
    const pending = service.chat(input("remote"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(service.cancel("remote-request"), true);
    await assert.rejects(pending, (error) => error.code === "CANCELLED");

    let attempts = 0;
    const retry = dependencies({ remote: { provider: "openai", model: "model", apiKeySecretRef: "connectors.remote.apiKey", retries: 1 } }, { "connectors.remote.apiKey": "test-secret" });
    const retried = new modules.AiService(retry.configRepository, retry.secretStore, async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("{}", { status: 429, headers: { "Retry-After": "0" } })
        : new Response(JSON.stringify({ choices: [{ message: { content: "retried" } }] }), { status: 200 });
    });
    assert.equal((await retried.chat(input("remote"))).text, "retried");
    assert.equal(attempts, 2);

    const timeout = dependencies({ remote: { provider: "openai", model: "model", apiKeySecretRef: "connectors.remote.apiKey", retries: 0, timeoutMs: 1000 } }, { "connectors.remote.apiKey": "test-secret" });
    const timedOut = new modules.AiService(timeout.configRepository, timeout.secretStore, async (_url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })));
    await assert.rejects(timedOut.chat(input("remote")), (error) => error.code === "TIMEOUT");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
