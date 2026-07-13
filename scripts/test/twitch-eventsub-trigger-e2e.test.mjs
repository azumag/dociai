// Issue #177: the genuine END-TO-END fixture test for the production wiring this issue adds — a
// REAL Twitch EventSub `notification` WebSocket frame (Twitch's own documented fixture JSON, see
// tests/fixtures/twitch/eventsub/cheer.json) all the way through to a fake AI connector/SpeechQueue/
// OBS spy actually being called:
//
//   raw JSON text -> parseEventSubMessage() -> EventSubToStreamEventBridge.handleNotification()
//   -> normalizeTwitchEvent() -> StreamEvent -> StreamEventBus.publish("production")
//   -> bus subscriber (simulates electron/main/index.ts's real `streamEventBus.subscribe(...) ->
//      controller.emitToConsole("stream-event", published)` IPC forward — the Main/Renderer process
//      boundary itself can't be crossed inside one Node process, so this is where the two REAL
//      halves of the chain — Main's bus publish and the Renderer's bus-push handling — are spliced
//      together, exactly as electron/main/index.ts's own `STREAM_EVENT_APP_EVENT_TYPE` push already
//      does verbatim in production)
//   -> matchEvent() -> planActions() -> CooldownTracker -> ActionRunner.execute()
//   -> fake AI connector / SpeechQueue / OBS broadcast spies receive the call.
//
// Every module above the Main/Renderer IPC splice is TypeScript (electron/main/services/twitch/
// events/eventsub-to-streamevent-bridge.ts, electron/main/services/twitch/eventsub/eventsub-
// message-parser.ts, electron/main/services/stream-events/stream-event-bus.ts); everything below it
// is plain src/*.js — esbuild bundles both into one module graph in a single stdin build (the same
// technique electron/main/services/stream-events/stream-event-bus.ts's own test already relies on,
// since that file itself transitively imports src/stream-events/{contract,schemas}.js), so this one
// test file drives the REAL chain, not a re-implementation of it.
//
// Also covers (per this issue's own required test list):
//   - a malformed/unknown-type notification is diagnosed, never silently dropped
//   - burst boundedness: N StreamEvents arriving in a tight burst never produce more executed AI
//     requests / SpeechQueue items than the real GlobalActionBudget allows
// Config-reload/stale-generation coverage (the third required test) lives in
// scripts/test/runtime-factory.test.mjs's own dedicated "config reload discards the OLD
// generation's subscription" test — that is genuinely a Renderer-only (AppRuntime/generation)
// concern with no Main-process/EventSub involvement, so it is exercised there against the REAL
// eventTriggerRunner component instead of being duplicated here.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const fixturesDir = path.join(repoRoot, "tests/fixtures/twitch/eventsub");

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { parseEventSubMessage } from "./electron/main/services/twitch/eventsub/eventsub-message-parser.ts";`,
        `export { EventSubToStreamEventBridge } from "./electron/main/services/twitch/events/eventsub-to-streamevent-bridge.ts";`,
        `export { StreamEventBus } from "./electron/main/services/stream-events/stream-event-bus.ts";`,
        `export { matchEvent } from "./src/triggers/event-trigger-matcher.js";`,
        `export { planActions } from "./src/actions/action-planner.js";`,
        `export { ActionRunner } from "./src/actions/action-runner.js";`,
        `export { runProductionStreamEvent } from "./src/simulation/stream-event-simulator.js";`,
        `export { CooldownTracker } from "./src/triggers/cooldown-tracker.js";`,
        `export { GlobalActionBudget } from "./src/actions/global-action-budget.js";`,
        `export { BrowserRuntimeController } from "./src/runtime/runtime-controller.js";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "twitch-eventsub-trigger-e2e-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-eventsub-trigger-e2e-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

async function loadFixture(name) {
  return JSON.parse(await fs.readFile(path.join(fixturesDir, name), "utf8"));
}

/** Wires ONE real StreamEventBus + ONE real EventSubToStreamEventBridge together, mirroring
 * twitch-composition.ts's own construction (`onStreamEvent: (event) => streamEventBus.publish(event,
 * "production")`) — never a re-implementation of that wiring. Returns everything a test needs to
 * feed a raw notification in and observe both the bridge's diagnostics and the bus's published
 * output (what the Main/Renderer IPC boundary would forward in the real app). */
