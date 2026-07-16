import assert from "node:assert/strict";
import test from "node:test";
import { NewsPipelineCoordinator, createNewsPipelineCoordinator } from "../../src/news/news-pipeline-coordinator.js";
import { createSelectStage } from "../../src/news/stages/select-stage.js";
import { createResearchStage } from "../../src/news/stages/research-stage.js";
import { resolveModePolicy } from "../../src/news/mode-policy.js";
import { canTransition, assertTransition, isTerminalState } from "../../src/news/news-pipeline-state.js";
import { normalizeStageError } from "../../src/news/contracts.js";
import { MemoryItemProcessingStore } from "../../src/readers/item-processing-store.js";
import { RequestCancelledError, isCancellation } from "../../src/runtime/request-registry.js";

const defaultPersona = { id: "p", name: "P", connector: "mock", enabled: true, voice: {} };

function baseConfig(overrides = {}) {
  return { news: { enabled: true, maxItems: 3, retry: { maxAttempts: 3, initialDelaySeconds: 30, maxDelaySeconds: 900 }, ...overrides } };
}

// Builds a NewsPipelineCoordinator whose six stages are recording stubs (default behavior:
// acquire returns [], select runs the real select-stage against `store`, everything else
// trivially succeeds), so each test only needs to override the stage(s) it cares about.
function makeHarness({ config = baseConfig(), store = new MemoryItemProcessingStore({ clock: () => 1000 }), clock = () => 1000, persona = defaultPersona, connector = { chat: async () => ({ text: "ok" }) }, canDeliver = () => true, impls = {}, maxRewrites = 1, log = () => {}, onRead = () => {} } = {}) {
  const calls = [];
  const realSelect = createSelectStage({ store, clock });
  const wrap = (id, impl) => ({ id, run: async (input, context) => { calls.push(id); return impl(input, context); } });
  const stages = {
    acquire: wrap("acquire", impls.acquire ?? (async () => [])),
    select: wrap("select", impls.select ?? ((input, context) => realSelect.run(input, context))),
    research: wrap("research", impls.research ?? (async () => null)),
    generate: wrap("generate", impls.generate ?? (async () => ({ text: "generated", debugText: "debug" }))),
    quality: wrap("quality", impls.quality ?? (async () => ({ passed: true, reasons: [] }))),
    deliver: wrap("deliver", impls.deliver ?? (async () => ({ queued: { state: "waiting" } }))),
  };
  const adapter = { resolvePersona: () => persona, resolveConnector: () => connector, canDeliver };
  const coordinator = new NewsPipelineCoordinator({ getConfig: () => config, adapter, stages, store, clock, log, onRead, maxRewrites });
  return { coordinator, calls, store };
}

test("NewsPipelineCoordinator runs stages in acquire -> select -> research -> generate -> quality -> deliver order", async () => {
  const item = { guid: "g1", title: "t1", processingKey: "news:g1", sourceName: "s" };
  const { coordinator, calls } = makeHarness({ impls: { acquire: async () => [item] } });
  const result = await coordinator.run({ generation: 1 });
  assert.equal(result.status, "delivered");
  assert.deepEqual(calls, ["acquire", "select", "research", "generate", "quality", "deliver"]);
});

test("NewsPipelineCoordinator short-circuits with no_candidate when nothing is eligible", async () => {
  const { coordinator, calls } = makeHarness();
  const result = await coordinator.run({ generation: 1 });
  assert.equal(result.status, "no_candidate");
  assert.deepEqual(calls, ["acquire", "select"]);
});

test("quality failure triggers exactly one rewrite before delivering", async () => {
  const item = { guid: "g1", title: "t1", processingKey: "news:g1", sourceName: "s" };
  let generateCalls = 0;
  let qualityCalls = 0;
  const { coordinator, store } = makeHarness({
    impls: {
      acquire: async () => [item],
      generate: async () => { generateCalls++; return { text: `draft-${generateCalls}`, debugText: "d" }; },
      quality: async () => { qualityCalls++; return { passed: qualityCalls > 1, reasons: qualityCalls > 1 ? [] : ["too short"] }; },
    },
  });
  const result = await coordinator.run({ generation: 1 });
  assert.equal(result.status, "delivered");
  assert.equal(generateCalls, 2, "rewrite must re-run generate");
  assert.equal(qualityCalls, 2, "rewrite must re-check quality");
  assert.equal(result.diagnostics.rewriteCount, 1);
  assert.equal(store.get(item.processingKey).state, "read");
});

