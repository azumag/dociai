import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeFactory, personaColorFor, selectPlatformAdapter, createDociaiRuntimeFactory } from "../../src/app/runtime-factory.js";
import { AppRuntime } from "../../src/app/app-runtime.js";
import { CommentStore } from "../../src/comment-store.js";
import { ManualCommentSource } from "../../src/comment-sources.js";
import { BrowserRuntimeController } from "../../src/runtime/runtime-controller.js";
import { processConfig } from "../../src/config/config-pipeline.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/stream-events/contract.js";

test("RuntimeFactory.createCandidate rejects a non-integer generation and duplicate component names", async () => {
  const factory = new RuntimeFactory(({ define }) => { define("x", () => ({})); define("x", () => ({})); });
  await assert.rejects(() => factory.createCandidate({ config: {}, generation: 1, deps: {} }), /Duplicate runtime component: x/);
  await assert.rejects(() => new RuntimeFactory(() => {}).createCandidate({ config: {}, generation: 1.5, deps: {} }), /integer generation/);
});

test("RuntimeFactory never invokes start() while building a candidate", async () => {
  let started = false;
  const factory = new RuntimeFactory(({ define }) => {
    define("x", () => ({}), () => ({ start: () => { started = true; } }));
  });
  await factory.createCandidate({ config: {}, generation: 1, deps: {} });
  assert.equal(started, false);
});

test("personaColorFor is deterministic per persona index and neutral for unknown ids", () => {
  const config = { personas: [{ id: "a" }, { id: "b" }] };
  assert.equal(personaColorFor(config, "a"), personaColorFor(config, "a"));
  assert.notEqual(personaColorFor(config, "a"), personaColorFor(config, "b"));
  assert.equal(personaColorFor(config, "missing"), "hsl(0 0% 70%)");
  assert.equal(personaColorFor(null, "a"), "hsl(0 0% 70%)");
});

test("selectPlatformAdapter swaps between Browser and Electron implementations based on the injected global scope", () => {
  const browser = selectPlatformAdapter({});
  assert.equal(browser.kind, "browser");
  assert.equal(browser.hasTwitchService(), false);
  assert.equal(browser.hasCaptureService(), false);
  const browserTwitchSource = browser.createTwitchSource({ channels: ["a"] }, { onStatus: () => {} });
  assert.equal(browserTwitchSource.constructor.name, "TwitchChatSource");

  const electronScope = { dociai: { obs: {}, twitch: { start: () => {} }, capture: { listSources: () => {} } } };
  const electron = selectPlatformAdapter(electronScope);
  assert.equal(electron.kind, "electron");
  assert.equal(electron.hasTwitchService(), true);
  assert.equal(electron.hasCaptureService(), true);
  const electronTwitchSource = electron.createTwitchSource({ channels: ["a"] }, { onStatus: () => {} });
  assert.equal(electronTwitchSource.constructor.name, "ElectronTwitchSource");

  // Electron obs transport present but the twitch bridge / capture bridge missing: falls back
  // per-service, exactly like app.js's original hasElectronTwitchService() guard did.
  const partialScope = { dociai: { obs: {} } };
  const partial = selectPlatformAdapter(partialScope);
  assert.equal(partial.kind, "electron");
  assert.equal(partial.hasTwitchService(), false);
  assert.equal(partial.hasCaptureService(), false);
  assert.equal(partial.createTwitchSource({}, {}).constructor.name, "TwitchChatSource");
});

