import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { RequestRegistry } from "./electron/main/services/request-registry.ts"; export { ServiceError, errorFromHttpStatus } from "./electron/main/services/service-error.ts"; export { retryWithPolicy, retryDelay } from "./electron/main/services/retry-policy.ts"; export { createStructuredLogContext } from "./electron/main/services/structured-log-context.ts"; export { IntegrationHealth } from "./electron/main/services/integration-health.ts"; export { ServiceRuntime } from "./electron/main/services/service-runtime.ts";`,
      resolveDir: path.resolve(new URL("../..", import.meta.url).pathname),
      sourcefile: "service-runtime-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-service-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

test("RequestRegistry indexes owner/generation and cancels idempotently", async () => {
  const { modules, directory } = await loadModules();
  const timers = new Map();
  const clock = { now: () => 100, setTimeout: (callback, ms) => { timers.set(ms, callback); return ms; }, clearTimeout: (timer) => timers.delete(timer) };
  try {
    const registry = new modules.RequestRegistry(clock);
    const first = registry.create({ serviceId: "ai", generation: 1, ownerId: "window-1", requestId: "same", timeoutMs: 500 });
    assert.equal(registry.size, 1);
    assert.throws(() => registry.create({ serviceId: "ai", generation: 1, ownerId: "window-2", requestId: "same" }), /already active/);
    assert.equal(registry.cancelOwner("window-2"), 0);
    assert.equal(registry.cancelGeneration(1), 1);
    assert.equal(first.cancel(), false);
    assert.equal(registry.size, 0);
    const timed = registry.create({ serviceId: "ai", generation: 2, ownerId: "window-1", requestId: "timeout", timeoutMs: 20 });
    timers.get(20)();
    assert.equal(timed.cancel(), false);
    assert.equal(registry.size, 0);
    registry.dispose();
    assert.throws(() => registry.create({ serviceId: "ai", generation: 3, ownerId: "window-1" }), /disposed/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("retry policy honors Retry-After and never retries auth errors", async () => {
  const { modules, directory } = await loadModules();
  try {
    const context = { requestId: "r1", serviceId: "ai", generation: 1, ownerId: "test", signal: new AbortController().signal, startedAt: 0 };
    const delays = [];
    let attempts = 0;
    const value = await modules.retryWithPolicy(async () => {
      attempts += 1;
      if (attempts === 1) throw new modules.ServiceError("RATE_LIMIT", "slow", { retryAfterMs: 321 });
      return "ok";
    }, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1000 }, context, { sleep: async (ms) => delays.push(ms), random: () => 0.5 });
    assert.equal(value, "ok");
    assert.deepEqual(delays, [321]);
    attempts = 0;
    await assert.rejects(modules.retryWithPolicy(async () => { attempts += 1; throw modules.errorFromHttpStatus(401); }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 }, context, { sleep: async () => {} }), /HTTP 401/);
    assert.equal(attempts, 1);
    const cancelled = new AbortController();
    const cancelledContext = { ...context, requestId: "r2", signal: cancelled.signal };
    attempts = 0;
    await assert.rejects(modules.retryWithPolicy(async () => { attempts += 1; throw new modules.ServiceError("NETWORK", "offline"); }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 }, cancelledContext, { sleep: async () => cancelled.abort() }), /request cancelled/);
    assert.equal(attempts, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("structured logs redact secret-shaped fields and health events are observable", async () => {
  const { modules, directory } = await loadModules();
  try {
    const context = modules.createStructuredLogContext({ serviceId: "rss", requestId: "r1", fields: { authorization: "Bearer secret", nested: { token: "abc" }, count: 1 } });
    assert.equal(context.authorization, "[REDACTED]");
    assert.equal(context.nested.token, "[REDACTED]");
    const health = new modules.IntegrationHealth();
    const events = [];
    const unsubscribe = health.subscribe((event) => events.push(event));
    health.report({ type: "changed", serviceId: "rss", status: "healthy", at: 10, latencyMs: 4 });
    assert.equal(health.snapshot()[0].status, "healthy");
    assert.equal(events.length, 1);
    unsubscribe();
    health.dispose();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
