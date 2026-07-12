import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeFactory, personaColorFor, selectPlatformAdapter, createDociaiRuntimeFactory } from "../../src/app/runtime-factory.js";
import { CommentStore } from "../../src/comment-store.js";
import { ManualCommentSource } from "../../src/comment-sources.js";
import { BrowserRuntimeController } from "../../src/runtime/runtime-controller.js";
import { processConfig } from "../../src/config/config-pipeline.js";

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
  const browserTwitchSource = browser.createTwitchSource({ channels: ["a"] }, { onStatus: () => {} });
  assert.equal(browserTwitchSource.constructor.name, "TwitchChatSource");

  const electronScope = { dociai: { obs: {}, twitch: { start: () => {} } } };
  const electron = selectPlatformAdapter(electronScope);
  assert.equal(electron.kind, "electron");
  assert.equal(electron.hasTwitchService(), true);
  const electronTwitchSource = electron.createTwitchSource({ channels: ["a"] }, { onStatus: () => {} });
  assert.equal(electronTwitchSource.constructor.name, "ElectronTwitchSource");

  // Electron obs transport present but the twitch bridge missing: falls back per-service,
  // exactly like app.js's original hasElectronTwitchService() guard did.
  const partialScope = { dociai: { obs: {} } };
  const partial = selectPlatformAdapter(partialScope);
  assert.equal(partial.kind, "electron");
  assert.equal(partial.hasTwitchService(), false);
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
    "responseCoordinator", "automationCoordinator", "newsReader", "topicReader",
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
