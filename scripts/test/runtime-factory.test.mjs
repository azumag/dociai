import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeFactory, personaColorFor, resolveCommentReaderVoice, selectPlatformAdapter, createDociaiRuntimeFactory } from "../../src/app/runtime-factory.js";
import { AppRuntime } from "../../src/app/app-runtime.js";
import { CommentStore } from "../../src/comment-store.js";
import { ManualCommentSource } from "../../src/comment-sources.js";
import { BrowserRuntimeController } from "../../src/runtime/runtime-controller.js";
import { processConfig } from "../../src/config/config-pipeline.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/stream-events/contract.js";
import { SpeechQueue } from "../../src/speech-queue.js";

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

test("comment reader resolves only the selected engine's independent voice settings", () => {
  const config = {
    enabled: true,
    engine: "voicevox",
    webspeech: { name: "Kyoko", rate: 0.8, pitch: 1.4 },
    voicevox: { speaker: 7, speed: 1.2, pitch: -0.05 },
    bouyomi: { voice: 3, speed: 150, tone: 90 },
  };
  const shared = { voicevox: { defaultSpeaker: 9, maxChars: 180 }, bouyomi: { voice: 4, speed: 120, tone: 110, volume: 80 } };
  assert.deepEqual(resolveCommentReaderVoice(config, shared), { enabled: true, engine: "voicevox", speaker: 7, maxChars: 180, speed: 1.2, pitch: -0.05 });
  assert.deepEqual(resolveCommentReaderVoice({ ...config, engine: "webspeech" }), { enabled: true, engine: "webspeech", name: "Kyoko", rate: 0.8, pitch: 1.4 });
  assert.deepEqual(resolveCommentReaderVoice({ ...config, engine: "bouyomi" }, shared), { enabled: true, engine: "bouyomi", voice: 3, speed: 150, tone: 90, volume: 80 });
  assert.deepEqual(resolveCommentReaderVoice({ enabled: true, engine: "voicevox", voicevox: {} }, shared), { enabled: true, engine: "voicevox", speaker: 9, maxChars: 180 });
  assert.deepEqual(resolveCommentReaderVoice({ enabled: true, engine: "voicevox", voicevox: { speaker: null } }, shared), { enabled: true, engine: "voicevox", speaker: 9, maxChars: 180 });
  assert.deepEqual(resolveCommentReaderVoice({ enabled: true, engine: "bouyomi", bouyomi: {} }, shared), { enabled: true, engine: "bouyomi", voice: 4, speed: 120, tone: 110, volume: 80 });
});

test("runtime reload re-resolves transferred comment reader items with the new engine settings", () => {
  const commentReader = { enabled: true, engine: "bouyomi", bouyomi: { speed: 150 } };
  const shared = { bouyomi: { voice: 4, speed: 120, tone: 110, volume: 80 } };
  const queue = new SpeechQueue({ resolveVoice: (personaId, voice) => personaId === "__comment_reader__" ? resolveCommentReaderVoice(commentReader, shared) : voice });
  queue.prepareForRuntimeRestore();
  queue.restoreAfterRuntimeReload({
    items: [{ id: "comment", personaId: "__comment_reader__", personaName: "コメント読み上げ", text: "引き継ぎ", voice: { engine: "webspeech", rate: 0.8, pitch: 1.4 } }],
    holdReasons: ["operator"],
  });
  assert.deepEqual(queue.snapshot().pending[0].voice, { enabled: true, engine: "bouyomi", voice: 4, speed: 150, tone: 110, volume: 80 });
  queue.dispose();
});

test("comment reader applies the configured consecutive emoji collapse before enqueue", async () => {
  const config = minimalConfig({
    commentReader: { enabled: true, includeAuthor: false, collapseConsecutiveEmoji: true },
  });
  const { deps } = fakeDeps();
  const bundle = await createDociaiRuntimeFactory().createCandidate({ config, generation: 1, deps });
  const queue = bundle.get("speechQueue");
  queue.hold("test");
  bundle.get("addComment")({ author: "Viewer", text: "最高😂 😂😂! 次も🎉🎉", source: "manual" });
  assert.equal(queue.snapshot().pending[0].text, "最高😂! 次も🎉");
  for (const component of [...bundle.components].reverse()) if (component.dispose) await component.dispose();
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
  const config = minimalConfig({
    personas: [{ id: "p1", name: "P1", connector: "mock", triggers: ["newsTrigger"] }],
    news: { enabled: true, trigger: "newsTrigger", sources: [] },
    topics: { enabled: true, trigger: "newsTrigger", sources: [] },
  });
  const { deps, calls } = fakeDeps();
  const bundle = await createDociaiRuntimeFactory().createCandidate({ config, generation: 1, deps });

  assert.deepEqual(bundle.names(), [
    "connectors", "personaRouter", "speechQueue", "webResearcher", "contextBuilder",
    "responseCoordinator", "eventTriggerRunner", "automationCoordinator", "newsReader", "topicReader",
    "triggerEngine", "sourceCoordinator",
  ]);
  assert.equal(calls.onSecrets.length, 1);
  assert.equal(bundle.get("connectors").size, 1);
  assert.equal(bundle.get("webResearcher").enabled, false);
  assert.equal(bundle.get("screenContext"), null);
  assert.equal(bundle.get("micMonitor"), null);
  assert.equal(bundle.get("sourceCoordinator").sources.size, 0, "sourceCoordinator.replace() must only run on start(), not create");

  const automationCoordinator = bundle.get("automationCoordinator");
  const newsReader = bundle.get("newsReader");
  const topicReader = bundle.get("topicReader");
  const responseCoordinator = bundle.get("responseCoordinator");
  const runCalls = [];
  let responseCalls = 0;
  automationCoordinator.run = (kind, reader) => { runCalls.push([kind, reader]); return Promise.resolve(); };
  responseCoordinator.handleTrigger = () => { responseCalls += 1; return ["unexpected-response"]; };

  const handleTrigger = bundle.get("handleTrigger");
  assert.deepEqual(handleTrigger("newsTrigger"), []);
  assert.deepEqual(runCalls, [["news", newsReader], ["topics", topicReader]], "one shared trigger must start every matching automation");
  assert.equal(responseCalls, 0, "an automation trigger must not also dispatch a persona response");
});