function fakeDeps(overrides = {}) {
  const calls = { onSecrets: [], dispatch: [], log: [] };
  return {
    calls,
    deps: {
      runtimeController: new BrowserRuntimeController(),
      commentStore: new CommentStore({ limit: 10 }),
      manualSource: new ManualCommentSource(),
      platform: selectPlatformAdapter({}),
      log: (message, level) => calls.log.push({ message, level }),
      broadcast: () => {},
      dispatch: (action) => calls.dispatch.push(action),
      onSecrets: (secrets) => calls.onSecrets.push(secrets),
      onPersonaChange: () => {},
      onSpeechUpdate: () => {},
      onScreenChange: () => {},
      onMicChange: () => {},
      onResponseError: () => {},
      onAutomationError: () => {},
      onAutomationComplete: () => {},
      onNewsRead: () => {},
      onTopicRead: () => {},
      onSourceStatus: () => {},
      onSourceError: () => {},
      ...overrides,
    },
  };
}

function minimalConfig(extra = {}) {
  return processConfig({
    connectors: { mock: { provider: "mock", delayMs: 0 } },
    personas: [{ id: "p1", name: "P1", connector: "mock", triggers: ["hi"] }],
    triggers: { hi: { type: "keyword", keywords: ["hi"] }, newsTrigger: { type: "keyword", keywords: ["news"] } },
    ...extra,
  }).config;
}

test("buildDociaiRuntime wires a candidate bundle in dependency order without starting anything", async () => {
  const config = minimalConfig({ news: { enabled: true, trigger: "newsTrigger", sources: [] } });
  const { deps, calls } = fakeDeps();
  const bundle = await createDociaiRuntimeFactory().createCandidate({ config, generation: 1, deps });

  assert.deepEqual(bundle.names(), [
    "connectors", "personaRouter", "speechQueue", "contextBuilder",
    "responseCoordinator", "eventTriggerRunner", "automationCoordinator", "newsReader", "topicReader",
    "triggerEngine", "sourceCoordinator",
  ]);
  assert.equal(calls.onSecrets.length, 1);
  assert.equal(bundle.get("connectors").size, 1);
  assert.equal(bundle.get("screenContext"), null);
  assert.equal(bundle.get("micMonitor"), null);
  assert.equal(bundle.get("sourceCoordinator").sources.size, 0, "sourceCoordinator.replace() must only run on start(), not create");

  const automationCoordinator = bundle.get("automationCoordinator");
  const newsReader = bundle.get("newsReader");
  const runCalls = [];
  automationCoordinator.run = (kind, reader) => { runCalls.push([kind, reader === newsReader]); return Promise.resolve(); };

  const handleTrigger = bundle.get("handleTrigger");
  assert.deepEqual(handleTrigger("newsTrigger"), []);
  assert.deepEqual(runCalls, [["news", true]]);
});

test("starting a candidate bundle activates the trigger engine and comment sources", async () => {
  // TriggerEngine.start() always binds a "keydown" listener, even with no hotkey triggers
  // configured — same window shim scripts/test/electron-shortcut.test.mjs uses.
  const originalWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const config = minimalConfig();
    const { deps } = fakeDeps();
    const bundle = await createDociaiRuntimeFactory().createCandidate({ config, generation: 1, deps });

    for (const component of bundle.components) {
      if (component.start) await component.start();
    }

    const sourceCoordinator = bundle.get("sourceCoordinator");
    assert.equal(sourceCoordinator.sources.size, 1);
    assert.ok(sourceCoordinator.sources.has("manual"));

    for (const component of [...bundle.components].reverse()) {
      if (component.stop) await component.stop();
      if (component.dispose) await component.dispose();
    }
    assert.equal(sourceCoordinator.sources.size, 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  }
});

// -------------------------------------------------------------------------------------------
// Issue #177: eventTriggerRunner — the production EventSub-notification -> StreamEvent ->
// Trigger -> ActionRunner wiring.
// -------------------------------------------------------------------------------------------

let cheerSeq = 0;
function cheerPublished(overrides = {}) {
  cheerSeq += 1;
  return {
    context: "production",
    publishedAtMs: Date.now(),
    event: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: `evt-cheer-${cheerSeq}`,
      kind: "cheer",
      timestamp: new Date().toISOString(),
      actor: { id: "user-1", displayName: "Viewer", isAnonymous: false },
      channel: { id: "channel-1", displayName: "Channel" },
      sourceMetadata: { connectionId: "conn-1" },
      data: { bits: 100, message: "cheer!" },
      ...overrides,
    },
  };
}