test("exhausting the rewrite budget marks the item failed instead of delivering", async () => {
  const item = { guid: "g1", title: "t1", processingKey: "news:g1", sourceName: "s" };
  let deliverCalls = 0;
  const { coordinator, store } = makeHarness({
    impls: {
      acquire: async () => [item],
      quality: async () => ({ passed: false, reasons: ["always fails"] }),
      deliver: async () => { deliverCalls++; return { queued: { state: "waiting" } }; },
    },
    maxRewrites: 1,
  });
  await coordinator.run({ generation: 1 });
  assert.equal(deliverCalls, 0, "deliver stage must never run once quality never passes");
  assert.equal(store.get(item.processingKey).state, "failed_permanent");
});

test("a throwing deliver stage leaves the item unread/retryable instead of committing", async () => {
  const item = { guid: "g1", title: "t1", processingKey: "news:g1", sourceName: "s" };
  const { coordinator, store } = makeHarness({
    impls: {
      acquire: async () => [item],
      deliver: async () => { throw Object.assign(new Error("queue unavailable"), { kind: "server" }); },
    },
  });
  await coordinator.run({ generation: 1 });
  assert.equal(store.get(item.processingKey).state, "retry_wait");
});

test("a failing candidate does not block later candidates in the same run", async () => {
  const itemA = { guid: "a", title: "a", processingKey: "news:a", sourceName: "s" };
  const itemB = { guid: "b", title: "b", processingKey: "news:b", sourceName: "s" };
  const { coordinator, store } = makeHarness({
    impls: {
      acquire: async () => [itemA, itemB],
      generate: async ({ item }) => {
        if (item.processingKey === "news:a") throw Object.assign(new Error("boom"), { kind: "server" });
        return { text: "ok", debugText: "d" };
      },
    },
  });
  await coordinator.run({ generation: 1 });
  assert.equal(store.get("news:a").state, "retry_wait");
  assert.equal(store.get("news:b").state, "read");
});

test("cancellation at any stage rejects the run and never marks the in-flight item read", async () => {
  const item = { guid: "g1", title: "t1", processingKey: "news:g1", sourceName: "s" };
  for (const stageId of ["acquire", "select", "research", "generate", "quality", "deliver"]) {
    const store = new MemoryItemProcessingStore({ clock: () => 1000 });
    const realSelect = createSelectStage({ store, clock: () => 1000 });
    const impls = {
      acquire: async () => { if (stageId === "acquire") throw new RequestCancelledError(); return [item]; },
      select: async (input, context) => { if (stageId === "select") throw new RequestCancelledError(); return realSelect.run(input, context); },
      research: async () => { if (stageId === "research") throw new RequestCancelledError(); return null; },
      generate: async () => { if (stageId === "generate") throw new RequestCancelledError(); return { text: "t", debugText: "d" }; },
      quality: async () => { if (stageId === "quality") throw new RequestCancelledError(); return { passed: true, reasons: [] }; },
      deliver: async () => { if (stageId === "deliver") throw new RequestCancelledError(); return { queued: { state: "waiting" } }; },
    };
    const { coordinator } = makeHarness({ store, impls });
    await assert.rejects(coordinator.run({ generation: 1 }), isCancellation, `${stageId} cancellation must reject run()`);
    if (stageId !== "acquire" && stageId !== "select") {
      assert.equal(store.get(item.processingKey)?.state, "unread", `${stageId} cancellation must reset the item back to unread`);
    }
  }
});

test("a stale generation prevents commit even after delivery succeeds", async () => {
  const item = { guid: "g1", title: "t1", processingKey: "news:g1", sourceName: "s" };
  let current = true;
  const { coordinator, store } = makeHarness({
    impls: {
      acquire: async () => [item],
      deliver: async () => { current = false; return { queued: { state: "waiting" } }; },
    },
  });
  await assert.rejects(coordinator.run({ generation: 1, isCurrent: () => current }), isCancellation);
  assert.equal(store.get(item.processingKey)?.state, "unread");
});