test("micMonitor only interrupts AI speech (speechQueue.hold(\"mic\")) while deps.isMicBargeInEnabled() is true; toggling it off releases an existing hold", async () => {
  const config = minimalConfig({ micMonitor: { enabled: true } });
  let bargeInEnabled = true;
  const { deps } = fakeDeps({ isMicBargeInEnabled: () => bargeInEnabled });
  // isCurrent(1) must actually be true for generation 1 — outside of AppRuntime (which calls this
  // as part of commit()), a fresh BrowserRuntimeController starts at generation 0.
  deps.runtimeController.generations.next("test");
  const bundle = await createDociaiRuntimeFactory().createCandidate({ config, generation: 1, deps });

  const micMonitor = bundle.get("micMonitor");
  const speechQueue = bundle.get("speechQueue");
  assert.ok(micMonitor, "micMonitor must be constructed when config.micMonitor.enabled is true");

  // start() only registers the onChange listener (no real getUserMedia/audio capture) — grab it
  // to simulate what MicMonitor's real #tick()/#notify() would fire on a speaking-state change.
  await bundle.components.find((c) => c.name === "micMonitor").start();
  const notifyListener = [...micMonitor.listeners][0];
  assert.equal(typeof notifyListener, "function");

  micMonitor.speaking = true;
  notifyListener();
  assert.equal(speechQueue.paused, true, "mic speech must hold/interrupt the AI speech queue when barge-in is enabled");
  assert.deepEqual(speechQueue.holdReasons, ["mic"]);

  micMonitor.speaking = false;
  notifyListener();
  assert.equal(speechQueue.paused, false, "silence must release the hold");

  bargeInEnabled = false;
  micMonitor.speaking = true;
  notifyListener();
  assert.equal(speechQueue.paused, false, "mic speech must NOT interrupt the AI speech queue while barge-in is disabled");

  // Disabling barge-in mid-hold must release any pre-existing "mic" hold, not just skip future ones.
  bargeInEnabled = true;
  notifyListener();
  assert.equal(speechQueue.paused, true);
  bargeInEnabled = false;
  notifyListener();
  assert.equal(speechQueue.paused, false, "toggling barge-in off must release an already-held mic hold");
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

test("regression: addComment() preserves a raw comment's `bits` field through CommentStore.add() so the double-fire guard actually receives it", async () => {
  // Reproduces a real bug caught in review: CommentStore.add() destructured/rebuilt the comment
  // object WITHOUT a `bits` field, so by the time addComment() (src/app/runtime-factory.js) handed
  // the STORED comment to triggerEngine.handleComment(), the bits value a real cheer's chat PRIVMSG
  // carries had already been silently dropped — making trigger-engine.js's own `comment.bits > 0`
  // double-fire guard dead code in production, even though trigger-engine.test.mjs's own unit tests
  // (which call handleComment() directly with a hand-built object) stayed green throughout, since
  // they never exercised CommentStore.add()'s normalization step at all.
  const config = minimalConfig();
  const { deps } = fakeDeps();
  const bundle = await createDociaiRuntimeFactory().createCandidate({ config, generation: 1, deps });

  const triggerEngine = bundle.get("triggerEngine");
  const originalHandleComment = triggerEngine.handleComment.bind(triggerEngine);
  const observed = [];
  triggerEngine.handleComment = (comment) => {
    const result = originalHandleComment(comment);
    observed.push({ comment, result });
    return result;
  };

  const addComment = bundle.get("addComment");
  const stored = addComment({ author: "Viewer", text: "hi there, cheers!", source: "twitch", bits: 100 });

  assert.equal(stored.bits, 100, "CommentStore.add() must preserve the raw comment's bits field on the returned/stored comment");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].comment.bits, 100, "triggerEngine.handleComment must actually receive the bits value addComment() was given, not a normalized comment with it stripped");
  assert.deepEqual(observed[0].result, [], "with bits intact, the 'hi' keyword trigger must NOT fire for this cheer text even though it contains the keyword — this is the actual double-fire guard working end-to-end");
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