/** A fake `platform.subscribeStreamEvents` that records every listener registered and every
 * unsubscribe call — lets a test both drive a fake production push AND assert the subscription is
 * torn down on dispose(). */
function fakeStreamEventsPlatform() {
  const listeners = [];
  const unsubscribed = [];
  return {
    listeners,
    unsubscribed,
    publish(published) { for (const listener of listeners) listener(published); },
    adapter: {
      ...selectPlatformAdapter({}),
      hasStreamEventsService: () => true,
      subscribeStreamEvents: (listener) => { listeners.push(listener); return () => unsubscribed.push(listener); },
    },
  };
}

/** starting/stopping a full candidate bundle also starts/stops triggerEngine, which always binds a
 * "keydown" window listener regardless of configured hotkeys — same shim the "starting a candidate
 * bundle..." test above uses. Runs `fn()` with the shim installed, always restoring afterward. */
async function withWindowShim(fn) {
  const originalWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    await fn();
  } finally {
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  }
}

test("eventTriggerRunner: does not subscribe when the platform has no StreamEvents bridge (Browser mode), and appears as a real component regardless", async () => withWindowShim(async () => {
  const config = minimalConfig();
  const { deps } = fakeDeps();
  const bundle = await createDociaiRuntimeFactory().createCandidate({ config, generation: 1, deps });
  const runner = bundle.get("eventTriggerRunner");
  assert.ok(runner);
  assert.equal(typeof runner.actionRunner.execute, "function");
  for (const component of bundle.components) if (component.start) await component.start();
  assert.equal(runner.status().subscribed, false);
  for (const component of [...bundle.components].reverse()) { if (component.stop) await component.stop(); if (component.dispose) await component.dispose(); }
}));

test("eventTriggerRunner: a matched production StreamEvent runs the REAL matcher/planner/cooldown/ActionRunner chain — the real SpeechQueue/OBS broadcast are invoked, and the result is reported via deps.onEventTriggerResult", async () => withWindowShim(async () => {
  const config = minimalConfig({
    eventTriggers: {
      "cheer-rule": { id: "cheer-rule", enabled: true, eventTypes: ["cheer"], priority: 0, stopPropagation: false, condition: { all: [] }, actions: [{ id: "a1", kind: "template-speech", template: "ありがとうございます!" }] },
    },
  });
  const fakePlatform = fakeStreamEventsPlatform();
  const obsCalls = [];
  const resultCalls = [];
  const { deps } = fakeDeps({
    platform: fakePlatform.adapter,
    broadcast: (type, payload) => obsCalls.push({ type, payload }),
    onEventTriggerResult: (published, result) => resultCalls.push({ published, result }),
  });
  // isCurrent(1) must actually be true for generation 1 — outside of AppRuntime (which calls this
  // itself inside #applyConfig before creating a candidate), a direct createCandidate() call must
  // bump the SAME runtimeController's generation counter itself, or eventTriggerRunner's own
  // isCurrent() guard silently (and correctly) discards every event as belonging to a stale
  // generation 0.
  deps.runtimeController.generations.next("test");
  const bundle = await createDociaiRuntimeFactory().createCandidate({ config, generation: 1, deps });
  for (const component of bundle.components) if (component.start) await component.start();

  const runner = bundle.get("eventTriggerRunner");
  assert.equal(runner.status().subscribed, true);
  assert.equal(fakePlatform.listeners.length, 1);

  const published = cheerPublished();
  fakePlatform.publish(published);
  // handle() is fire-and-forget from the subscription callback's perspective — wait for the async
  // pipeline (matchEvent -> planActions -> ActionRunner.execute) to actually report its result.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(resultCalls.length, 1);
  assert.equal(resultCalls[0].result.ok, true);
  assert.equal(resultCalls[0].result.context, "production");
  assert.equal(resultCalls[0].result.matches.length, 1);
  assert.equal(resultCalls[0].result.results.length, 1);
  assert.equal(resultCalls[0].result.results[0].status, "executed");
  assert.equal(obsCalls.length, 1, "the REAL OBS broadcast (deps.broadcast) must be called for a real production execution");
  assert.equal(obsCalls[0].payload.context, "production");

  for (const component of [...bundle.components].reverse()) { if (component.stop) await component.stop(); if (component.dispose) await component.dispose(); }
  assert.equal(fakePlatform.unsubscribed.length, 1, "dispose() must unsubscribe from the StreamEvents push");
}));

