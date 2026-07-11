import assert from "node:assert/strict";
import test from "node:test";
import { AutomationCoordinator } from "../../src/app/automation-coordinator.js";
import { ResponseCoordinator } from "../../src/app/response-coordinator.js";
import { SourceCoordinator } from "../../src/app/source-coordinator.js";
import { ObsBridge } from "../../src/obs/obs-bridge.js";

const runtime = { createRequest: () => ({ context: { signal: new AbortController().signal, requestId: "r1" }, complete() {} }), isCurrent: () => true, guard() {} };

test("ResponseCoordinator delivers final text once to store, OBS, and speech", async () => {
  const actions = [], published = [], spoken = [];
  const persona = { id: "p", name: "P", connector: "c", voice: {} };
  const coordinator = new ResponseCoordinator({ runtime, getGeneration: () => 1, getConnector: () => ({ chat: async () => ({ text: "hello" }) }), personaRouter: { select: () => ({ selected: [persona], skipped: [] }), recordReply() {} }, contextBuilder: { build: () => ({ messages: [], debugText: "debug" }) }, speechQueue: { enqueue: (item) => spoken.push(item) }, dispatch: (action) => actions.push(action), publish: (...args) => published.push(args) });
  assert.equal(await coordinator.respond(persona), "hello");
  assert.equal(actions.filter((action) => action.type === "response-final").length, 1);
  assert.equal(spoken.length, 1); assert.equal(published.length, 1);
  assert.equal(coordinator.dispose(), true); assert.equal(coordinator.dispose(), false);
});

test("ResponseCoordinator commits a selected reservation and releases it when the connector is missing", () => {
  const persona = { id: "p", name: "P", connector: "missing", voice: {} };
  const selection = { persona, reservation: { id: "r" } };
  const calls = [];
  const coordinator = new ResponseCoordinator({ runtime: { createRequest() {} }, getGeneration: () => 1, getConnector: () => null, personaRouter: { select: () => ({ selected: [selection], skipped: [] }), releaseSelection: (value) => calls.push(value) }, contextBuilder: {}, speechQueue: {}, onError() {} });
  assert.deepEqual(coordinator.handleTrigger("trigger"), [persona]);
  assert.deepEqual(calls, [selection]);
});

test("SourceCoordinator stops old sources before starting new and ignores stale events", async () => {
  const order = [], comments = [];
  let current = true;
  const coordinator = new SourceCoordinator({ isCurrent: () => current, onComment: (comment) => comments.push(comment) });
  const factory = (id) => () => ({ id, start(callback) { order.push(`start:${id}`); this.callback = callback; }, stop() { order.push(`stop:${id}`); } });
  const [old] = await coordinator.replace([factory("old")]);
  await coordinator.replace([factory("new")]);
  assert.deepEqual(order, ["start:old", "stop:old", "start:new"]);
  current = false; old.callback({ text: "stale" }); assert.equal(comments.length, 0);
});

test("AutomationCoordinator suppresses duplicate runs and ObsBridge is bounded after dispose", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const automation = new AutomationCoordinator({ runtime, getGeneration: () => 1 });
  const reader = { run: () => pending };
  const first = automation.run("news", reader); assert.equal(automation.run("news", reader), first);
  resolve(); await first; assert.equal(automation.active.size, 0);
  const messages = [];
  const bridge = new ObsBridge({ transport: { postMessage: (message) => messages.push(message) }, getGeneration: () => 3 });
  assert.equal(bridge.publish("comment", { text: "x" }), true); assert.equal(messages[0].payload.generation, 3);
  bridge.dispose(); assert.equal(bridge.publish("comment", {}), false);
});