test("a coordinator instance skips a concurrent run against itself while one is in flight", async () => {
  let resolveGenerate;
  const pending = new Promise((resolve) => { resolveGenerate = resolve; });
  const item = { guid: "g1", title: "t1", processingKey: "news:g1", sourceName: "s" };
  const { coordinator } = makeHarness({
    impls: {
      acquire: async () => [item],
      generate: async () => { await pending; return { text: "t", debugText: "d" }; },
    },
  });
  const first = coordinator.run({ generation: 1 });
  const second = await coordinator.run({ generation: 1 });
  assert.equal(second.status, "skipped");
  resolveGenerate();
  assert.equal((await first).status, "delivered");
});

test("normalizeStageError maps connector-style kinds and passes cancellation through unchanged", () => {
  const cancelled = new RequestCancelledError();
  assert.equal(normalizeStageError(cancelled, "generate"), cancelled);
  const fromKind = normalizeStageError(Object.assign(new Error("rate limited"), { kind: "rate_limit" }), "generate");
  assert.equal(fromKind.kind, "rate_limit");
  assert.equal(fromKind.retryable, true);
  assert.equal(fromKind.stage, "generate");
  const fromCode = normalizeStageError(Object.assign(new Error("boom"), { code: "UNKNOWN" }), "deliver");
  assert.equal(fromCode.kind, "unknown");
  assert.equal(fromCode.retryable, false);
});

test("resolveModePolicy returns the documented defaults per mode and falls back to topic", () => {
  assert.deepEqual(resolveModePolicy("topic"), { mode: "topic", research: "article", targetChars: { min: 200, max: 500 }, allowOpinion: true, requireMultipleViewpoints: false, qualityProfile: "brief" });
  assert.equal(resolveModePolicy("current").research, "multi_source");
  assert.equal(resolveModePolicy("current").requireMultipleViewpoints, true);
  assert.equal(resolveModePolicy("simple").allowOpinion, false);
  assert.deepEqual(resolveModePolicy("unknown"), resolveModePolicy("topic"));
});

test("resolveModePolicy merges targetChars overrides without dropping the other fields", () => {
  const policy = resolveModePolicy("current", { targetChars: { max: 2000 } });
  assert.deepEqual(policy.targetChars, { min: 800, max: 2000 });
  assert.equal(policy.qualityProfile, "grounded");
});

test("research stage is a no-op in Phase 1 regardless of mode policy", async () => {
  const stage = createResearchStage();
  assert.equal(stage.id, "research");
  assert.equal(await stage.run({ modePolicy: resolveModePolicy("current") }, {}), null);
  assert.equal(await stage.run({ modePolicy: resolveModePolicy("topic") }, {}), null);
});

test("news pipeline state graph allows the documented edges and rejects invalid ones", () => {
  assert.equal(canTransition("idle", "acquiring"), true);
  assert.equal(canTransition("selecting", "no_candidate"), true);
  assert.equal(canTransition("validating", "rewriting"), true);
  assert.equal(canTransition("rewriting", "validating"), true);
  assert.equal(canTransition("committed", "acquiring"), false);
  assert.throws(() => assertTransition("idle", "committed"), /invalid news pipeline transition/);
  assert.equal(isTerminalState("committed"), true);
  assert.equal(isTerminalState("acquiring"), false);
});

test("createNewsPipelineCoordinator wires the legacy adapter end-to-end for mock news", async () => {
  const config = { news: { enabled: true, maxItems: 3, sources: [{ type: "mock", name: "mock" }] } };
  const persona = { id: "p", name: "P", connector: "mock", enabled: true, voice: {} };
  const spoken = [];
  const coordinator = createNewsPipelineCoordinator({
    getConfig: () => config,
    getConnector: () => ({ chat: async () => ({ text: "ok" }) }),
    personaRouter: { get: () => persona, defaultPersona: () => persona },
    contextBuilder: { build: () => ({ messages: [{ role: "user", content: "news" }], debugText: "debug" }) },
    speechQueue: { enqueue: (item) => { spoken.push(item); return { state: "waiting" }; } },
  });
  const result = await coordinator.run({ generation: 1 });
  assert.equal(result.status, "delivered");
  assert.equal(spoken.length, 3, "mock news minus the duplicate title must all be delivered");
  assert.equal(coordinator.status().counts.read, 3);
});