test("eventTriggerRunner: config reload discards the OLD generation's subscription — a StreamEvent published on the stale (unsubscribed) listener never reaches the new generation's ActionRunner, and the old ActionRunner itself rejects a stale-generation plan", async () => withWindowShim(async () => {
  const config1 = minimalConfig({
    eventTriggers: {
      "cheer-rule": { id: "cheer-rule", enabled: true, eventTypes: ["cheer"], priority: 0, stopPropagation: false, condition: { all: [] }, actions: [{ id: "a1", kind: "template-speech", template: "hi" }] },
    },
  });
  const fakePlatform = fakeStreamEventsPlatform();
  const resultCalls = [];
  const runtimeController = new BrowserRuntimeController();
  const { deps } = fakeDeps({ runtimeController, platform: fakePlatform.adapter, onEventTriggerResult: (published, result) => resultCalls.push(result) });

  const appRuntime = new AppRuntime({ runtimeController, factory: createDociaiRuntimeFactory(), deps });
  const first = await appRuntime.start(config1);
  assert.equal(first.ok, true);
  const oldRunner = appRuntime.getComponent("eventTriggerRunner");
  assert.equal(fakePlatform.listeners.length, 1);
  const staleListener = fakePlatform.listeners[0];

  // Reload: a second config apply supersedes generation 1 with generation 2, tearing the old
  // eventTriggerRunner's subscription down BEFORE the new one starts (AppRuntime#applyConfig's own
  // "old teardown, then new start" ordering).
  const second = await appRuntime.applyConfig(config1, { reason: "reload" });
  assert.equal(second.ok, true);
  assert.equal(fakePlatform.unsubscribed.length, 1, "the OLD generation's subscription must be torn down on reload");
  assert.equal(fakePlatform.listeners.length, 2, "the NEW generation registers its own fresh subscription");
  const newRunner = appRuntime.getComponent("eventTriggerRunner");
  assert.notEqual(newRunner, oldRunner, "reload must construct a fresh eventTriggerRunner, never reuse the old one");

  // Even if something still held a reference to the STALE (already-unsubscribed) listener and
  // called it directly (simulating an event already in flight on the event loop at the exact
  // moment reload landed), the runner's own isCurrent() guard must stop it from executing anything
  // under the old generation.
  staleListener(cheerPublished());
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(resultCalls.length, 0, "a stale-generation event must never reach deps.onEventTriggerResult");

  // Directly confirm the OLD ActionRunner's own generation re-check (action-runner.js's real,
  // already-tested mechanism) rejects a plan stamped with the now-superseded generation 1.
  const staleGenerationResult = await oldRunner.actionRunner.execute(
    { id: "p1", eventId: "e1", triggerId: "cheer-rule", actionIndex: 0, kind: "template-speech", action: { id: "a1", kind: "template-speech", template: "hi" }, event: cheerPublished().event, priority: 0, context: "production", generation: 1, createdAt: Date.now() },
  );
  assert.equal(staleGenerationResult.status, "skipped");
  assert.equal(staleGenerationResult.reason, "stale-generation");

  await appRuntime.dispose("test teardown");
}));
