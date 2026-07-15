import assert from "node:assert/strict";
import test from "node:test";
import { personaTriggerIdsForDisplay } from "../../src/ui/persona-trigger-display.js";
import { createAppState } from "../../src/app/app-state.js";
import { AppStore } from "../../src/app/app-store.js";
import { bindConsoleUI } from "../../src/ui/bindings.js";
import { ElementRegistry } from "../../src/ui/element-registry.js";

test("persona trigger display follows settings definition order and retains missing references", () => {
  assert.deepEqual(
    personaTriggerIdsForDisplay(["hotkey", "mention", "missing"], { mention: {}, random: {}, hotkey: {} }),
    ["mention", "hotkey", "missing"],
  );
  assert.deepEqual(personaTriggerIdsForDisplay([], { mention: {} }), []);
});

test("AppStore reducer snapshots are immutable and subscribers are isolated", () => {
  const store = new AppStore(createAppState({ generation: 1, thinking: new Set(["p1"]) }));
  let called = 0;
  store.subscribe(() => { throw new Error("listener failure"); });
  const unsubscribe = store.subscribe((snapshot, action) => { called++; assert.equal(action.type, "set"); assert.equal(snapshot.generation, 2); });
  store.dispatch({ type: "set", key: "generation", value: 2 });
  assert.equal(called, 1);
  unsubscribe();
  store.dispatch({ type: "set", key: "generation", value: 3 });
  assert.equal(called, 1);
  const snapshot = store.getSnapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.thinking));
  assert.throws(() => snapshot.thinking.push("p2"));
});

class FakeElement {
  constructor() { this.listeners = new Map(); this.value = ""; this.files = []; this.clicks = 0; }
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== callback)); }
  emit(type, event = {}) { for (const callback of this.listeners.get(type) ?? []) callback({ preventDefault() {}, target: this, ...event }); }
  click() { this.clicks++; }
  focus() {}
}

test("element registry fails loudly and bindings call actions exactly once after remount", () => {
  const names = ["loadServer", "loadFile", "fileInput", "settings", "commentForm", "commentText", "commentAuthor", "speechStop", "speechResume", "speechSkip", "speechClear", "micStart", "micStop", "screenStart", "screenStop", "screenRead", "newsRead", "topicRead", "twitchReconnect"];
  const nodes = Object.fromEntries(names.map((name) => [name, new FakeElement()]));
  const document = { querySelector: (selector) => nodes[selector.slice(1)] ?? null };
  assert.throws(() => new ElementRegistry(document, { missing: "#missing" }), /Required DOM element/);
  const registry = new ElementRegistry(document, Object.fromEntries(names.map((name) => [name, `#${name}`])));
  const calls = [];
  const actionNames = ["loadServer", "loadFile", "openSettings", "submitComment", "holdSpeech", "releaseSpeech", "skipSpeech", "clearSpeech", "startMic", "stopMic", "startScreen", "stopScreen", "readScreen", "readNews", "readTopics", "reconnectTwitch", "refreshTimedPanels"];
  const actions = Object.fromEntries(actionNames.map((name) => [name, (...args) => calls.push([name, ...args])]));
  let timerId = 0;
  const timers = new Map();
  const options = { setIntervalImpl: (callback) => { timers.set(++timerId, callback); return timerId; }, clearIntervalImpl: (id) => timers.delete(id) };
  const disposeFirst = bindConsoleUI(registry, actions, options);
  nodes.speechStop.emit("click");
  assert.deepEqual(calls, [["holdSpeech"]]);
  disposeFirst();
  nodes.speechStop.emit("click");
  assert.equal(calls.length, 1);
  const disposeSecond = bindConsoleUI(registry, actions, options);
  nodes.speechStop.emit("click");
  assert.equal(calls.length, 2);
  disposeSecond();
  assert.equal(timers.size, 0);
});