function makeMainProcessHalf(modules) {
  const streamEventBus = new modules.StreamEventBus();
  const diagnostics = [];
  const bridge = new modules.EventSubToStreamEventBridge({
    onStreamEvent: (event) => { streamEventBus.publish(event, "production"); },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { streamEventBus, bridge, diagnostics };
}

/** Wires ONE real ActionRunner with fake (spy) AI connector / SpeechQueue / OBS — the exact shapes
 * scripts/test/stream-event-actions.test.mjs's own `makeRunner()` uses, reused here rather than
 * reinvented. */
function makeRendererHalf(modules, { runtime, globalActionBudget } = {}) {
  const aiCalls = [];
  const speechCalls = [];
  const obsCalls = [];
  const connector = { chat: async (messages) => { aiCalls.push(messages); return { text: "ありがとうございます!" }; } };
  const persona = { id: "p1", name: "Persona1", connector: "c1", enabled: true, voice: { enabled: true } };
  const actionRunner = new modules.ActionRunner({
    runtime: runtime ?? new modules.BrowserRuntimeController(),
    globalActionBudget: globalActionBudget ?? new modules.GlobalActionBudget(),
    resolvePersona: () => persona,
    getConnector: () => connector,
    speechQueue: { enqueue: (item) => speechCalls.push(item) },
    obs: { publish: (type, payload) => obsCalls.push({ type, payload }) },
  });
  return { actionRunner, aiCalls, speechCalls, obsCalls };
}

test("END-TO-END: a real EventSub cheer notification (raw JSON text) reaches a fake AI connector / SpeechQueue / OBS spy through the full production chain — bridge -> normalize -> bus.publish -> matcher -> planner -> cooldown -> ActionRunner.execute", async () => {
  const { modules, directory } = await loadModules();
  try {
    const fixture = await loadFixture("cheer.json");
    const rawFrameText = JSON.stringify(fixture); // exactly what a real WebSocket "message" event delivers

    const { streamEventBus, bridge, diagnostics } = makeMainProcessHalf(modules);

    // The Renderer-side subscription electron/main/index.ts's `streamEventBus.subscribe(...)`
    // already forwards over IPC ("stream-event" app:event, per #89/#96) — simulated directly here
    // since Main and Renderer are two different OS processes in the real app and cannot be spliced
    // by an in-process function call; everything on EITHER side of this line is still real code.
    const receivedByRenderer = [];
    streamEventBus.subscribe((published) => receivedByRenderer.push(published));

    const parsed = modules.parseEventSubMessage(rawFrameText);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "known");
    assert.equal(parsed.messageType, "notification");

    bridge.handleNotification(parsed.envelope);

    assert.equal(diagnostics.length, 0, "a real, well-formed cheer notification must never be diagnosed as a failure");
    assert.equal(receivedByRenderer.length, 1, "the bridge's onStreamEvent must have reached the bus, and the bus must have forwarded it to its subscriber");
    const published = receivedByRenderer[0];
    assert.equal(published.context, "production");
    assert.equal(published.event.kind, "cheer");
    assert.equal(published.event.data.bits, 1000);

    // The Renderer half: a real EventTriggerConfig whose condition targets bits >= 500, a real
    // CooldownTracker, and a real ActionRunner with fake AI/SpeechQueue/OBS.
    const triggers = [
      {
        id: "big-cheer",
        enabled: true,
        eventTypes: ["cheer"],
        priority: 0,
        stopPropagation: false,
        condition: { all: [{ field: "data.bits", operator: "gte", value: 500 }] },
        actions: [{ id: "a1", kind: "ai-response", personaId: "p1" }],
      },
    ];
    const cooldownTracker = new modules.CooldownTracker();
    const { actionRunner, aiCalls, speechCalls, obsCalls } = makeRendererHalf(modules);

    const result = await modules.runProductionStreamEvent({
      event: published.event,
      triggers,
      actionRunner,
      cooldownTracker,
      cooldownConfigByTrigger: () => ({ cooldownMs: 30_000, consumeOn: "scheduled" }),
      generation: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.context, "production");
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].triggerId, "big-cheer");
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, "executed");

    assert.equal(aiCalls.length, 1, "the fake AI connector must actually have been called — this is a REAL production execution, not mocked/bypassed");
    assert.equal(speechCalls.length, 1, "the fake SpeechQueue must have received the AI's final text");
    assert.equal(speechCalls[0].text, "ありがとうございます!");
    assert.equal(obsCalls.length, 1, "the fake OBS broadcast must have been notified");
    assert.equal(obsCalls[0].payload.context, "production");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("END-TO-END: an unrecognized type@version notification is diagnosed and never reaches the bus/matcher/ActionRunner at all — no silent drop anywhere in the chain", async () => {
  const { modules, directory } = await loadModules();
  try {
    const { streamEventBus, bridge, diagnostics } = makeMainProcessHalf(modules);
    const received = [];
    streamEventBus.subscribe((published) => received.push(published));

    const rawFrame = JSON.stringify({
      metadata: { message_id: "raid-1", message_type: "notification", message_timestamp: new Date().toISOString(), subscription_type: "channel.raid", subscription_version: "1" },
      payload: { subscription: { type: "channel.raid" }, event: { from_broadcaster_user_id: "1" } },
    });
    const parsed = modules.parseEventSubMessage(rawFrame);
    assert.equal(parsed.ok, true);
    bridge.handleNotification(parsed.envelope);

    assert.equal(received.length, 0, "an unnormalizable notification must never reach the StreamEventBus");
    assert.equal(diagnostics.length, 1, "it must be diagnosed instead of silently dropped");
    assert.equal(diagnostics[0].reason, "normalize-failed");
    assert.equal(diagnostics[0].type, "channel.raid");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("END-TO-END burst boundedness: a burst of many cheer notifications never produces more executed AI/SpeechQueue calls than the REAL GlobalActionBudget allows — the rest are skipped, not silently coalesced or unbounded", async () => {
  const { modules, directory } = await loadModules();
  try {
    const { streamEventBus, bridge, diagnostics } = makeMainProcessHalf(modules);
    const received = [];
    streamEventBus.subscribe((published) => received.push(published));

    const fixture = await loadFixture("cheer.json");
    const BURST_SIZE = 12;
    for (let i = 0; i < BURST_SIZE; i += 1) {
      const frame = structuredClone(fixture);
      frame.metadata.message_id = `burst-msg-${i}`;
      bridge.handleNotification(modules.parseEventSubMessage(JSON.stringify(frame)).envelope);
    }
    assert.equal(diagnostics.length, 0);
    assert.equal(received.length, BURST_SIZE, "every distinct-message-id notification must reach the bus (this is not a dedupe test)");

    const triggers = [{ id: "cheer-rule", enabled: true, eventTypes: ["cheer"], priority: 0, stopPropagation: false, condition: { all: [] }, actions: [{ id: "a1", kind: "ai-response", personaId: "p1" }] }];
    // A deliberately tight budget: at most 3 executed actions total, no matter how many events
    // arrive in the burst — proves the REAL #92 GlobalActionBudget (not a contrived stand-in) is
    // actually consulted on the production execution path, exactly as it already is on the
    // simulation path (see scripts/test/stream-event-actions.test.mjs's own GlobalActionBudget
    // re-check test).
    const globalActionBudget = new modules.GlobalActionBudget({ windowMs: 60_000, maxPerWindow: 3, maxConcurrent: 3, highPriorityReserve: 0 });
    const { actionRunner, aiCalls, speechCalls } = makeRendererHalf(modules, { globalActionBudget });

    const results = [];
    for (const published of received) {
      const result = await modules.runProductionStreamEvent({ event: published.event, triggers, actionRunner, generation: 0 });
      results.push(...result.results);
    }

    const executed = results.filter((entry) => entry.status === "executed");
    const budgetSkipped = results.filter((entry) => entry.status === "skipped" && entry.reason === "global-rate-limit");
    assert.equal(executed.length, 3, "at most maxPerWindow=3 actions may execute, regardless of burst size");
    assert.equal(budgetSkipped.length, BURST_SIZE - 3, "every action beyond the budget must be explicitly skipped for a budget reason, not silently lost or unbounded");
    assert.equal(aiCalls.length, 3, "the REAL AI connector must be called AT MOST maxPerWindow times — burst volume must never translate 1:1 into AI request volume");
    assert.equal(speechCalls.length, 3, "the REAL SpeechQueue must receive AT MOST maxPerWindow items for the same reason");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
