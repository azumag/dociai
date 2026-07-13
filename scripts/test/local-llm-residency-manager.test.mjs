// Unit coverage for #79's runtime/ layer: residency-mutex.ts, idle-unload-controller.ts,
// runtime-failure-history.ts, resource-sampler.ts, and model-residency-manager.ts (the orchestrator
// tying them together). Bundled the same way every other local-llm-*.test.mjs in this repo is.
//
// Scope reminder (matches this layer's own header comments): #45's LocalLlmService and #78's
// runtime-planner.ts are already covered by their own test suites
// (local-llm-service.test.mjs / local-llm-runtime-planner.test.mjs) against real/near-real
// fixtures. This file injects a FAKE LocalLlmService (mirroring #45's documented BUSY-unless-force
// and force-cancel-and-settle contract closely enough to prove this layer calls into it correctly,
// without any native model load), and uses the REAL `planRuntime()` from #78 for the OOM-fallback
// test so that test genuinely exercises the planner, not a canned mock plan.
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
        `export { ResidencyMutex } from "./electron/main/services/local-llm/runtime/residency-mutex.ts";`,
        `export { IdleUnloadController, DEFAULT_IDLE_TIMEOUT_MS } from "./electron/main/services/local-llm/runtime/idle-unload-controller.ts";`,
        `export { RuntimeFailureHistory, isTrackedFailureCode } from "./electron/main/services/local-llm/runtime/runtime-failure-history.ts";`,
        `export { ResourceSampler, compareEstimateToActual, cpuTimeDeltaMs } from "./electron/main/services/local-llm/runtime/resource-sampler.ts";`,
        `export { ModelResidencyManager, planKey } from "./electron/main/services/local-llm/runtime/model-residency-manager.ts";`,
        `export { LocalLlmError, isLocalLlmError } from "./electron/main/services/local-llm/local-llm-errors.ts";`,
        `export { planRuntime } from "./electron/main/services/local-llm/planning/runtime-planner.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "local-llm-residency-manager-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-residency-manager-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return import(file);
}

const modules = await loadModules();
const { ResidencyMutex, IdleUnloadController, RuntimeFailureHistory, isTrackedFailureCode, ResourceSampler, compareEstimateToActual, cpuTimeDeltaMs, ModelResidencyManager, planKey, LocalLlmError, planRuntime } = modules;

// =============================================================================================
// Test fixtures
// =============================================================================================

/** Same technique as twitch-eventsub.test.mjs's own createManualClock() (keepalive-watchdog.ts's
 * Clock shape) — never sleeps real wall-clock time; advance(ms) fires everything due, repeatedly,
 * so a callback that re-arms another timer within the same advance() is picked up too.
 * `pendingCount()` is this file's own addition, used by the "no leaked timer" stability test. */
function createManualClock(startMs = 0) {
  let time = startMs;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, ms) {
      const id = ++sequence;
      timers.set(id, { at: time + Math.max(0, ms), callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pendingCount: () => timers.size,
    advance(ms) {
      time += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, entry]) => entry.at <= time).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) return;
        for (const [id, entry] of due) {
          timers.delete(id);
          entry.callback();
        }
      }
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function defaultSummary(input) {
  return {
    modelId: input.modelId,
    displayName: input.modelId,
    sizeBytes: 1024,
    contextSize: input.contextSize ?? 2048,
    backend: "cpu",
    loadedAt: new Date(0).toISOString(),
    loadDurationMs: 1,
  };
}

/** Mirrors #45's LocalLlmService contract closely enough to prove this layer's integration with it
 * (BUSY-unless-force while "generating"; force cancels-and-settles before proceeding; dispose()
 * interrupts an in-flight load once its own async work completes) without any native dependency. */
function createFakeLocalLlmService(behavior = {}) {
  let state = { status: "idle" };
  let disposed = false;
  let pendingCount = 0;
  const calls = { load: [], unload: [] };
  const sequence = [];

  async function load(input) {
    if (disposed) throw new LocalLlmError("NATIVE_UNAVAILABLE", "disposed", { retryable: false });
    if (state.status === "generating") {
      if (!input.force) throw new LocalLlmError("BUSY", "a generation is already in progress; retry with force=true", { retryable: true });
      sequence.push(`cancel-start:${input.modelId}`);
      if (behavior.onForceCancel) await behavior.onForceCancel();
      sequence.push(`cancel-settled:${input.modelId}`);
      state = { status: "idle" };
    }
    calls.load.push({ ...input });
    sequence.push(`load-start:${input.modelId}:${input.contextSize}`);
    state = { status: "loading", modelId: input.modelId };
    const resolveLoad = behavior.resolveLoad ?? (async () => ({ ok: true }));
    const result = await resolveLoad(input);
    if (disposed) {
      state = { status: "unavailable", reason: "disposed while loading" };
      throw new LocalLlmError("NATIVE_UNAVAILABLE", "disposed while loading", { retryable: false });
    }
    if (!result.ok) {
      state = { status: "error", error: { code: result.code, message: result.message, diagnosticId: "test", retryable: result.retryable ?? false }, recoverable: true };
      sequence.push(`load-failed:${input.modelId}:${result.code}`);
      throw new LocalLlmError(result.code, result.message, { retryable: result.retryable ?? false });
    }
    const summary = result.summary ?? defaultSummary(input);
    state = { status: "ready", model: summary };
    sequence.push(`load-done:${input.modelId}`);
    return summary;
  }

  async function unload(input) {
    calls.unload.push({ ...input });
    if (disposed) return;
    state = { status: "idle" };
  }

  async function dispose() {
    disposed = true;
    state = { status: "unavailable", reason: "disposed" };
  }

  return {
    load,
    unload,
    dispose,
    getState: () => state,
    getPendingGenerationCount: () => pendingCount,
    setPendingGenerationCount(n) {
      pendingCount = n;
    },
    beginGenerating(modelId, summary) {
      state = { status: "generating", model: summary ?? defaultSummary({ modelId }), requestId: "req-gen", startedAt: 0 };
    },
    endGenerating() {
      state = { status: "ready", model: state.model };
    },
    get isDisposed() {
      return disposed;
    },
    calls,
    sequence,
  };
}

function basePlan(overrides = {}) {
  return { backend: "cpu", contextSize: 2048, gpuLayers: 0, batchSize: 512, threads: 4, ...overrides };
}

// =============================================================================================
// residency-mutex.ts
// =============================================================================================

test("ResidencyMutex.runExclusive: serializes operations FIFO — a second call never starts until the first settles", async () => {
  const mutex = new ResidencyMutex();
  const order = [];
  const first = deferred();

  const p1 = mutex.runExclusive(async () => {
    order.push("first-start");
    await first.promise;
    order.push("first-end");
    return "a";
  });
  const p2 = mutex.runExclusive(async () => {
    order.push("second-start");
    return "b";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"], "second operation must not start before the first settles");

  first.resolve();
  assert.equal(await p1, "a");
  assert.equal(await p2, "b");
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("ResidencyMutex.runExclusive: a rejected operation does not block the next queued operation", async () => {
  const mutex = new ResidencyMutex();
  const p1 = mutex.runExclusive(async () => {
    throw new Error("boom");
  });
  const p2 = mutex.runExclusive(async () => "ok");
  await assert.rejects(p1, /boom/);
  assert.equal(await p2, "ok");
});

test("ResidencyMutex.waitForIdle: resolves only once every queued operation (including ones queued after the first) has settled", async () => {
  const mutex = new ResidencyMutex();
  const gate = deferred();
  let secondRan = false;
  void mutex.runExclusive(() => gate.promise);
  void mutex.runExclusive(async () => {
    secondRan = true;
  });

  let idleResolved = false;
  const idlePromise = mutex.waitForIdle().then(() => {
    idleResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idleResolved, false);

  gate.resolve();
  await idlePromise;
  assert.equal(idleResolved, true);
  assert.equal(secondRan, true);
});

// =============================================================================================
// idle-unload-controller.ts
// =============================================================================================

test("IdleUnloadController: fires onIdleUnload once idleTimeoutMs elapses with no activity, and never fires again on its own", async () => {
  const clock = createManualClock();
  let fired = 0;
  const controller = new IdleUnloadController({ clock, idleTimeoutMs: 1000, isBusy: () => false, onIdleUnload: () => { fired += 1; } });
  controller.arm();
  clock.advance(999);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1);
  clock.advance(60_000);
  assert.equal(fired, 1);
});

test("IdleUnloadController.touch(): resets the countdown from the touch time", () => {
  const clock = createManualClock();
  let fired = 0;
  const controller = new IdleUnloadController({ clock, idleTimeoutMs: 1000, isBusy: () => false, onIdleUnload: () => { fired += 1; } });
  controller.arm();
  clock.advance(900);
  controller.touch();
  clock.advance(900); // total 1800 since arm, but only 900 since touch — must not have fired yet
  assert.equal(fired, 0);
  clock.advance(100);
  assert.equal(fired, 1);
});

test("IdleUnloadController: isBusy()===true at fire time defers instead of firing, with no explicit touch() needed, and fires once busy clears", () => {
  const clock = createManualClock();
  let busy = true;
  let fired = 0;
  const events = [];
  const controller = new IdleUnloadController({ clock, idleTimeoutMs: 1000, isBusy: () => busy, onIdleUnload: () => { fired += 1; }, onEvent: (event) => events.push(event) });
  controller.arm();
  clock.advance(1000);
  assert.equal(fired, 0, "must not fire while busy, even though the deadline elapsed and touch() was never called");
  assert.ok(events.some((event) => event.type === "deferred"));
  busy = false;
  clock.advance(1000);
  assert.equal(fired, 1);
});

test("IdleUnloadController.cancel(): stops the countdown; suspend()/resume(): elapsed time during suspension never counts as idle", () => {
  const clock = createManualClock();
  let fired = 0;
  const controller = new IdleUnloadController({ clock, idleTimeoutMs: 1000, isBusy: () => false, onIdleUnload: () => { fired += 1; } });

  controller.arm();
  controller.cancel("manual");
  clock.advance(10_000);
  assert.equal(fired, 0, "cancel() must stop the countdown outright");

  controller.arm();
  clock.advance(500);
  controller.suspend();
  clock.advance(100_000); // simulates a long OS sleep
  assert.equal(fired, 0, "suspended time must never count toward the idle deadline");
  controller.resume();
  assert.equal(controller.isArmed, false, "resume() alone does not re-arm — the manager decides that based on residency");
  controller.arm();
  clock.advance(999);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1);
});

// =============================================================================================
// runtime-failure-history.ts
// =============================================================================================

test("RuntimeFailureHistory: only tracks the 3 resource-shape failure codes; lookup/forget round-trip; attempts accumulate", () => {
  const history = new RuntimeFailureHistory({ now: () => 42 });
  assert.equal(isTrackedFailureCode("OUT_OF_MEMORY"), true);
  assert.equal(isTrackedFailureCode("BACKEND_INIT_FAILED"), true);
  assert.equal(isTrackedFailureCode("CONTEXT_CREATE_FAILED"), true);
  assert.equal(isTrackedFailureCode("MODEL_NOT_FOUND"), false);

  assert.equal(history.record("model-a", "key-1", "MODEL_NOT_FOUND", "nope"), null, "an untracked code is never recorded");
  assert.equal(history.lookup("model-a", "key-1"), null);

  const first = history.record("model-a", "key-1", "OUT_OF_MEMORY", "oom");
  assert.equal(first.attempts, 1);
  const second = history.record("model-a", "key-1", "OUT_OF_MEMORY", "oom again");
  assert.equal(second.attempts, 2);
  assert.equal(history.lookup("model-a", "key-1").attempts, 2);

  history.forget("model-a", "key-1");
  assert.equal(history.lookup("model-a", "key-1"), null);
});

test("RuntimeFailureHistory: bounded size — the least-recently-touched entry is evicted once maxEntries is exceeded", () => {
  const history = new RuntimeFailureHistory({ maxEntries: 2 });
  history.record("model-a", "k1", "OUT_OF_MEMORY", "m1");
  history.record("model-b", "k1", "OUT_OF_MEMORY", "m2");
  history.record("model-c", "k1", "OUT_OF_MEMORY", "m3");
  assert.equal(history.size, 2);
  assert.equal(history.lookup("model-a", "k1"), null, "oldest untouched entry evicted");
  assert.notEqual(history.lookup("model-b", "k1"), null);
  assert.notEqual(history.lookup("model-c", "k1"), null);
});

// =============================================================================================
// resource-sampler.ts
// =============================================================================================

test("ResourceSampler.sample(): reads process RSS/CPU and the (fresh, injected) hardware profile into one shape", async () => {
  let hardwareCalls = 0;
  const sampler = new ResourceSampler({
    now: () => 1000,
    getProcessMemoryUsage: () => ({ rss: 500 }),
    getProcessCpuUsage: () => ({ user: 100, system: 50 }),
    getHardwareProfile: async () => {
      hardwareCalls += 1;
      return { cpu: { cores: 4 }, ram: { totalBytes: 8000, freeBytes: 4000, availableBytes: 5000 }, gpu: { backend: { name: "cuda", supportsGpuOffload: true }, memory: { status: "known", totalBytes: 2000, freeBytes: 1200 } }, detectedAtMs: 1000, source: "detected" };
    },
  });
  const sample = await sampler.sample();
  assert.equal(hardwareCalls, 1);
  assert.deepEqual(sample, { atMs: 1000, processRssBytes: 500, processCpuUsage: { user: 100, system: 50 }, ramFreeBytes: 4000, ramAvailableBytes: 5000, vramFreeBytes: 1200, vramTotalBytes: 2000 });
});

test("ResourceSampler.sample(): a failing hardware-profile read never throws — fields just come back null", async () => {
  const sampler = new ResourceSampler({ getProcessMemoryUsage: () => ({ rss: 1 }), getHardwareProfile: async () => { throw new Error("nope"); } });
  const sample = await sampler.sample();
  assert.equal(sample.ramFreeBytes, null);
  assert.equal(sample.vramFreeBytes, null);
});

test("compareEstimateToActual: computes RSS-delta-vs-estimate and CPU time, all null when the underlying samples are unavailable", () => {
  const estimate = { estimatorVersion: "v1", breakdown: { totalBytes: 1000, modelBytes: 800, kvCacheBytes: 100, computeBufferBytes: 50, overheadBytes: 50 } };
  const pre = { atMs: 0, processRssBytes: 200, processCpuUsage: { user: 0, system: 0 }, ramFreeBytes: 5000, ramAvailableBytes: 5000, vramFreeBytes: 2000, vramTotalBytes: 4000 };
  const post = { atMs: 500, processRssBytes: 1400, processCpuUsage: { user: 200_000, system: 50_000 }, ramFreeBytes: 3800, ramAvailableBytes: 3800, vramFreeBytes: 1500, vramTotalBytes: 4000 };
  const delta = compareEstimateToActual(estimate, pre, post);
  assert.equal(delta.estimatedTotalBytes, 1000);
  assert.equal(delta.actualRssDeltaBytes, 1200);
  assert.equal(delta.actualRamFreeDeltaBytes, 1200);
  assert.equal(delta.actualVramFreeDeltaBytes, 500);
  assert.equal(delta.actualCpuTimeMs, 250); // (250_000us) / 1000
  assert.equal(delta.deltaBytes, 200); // 1200 actual - 1000 estimated
  assert.equal(delta.deltaRatio, 1.2);
  assert.equal(cpuTimeDeltaMs(pre, { ...post, processCpuUsage: null }), null);

  const noneKnown = compareEstimateToActual(estimate, { atMs: 0, processRssBytes: null, processCpuUsage: null, ramFreeBytes: null, ramAvailableBytes: null, vramFreeBytes: null, vramTotalBytes: null }, { atMs: 1, processRssBytes: null, processCpuUsage: null, ramFreeBytes: null, ramAvailableBytes: null, vramFreeBytes: null, vramTotalBytes: null });
  assert.equal(noneKnown.deltaBytes, null);
  assert.equal(noneKnown.deltaRatio, null);
});

// =============================================================================================
// model-residency-manager.ts
// =============================================================================================

test("ModelResidencyManager.ensureLoaded/unload: single mutex serializes load/unload/switch — a switch queued behind an in-flight force-switch waits for it in full, including cancel-and-settle", async () => {
  const cancelGate = deferred();
  const fake = createFakeLocalLlmService({ onForceCancel: () => cancelGate.promise });
  const clock = createManualClock();
  const manager = new ModelResidencyManager({ localLlmService: fake, clock, idleTimeoutMs: 100_000 });

  await manager.ensureLoaded("model-a", basePlan());
  fake.beginGenerating("model-a");
  fake.sequence.length = 0; // only care about what happens from here on

  const switchToB = manager.ensureLoaded("model-b", basePlan(), { force: true });
  const switchToC = manager.ensureLoaded("model-c", basePlan());

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    fake.sequence,
    ["cancel-start:model-b"],
    "the queued switch to model-c must not start until the force-switch to model-b (including its cancel) has fully settled",
  );

  cancelGate.resolve();
  const [summaryB, summaryC] = await Promise.all([switchToB, switchToC]);
  assert.equal(summaryB.modelId, "model-b");
  assert.equal(summaryC.modelId, "model-c");
  assert.deepEqual(
    fake.sequence.map((entry) => entry.split(":")[0]),
    ["cancel-start", "cancel-settled", "load-start", "load-done", "load-start", "load-done"],
  );
  assert.equal(manager.getResidentModel().modelId, "model-c");
  await manager.dispose();
});

test("ModelResidencyManager.ensureLoaded: generate中switchは通常拒否 — a different-model switch without force rejects BUSY and leaves the original resident untouched", async () => {
  const fake = createFakeLocalLlmService();
  const manager = new ModelResidencyManager({ localLlmService: fake, clock: createManualClock(), idleTimeoutMs: 100_000 });
  await manager.ensureLoaded("model-a", basePlan());
  fake.beginGenerating("model-a");

  await assert.rejects(manager.ensureLoaded("model-b", basePlan()), (error) => error.code === "BUSY");
  assert.equal(fake.calls.load.length, 1, "no redundant #45 load() call for a rejected switch");
  assert.equal(manager.getResidentModel().modelId, "model-a");
  await manager.dispose();
});

test("ModelResidencyManager.ensureLoaded: duplicate load coalesce — concurrent calls for the SAME model+plan join one #45 load() call, and a repeat call once resident is a pure no-op", async () => {
  const gate = deferred();
  const fake = createFakeLocalLlmService({ resolveLoad: async (input) => { await gate.promise; return { ok: true, summary: defaultSummary(input) }; } });
  const manager = new ModelResidencyManager({ localLlmService: fake, clock: createManualClock(), idleTimeoutMs: 100_000 });

  const p1 = manager.ensureLoaded("model-a", basePlan());
  const p2 = manager.ensureLoaded("model-a", basePlan());
  await new Promise((resolve) => setImmediate(resolve)); // let the (single) queued mutex operation actually start running
  assert.equal(fake.calls.load.length, 1, "a second identical ensureLoaded call while one is in flight must not trigger a second #45 load()");
  gate.resolve();
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1, s2, "both callers observe the exact same result");

  const s3 = await manager.ensureLoaded("model-a", basePlan());
  assert.equal(fake.calls.load.length, 1, "already resident with the same model+plan: no reload, no new #45 call at all");
  assert.equal(s3, s1);
  await manager.dispose();
});

test("ModelResidencyManager.ensureLoaded: a plan change for the SAME model requires a reload; the same plan again does not", async () => {
  const fake = createFakeLocalLlmService();
  const manager = new ModelResidencyManager({ localLlmService: fake, clock: createManualClock(), idleTimeoutMs: 100_000 });
  await manager.ensureLoaded("model-a", basePlan({ contextSize: 2048 }));
  assert.equal(fake.calls.load.length, 1);

  await manager.ensureLoaded("model-a", basePlan({ contextSize: 2048 }));
  assert.equal(fake.calls.load.length, 1, "identical plan: no reload");

  await manager.ensureLoaded("model-a", basePlan({ contextSize: 4096 }));
  assert.equal(fake.calls.load.length, 2, "different contextSize: reload required");
  assert.equal(fake.calls.load[1].contextSize, 4096);
  await manager.dispose();
});

test("ModelResidencyManager.ensureLoaded: a failed switch away from a resident model must not leave a stale #resident pointer — the original model must genuinely reload, not short-circuit to a cached summary", async () => {
  // Regression test for a bug caught in review: #45's real LocalLlmService.load() unloads
  // whatever is currently resident BEFORE attempting to load the new model, so a load() failure
  // means NOTHING is actually resident afterward — not the model that was resident before the
  // attempt. If the manager's #resident pointer isn't cleared on a load failure, a later
  // ensureLoaded() for that same stale model+plan wrongly short-circuits to a cached summary
  // instead of triggering a real reload, even though the underlying service holds no model at all.
  const fake = createFakeLocalLlmService({
    resolveLoad: async (input) => (input.modelId === "model-b" ? { ok: false, code: "BACKEND_INIT_FAILED", message: "boom" } : { ok: true, summary: defaultSummary(input) }),
  });
  const manager = new ModelResidencyManager({ localLlmService: fake, clock: createManualClock(), idleTimeoutMs: 100_000 });

  await manager.ensureLoaded("model-a", basePlan());
  assert.equal(fake.calls.load.length, 1);
  assert.equal(manager.getResidentModel()?.modelId, "model-a");

  await assert.rejects(manager.ensureLoaded("model-b", basePlan()), (error) => error.code === "BACKEND_INIT_FAILED");
  // The underlying service's own state confirms nothing is actually resident after the failure —
  // this is what makes the manager's stale #resident pointer (before the fix) wrong.
  assert.equal(fake.getState().status, "error");

  const summary = await manager.ensureLoaded("model-a", basePlan());
  assert.equal(
    fake.calls.load.length,
    3,
    "ensureLoaded for the previously-resident model+plan must trigger a REAL reload (model-a, model-b, model-a again) — a stale #resident pointer would wrongly stop at 2 and return a cached summary instead",
  );
  assert.equal(summary.modelId, "model-a");
  assert.equal(manager.getResidentModel()?.modelId, "model-a");
  await manager.dispose();
});

test("ModelResidencyManager: idle countdown fires unload after the timeout, a manual cancel postpones it, and a later ensureLoaded reloads normally", async () => {
  const fake = createFakeLocalLlmService();
  const clock = createManualClock();
  const events = [];
  const manager = new ModelResidencyManager({ localLlmService: fake, clock, idleTimeoutMs: 1000, onIdleEvent: (event) => events.push(event) });

  await manager.ensureLoaded("model-a", basePlan());
  assert.equal(manager.getResidentModel().modelId, "model-a");

  clock.advance(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getResidentModel(), null, "idle unload must have fired");
  assert.equal(fake.calls.unload.length, 1);
  assert.ok(events.some((event) => event.type === "fired"));

  await manager.ensureLoaded("model-a", basePlan());
  assert.equal(fake.calls.load.length, 2, "reloading after an idle-unload issues a fresh #45 load()");

  manager.cancelIdleCountdown();
  clock.advance(100_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getResidentModel().modelId, "model-a", "a manually cancelled countdown never fires");
});

test("ModelResidencyManager: idle unload never fires while a generation is active or a request is pending, regardless of touch()", async () => {
  const fake = createFakeLocalLlmService();
  const clock = createManualClock();
  const manager = new ModelResidencyManager({ localLlmService: fake, clock, idleTimeoutMs: 1000 });
  await manager.ensureLoaded("model-a", basePlan());

  fake.beginGenerating("model-a");
  clock.advance(10_000); // far past the timeout — must never fire while generating
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getResidentModel().modelId, "model-a");
  assert.equal(fake.calls.unload.length, 0);

  fake.endGenerating();
  fake.setPendingGenerationCount(1); // nothing "generating" right now, but a request is queued
  clock.advance(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getResidentModel().modelId, "model-a", "a non-empty pending queue must also suppress idle unload");
  assert.equal(fake.calls.unload.length, 0);

  fake.setPendingGenerationCount(0);
  clock.advance(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getResidentModel(), null, "once genuinely idle, unload proceeds");
});

// -- OOM fallback: uses the REAL #78 planRuntime() to produce a genuine alternative plan --------

function oomFixtureModel() {
  return {
    modelId: "big-model",
    displayName: "Big Model",
    sizeBytes: 2 * 1024 ** 3,
    trainContextSize: 8192,
    blockCount: 32,
    embeddingLength: 4096,
    attentionHeadCount: 32,
    attentionHeadCountKv: 8,
  };
}

function oomFixtureHardware() {
  return {
    cpu: { cores: 4 },
    ram: { totalBytes: 4 * 1024 ** 3, freeBytes: 3 * 1024 ** 3, availableBytes: 3 * 1024 ** 3 },
    gpu: { backend: null, memory: { status: "unknown" } },
    detectedAtMs: 0,
    source: "detected",
  };
}

test("ModelResidencyManager: an 8192-context plan really is 'unsupported' per #78's real estimator on this fixture, and 2048 is really 'possible' (sanity check for the test fixture itself)", () => {
  const bigPlan = planRuntime({ model: oomFixtureModel(), hardware: oomFixtureHardware(), overrides: { contextSize: 8192 } });
  assert.equal(bigPlan.verdict, "unsupported");
  assert.ok(bigPlan.alternatives.some((alt) => alt.kind === "reduce-context" && alt.contextSize === 2048));
  const smallPlan = planRuntime({ model: oomFixtureModel(), hardware: oomFixtureHardware(), overrides: { contextSize: 2048 } });
  assert.equal(smallPlan.verdict, "possible");
});

test("ModelResidencyManager.ensureLoaded: OOM re-consults #78's real planner for a reduced-context fallback plan and recovers; the original plan stays remembered/suppressed", async () => {
  const fake = createFakeLocalLlmService({
    resolveLoad: async (input) => (input.contextSize === 8192 ? { ok: false, code: "OUT_OF_MEMORY", message: "insufficient memory", retryable: true } : { ok: true, summary: defaultSummary(input) }),
  });
  const model = oomFixtureModel();
  const hardware = oomFixtureHardware();
  const resolveFallbackPlan = ({ failedPlan }) => {
    const plan = planRuntime({ model, hardware, overrides: { contextSize: failedPlan.contextSize } });
    const alt = plan.alternatives.find((a) => a.kind === "reduce-context");
    if (!alt) return null;
    return { backend: plan.backend, contextSize: alt.contextSize, gpuLayers: plan.gpuLayers, batchSize: Math.min(plan.batchSize, alt.contextSize), threads: plan.threads };
  };
  const manager = new ModelResidencyManager({ localLlmService: fake, clock: createManualClock(), idleTimeoutMs: 100_000, resolveFallbackPlan });

  const failingPlan = basePlan({ contextSize: 8192 });
  const summary = await manager.ensureLoaded("big-model", failingPlan);
  assert.equal(summary.contextSize, 2048, "recovered via the real planner's reduce-context alternative");
  assert.deepEqual(
    fake.calls.load.map((call) => call.contextSize),
    [8192, 2048],
  );

  const remembered = manager.getFailureHistorySnapshot().find((entry) => entry.planKey === planKey(failingPlan));
  assert.ok(remembered, "the original 8192 plan's OOM must still be remembered even though a fallback recovered");
  assert.equal(remembered.code, "OUT_OF_MEMORY");

  await assert.rejects(manager.ensureLoaded("big-model", failingPlan), (error) => error.code === "OUT_OF_MEMORY" && /remembered/.test(error.message));
  assert.equal(fake.calls.load.length, 2, "retrying the exact same failing plan must not call #45 load() again");
  await manager.dispose();
});

test("ModelResidencyManager.ensureLoaded: without a fallback resolver, a repeat of the same failing plan is suppressed immediately (no infinite retry)", async () => {
  const fake = createFakeLocalLlmService({ resolveLoad: async () => ({ ok: false, code: "BACKEND_INIT_FAILED", message: "backend blew up", retryable: false }) });
  const manager = new ModelResidencyManager({ localLlmService: fake, clock: createManualClock(), idleTimeoutMs: 100_000 });
  const plan = basePlan();

  await assert.rejects(manager.ensureLoaded("model-a", plan), (error) => error.code === "BACKEND_INIT_FAILED");
  await assert.rejects(manager.ensureLoaded("model-a", plan), (error) => error.code === "BACKEND_INIT_FAILED" && /remembered/.test(error.message));
  await assert.rejects(manager.ensureLoaded("model-a", plan), (error) => /remembered/.test(error.message));
  assert.equal(fake.calls.load.length, 1, "every repeat after the first must be suppressed without calling #45 again");

  await assert.rejects(manager.ensureLoaded("model-a", plan, { ignoreFailureHistory: true }), (error) => error.code === "BACKEND_INIT_FAILED");
  assert.equal(fake.calls.load.length, 2, "ignoreFailureHistory is the explicit manual retry-anyway seam");
  await manager.dispose();
});

test("ModelResidencyManager: resource-sampler + estimate diagnostic — records a real pre/post delta against a supplied FitEstimate", async () => {
  const samples = [
    { atMs: 0, processRssBytes: 1000, processCpuUsage: null, ramFreeBytes: null, ramAvailableBytes: null, vramFreeBytes: null, vramTotalBytes: null },
    { atMs: 10, processRssBytes: 2500, processCpuUsage: null, ramFreeBytes: null, ramAvailableBytes: null, vramFreeBytes: null, vramTotalBytes: null },
  ];
  let callIndex = 0;
  const resourceSampler = { sample: async () => samples[callIndex++] };
  const fake = createFakeLocalLlmService();
  const manager = new ModelResidencyManager({ localLlmService: fake, clock: createManualClock(), idleTimeoutMs: 100_000, resourceSampler });

  const estimate = { estimatorVersion: "local-llm-fit-estimator@1", breakdown: { totalBytes: 1200, modelBytes: 1000, kvCacheBytes: 100, computeBufferBytes: 50, overheadBytes: 50 } };
  await manager.ensureLoaded("model-a", basePlan(), { estimate });
  const diagnostic = manager.getLastDiagnostic();
  assert.equal(diagnostic.estimatedTotalBytes, 1200);
  assert.equal(diagnostic.actualRssDeltaBytes, 1500);
  assert.equal(diagnostic.deltaBytes, 300);
  await manager.dispose();
});

test("ModelResidencyManager: health.report() reflects checking/healthy/degraded transitions, and getHealthSnapshot() exposes current model/backend/plan", async () => {
  const events = [];
  const health = { report: (event) => events.push(event) };
  const fake = createFakeLocalLlmService({ resolveLoad: async (input) => (input.modelId === "bad-model" ? { ok: false, code: "OUT_OF_MEMORY", message: "oom", retryable: true } : { ok: true, summary: defaultSummary(input) }) });
  const manager = new ModelResidencyManager({ localLlmService: fake, clock: createManualClock(), idleTimeoutMs: 100_000, health, serviceId: "local-llm-residency" });

  await manager.ensureLoaded("model-a", basePlan());
  assert.deepEqual(events.map((event) => event.status), ["checking", "healthy"]);
  assert.ok(events.every((event) => event.serviceId === "local-llm-residency"));

  const snapshot = manager.getHealthSnapshot();
  assert.equal(snapshot.status, "healthy");
  assert.equal(snapshot.modelId, "model-a");
  assert.equal(snapshot.backend, "cpu");

  await assert.rejects(manager.ensureLoaded("bad-model", basePlan()));
  assert.deepEqual(
    events.map((event) => event.status),
    ["checking", "healthy", "checking", "degraded"],
  );
  assert.equal(events.at(-1).error.retryable, true);
  await manager.dispose();
});

test("ModelResidencyManager: onSuspend()/onResume() — suspended time never counts as idle, and resuming with a resident model re-arms the countdown", async () => {
  const fake = createFakeLocalLlmService();
  const clock = createManualClock();
  const manager = new ModelResidencyManager({ localLlmService: fake, clock, idleTimeoutMs: 1000 });
  await manager.ensureLoaded("model-a", basePlan());

  clock.advance(500);
  manager.onSuspend();
  clock.advance(1_000_000); // long sleep
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getResidentModel().modelId, "model-a", "suspended time must never trigger idle unload");

  manager.onResume();
  clock.advance(999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getResidentModel().modelId, "model-a");
  clock.advance(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getResidentModel(), null, "resume() restarts a fresh countdown, which fires normally afterward");
});

test("ModelResidencyManager.dispose(): app quit while a load is in flight interrupts it (via #45's own dispose(), not a race) instead of deadlocking, and blocks further loads", async () => {
  const gate = deferred();
  const fake = createFakeLocalLlmService({ resolveLoad: async (input) => { await gate.promise; return { ok: true, summary: defaultSummary(input) }; } });
  const manager = new ModelResidencyManager({ localLlmService: fake, clock: createManualClock(), idleTimeoutMs: 100_000 });

  const loadPromise = manager.ensureLoaded("model-a", basePlan());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.load.length, 1);

  let disposeSettled = false;
  const disposePromise = manager.dispose().then(() => {
    disposeSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposeSettled, false, "dispose() must wait for the in-flight operation to actually settle, not resolve out from under it");
  assert.equal(fake.isDisposed, true, "but the underlying #45 service is disposed immediately, so a slow native load gets interrupted rather than blocking app quit");

  gate.resolve();
  await assert.rejects(loadPromise, (error) => error.code === "NATIVE_UNAVAILABLE");
  await disposePromise;
  assert.equal(disposeSettled, true);

  await assert.rejects(manager.ensureLoaded("model-a", basePlan()), (error) => error.code === "NATIVE_UNAVAILABLE");
  assert.equal(fake.calls.load.length, 1, "no new load() call is ever attempted after dispose()");
});

// =============================================================================================
// Stability
// =============================================================================================

test("Stability: switching between models 10 times never leaks timers, and failure/diagnostic bookkeeping stays bounded (no per-switch growth)", async () => {
  const fake = createFakeLocalLlmService();
  const clock = createManualClock();
  let armedEvents = 0;
  const manager = new ModelResidencyManager({ localLlmService: fake, clock, idleTimeoutMs: 1000, onIdleEvent: (event) => { if (event.type === "armed") armedEvents += 1; } });

  let maxPendingTimers = 0;
  for (let i = 0; i < 10; i += 1) {
    const modelId = i % 2 === 0 ? "model-a" : "model-b";
    await manager.ensureLoaded(modelId, basePlan({ contextSize: 2048 + (i % 2) }));
    maxPendingTimers = Math.max(maxPendingTimers, clock.pendingCount());
    assert.ok(clock.pendingCount() <= 1, `iteration ${i}: at most one idle timer must ever be pending, saw ${clock.pendingCount()}`);
    assert.equal(manager.getFailureHistorySnapshot().length, 0, "no failures in this success-only loop");
  }

  assert.equal(maxPendingTimers, 1);
  assert.equal(armedEvents, 10, "exactly one 'armed' event per switch — no duplicate listeners/controllers accumulating");
  assert.equal(fake.calls.load.length, 10);
  assert.equal(manager.getResidentModel().modelId, "model-b");

  // Final idle-unload must still work correctly after 10 switches — the single idle controller
  // instance is still wired up correctly, not orphaned by an earlier switch.
  clock.advance(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getResidentModel(), null);
  assert.equal(clock.pendingCount(), 0, "no dangling timer left behind after the final unload");
});
