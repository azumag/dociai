// Tests for issue #96's Simulation view (src/twitch-ui/simulation/*.js,
// src/twitch-ui/views/simulation.js) — plain `.mjs` `node --test`, no bundling needed. Reuses the
// SAME minimal fake DOM harness scripts/test/twitch-event-rules-ui.test.mjs established (see that
// file's own header comment for the design rationale).
//
// Covers this issue's own テスト list (the Simulation half): 各fixtureのform/validation, safe
// defaultでSpeech/OBS非実行, 本番同等simulation確認 (a GENUINE test that the simulator is never
// invoked with `productionEquivalent: true` without the explicit confirmation step happening
// first), and official相当fixture registryの再利用 (no divergent/duplicated fixture list).
import assert from "node:assert/strict";
import test from "node:test";

import { SIMULATION_FIXTURE_KINDS as REAL_FIXTURE_KINDS, DEFAULT_SIMULATION_OPTIONS, PRODUCTION_EQUIVALENT_OPTIONS } from "../../src/simulation/stream-event-simulator.js";
import { SIMULATION_FIXTURE_KINDS, defaultDataForFixtureKind, fieldsForFixtureKind } from "../../src/twitch-ui/simulation/fixture-registry.js";
import { buildOverridesFromDraft, coerceFieldValue, renderSimulationForm } from "../../src/twitch-ui/simulation/simulation-form.js";
import { renderSimulationResult } from "../../src/twitch-ui/simulation/simulation-result.js";
import { EventHistoryStore } from "../../src/twitch-ui/history/history-store.js";
import { SimulationView } from "../../src/twitch-ui/views/simulation.js";

// -------------------------------------------------------------------------------------------
// Fake DOM (same design as scripts/test/twitch-event-rules-ui.test.mjs / twitch-event-history-ui.test.mjs).
// -------------------------------------------------------------------------------------------

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this._attributes = {};
    this.dataset = {};
    this._className = "";
    this._text = "";
    this._listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.selected = false;
    this._value = "";
    this._focusCalls = 0;
  }
  set className(v) { this._className = String(v); }
  get className() { return this._className; }
  set textContent(v) { this._text = v == null ? "" : String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join("");
    return this._text;
  }
  set value(v) {
    if (this.tagName === "select") {
      this._value = v;
      for (const option of this.children) option.selected = option.value === v;
    } else {
      this._value = v;
    }
  }
  get value() {
    if (this.tagName === "select") {
      const selected = this.children.find((option) => option.selected);
      return selected ? selected.value : "";
    }
    return this._value;
  }
  setAttribute(name, value) { this._attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null; }
  addEventListener(type, listener) { (this._listeners[type] ??= []).push(listener); }
  dispatch(type) { for (const listener of [...(this._listeners[type] ?? [])]) listener({ preventDefault() {}, target: this }); }
  click() { this.dispatch("click"); }
  focus() { this._focusCalls += 1; }
  appendChild(node) { node.ownerDocument = this.ownerDocument; node.parentNode = this; this.children.push(node); return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  matches(selector) {
    const attrMatch = /^\[data-([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attrMatch) {
      const key = attrMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (!Object.prototype.hasOwnProperty.call(this.dataset, key)) return false;
      return attrMatch[2] === undefined || String(this.dataset[key]) === attrMatch[2];
    }
    if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(selector)) return this.tagName === selector;
    return false;
  }
  querySelector(selector) {
    const stack = [...this.children];
    while (stack.length) {
      const node = stack.shift();
      if (node.matches?.(selector)) return node;
      stack.push(...node.children);
    }
    return null;
  }
  querySelectorAll(selector) {
    const results = [];
    const stack = [...this.children];
    while (stack.length) {
      const node = stack.shift();
      if (node.matches?.(selector)) results.push(node);
      stack.push(...node.children);
    }
    return results;
  }
}

class FakeTextNode {
  constructor(text, ownerDocument) { this.tagName = "#text"; this.ownerDocument = ownerDocument; this._text = text == null ? "" : String(text); this.children = []; }
  get textContent() { return this._text; }
  matches() { return false; }
}

function createFakeDocument() {
  const document = {
    createElement: (tag) => new FakeElement(tag, document),
    createTextNode: (text) => new FakeTextNode(text, document),
  };
  return document;
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function configWithRule(overrides = {}) {
  return {
    personas: [{ id: "persona-1", name: "Persona One", systemPrompt: "" }],
    eventTriggers: {
      "rule-1": { id: "rule-1", enabled: true, eventTypes: SIMULATION_FIXTURE_KINDS, priority: 0, condition: { all: [] }, actions: [{ id: "a1", kind: "template-speech", template: "yo" }] },
      ...overrides,
    },
  };
}

// -------------------------------------------------------------------------------------------
// fixture-registry.js — reuses #93's REAL fixture set, no divergent list.
// -------------------------------------------------------------------------------------------

test("fixture-registry.js: SIMULATION_FIXTURE_KINDS is the SAME array reference as #93's real registry (no second/divergent list)", () => {
  assert.equal(SIMULATION_FIXTURE_KINDS, REAL_FIXTURE_KINDS);
});

test("fixture-registry.js: fieldsForFixtureKind derives from the REAL event-field-registry.js, per fixture kind", () => {
  const cheerFields = fieldsForFixtureKind("cheer").map((entry) => entry.key);
  assert.deepEqual(cheerFields, ["data.bits", "data.message"]);
  const rewardFields = fieldsForFixtureKind("reward-redemption").map((entry) => entry.key);
  assert.deepEqual(rewardFields, ["data.rewardId", "data.rewardTitle", "data.cost", "data.userInput", "data.status"]);
});

test("fixture-registry.js: defaultDataForFixtureKind mirrors the real fixture builder's own baked-in data", () => {
  assert.deepEqual(defaultDataForFixtureKind("cheer"), { bits: 100, message: "応援してます!" });
  assert.equal(defaultDataForFixtureKind("does-not-exist") && Object.keys(defaultDataForFixtureKind("does-not-exist")).length, 0);
});

// -------------------------------------------------------------------------------------------
// simulation-form.js — coercion, override building, schema-driven fields.
// -------------------------------------------------------------------------------------------

test("coerceFieldValue: coerces per the registry's own 3 value types", () => {
  assert.equal(coerceFieldValue("number", "42"), 42);
  assert.equal(coerceFieldValue("number", ""), 0);
  assert.equal(coerceFieldValue("boolean", true), true);
  assert.equal(coerceFieldValue("boolean", "true"), true);
  assert.equal(coerceFieldValue("boolean", false), false);
  assert.equal(coerceFieldValue("string", 123), "123");
});

test("buildOverridesFromDraft: merges user-touched fields over the fixture's own realistic defaults", () => {
  const overrides = buildOverridesFromDraft("cheer", { actorDisplayName: "テスト太郎", data: { bits: 9999 } });
  assert.equal(overrides.actor.displayName, "テスト太郎");
  assert.equal(overrides.data.bits, 9999);
  assert.equal(overrides.data.message, "応援してます!", "an untouched field falls back to the fixture's own default, not undefined/blank");
});

test("renderSimulationForm: schema-driven fields change with fixture kind (cheer -> bits/message; reward-redemption -> rewardId/.../status)", () => {
  const document = createFakeDocument();
  const root = document.createElement("div");
  renderSimulationForm(root, { fixtureKind: "cheer", draft: { data: {} } }, {}, document);
  const cheerInputs = root.querySelectorAll("[data-simulation-field]").map((input) => input.dataset.simulationField);
  assert.ok(cheerInputs.includes("bits"));
  assert.ok(cheerInputs.includes("message"));
  assert.ok(!cheerInputs.includes("rewardId"));

  root.replaceChildren();
  renderSimulationForm(root, { fixtureKind: "reward-redemption", draft: { data: {} } }, {}, document);
  const rewardInputs = root.querySelectorAll("[data-simulation-field]").map((input) => input.dataset.simulationField);
  assert.ok(rewardInputs.includes("rewardId"));
  assert.ok(rewardInputs.includes("cost"));
  assert.ok(!rewardInputs.includes("bits"));
});

test("renderSimulationForm: safe-default options summary reflects DEFAULT_SIMULATION_OPTIONS EXACTLY (surfaced, never redefined)", () => {
  const document = createFakeDocument();
  const root = document.createElement("div");
  renderSimulationForm(root, { fixtureKind: "cheer", draft: { data: {} } }, {}, document);
  const summaryText = root.textContent;
  assert.match(summaryText, /cooldownを無視: ON/);
  assert.match(summaryText, /AIはmockを使用[^:]*: ON/);
  assert.match(summaryText, /音声読み上げ: OFF/);
  assert.match(summaryText, /OBS通知: OFF/);
  assert.equal(DEFAULT_SIMULATION_OPTIONS.bypassCooldown, true);
  assert.equal(DEFAULT_SIMULATION_OPTIONS.useMockAi, true);
  assert.equal(DEFAULT_SIMULATION_OPTIONS.enableSpeech, false);
  assert.equal(DEFAULT_SIMULATION_OPTIONS.enableObs, false);
});

test("renderSimulationForm: the production-equivalent confirm button stays disabled until the acknowledgment checkbox is checked (defense in depth on TOP of the logic-level gate)", () => {
  const document = createFakeDocument();
  const root = document.createElement("div");
  renderSimulationForm(root, { fixtureKind: "cheer", draft: { data: {} }, confirmingProduction: true, productionAcknowledged: false }, {}, document);
  const confirmButton = root.querySelector("[data-simulation-production-confirm]");
  assert.equal(confirmButton.disabled, true);
  const ack = root.querySelector("[data-production-ack]");
  ack.checked = true;
  ack.dispatch("change");
  assert.equal(confirmButton.disabled, false);
});

// -------------------------------------------------------------------------------------------
// simulation-result.js
// -------------------------------------------------------------------------------------------

test("renderSimulationResult: shows an explicit 'not run yet' state before any simulation, then a real summary after", () => {
  const document = createFakeDocument();
  const root = document.createElement("div");
  renderSimulationResult(root, null, {}, document);
  assert.match(root.textContent, /まだ実行していません/);

  const store = new EventHistoryStore();
  const entry = store.recordSimulation({ event: { schemaVersion: 1, id: "e1", kind: "cheer", timestamp: "2026-07-12T10:00:00.000Z", actor: { id: "u", displayName: "A", isAnonymous: false }, channel: { id: "c", displayName: "C" }, sourceMetadata: {}, data: { bits: 5 } }, result: { ok: true, matches: [{ triggerId: "rule-1" }], skipped: [], plans: [{ kind: "template-speech" }], planSkips: [], results: [{ status: "executed" }] } });
  root.replaceChildren();
  renderSimulationResult(root, entry, {}, document);
  assert.match(root.textContent, /処理済み/);
  assert.match(root.textContent, /マッチ: 1件/);
});

// -------------------------------------------------------------------------------------------
// views/simulation.js — safe defaults, production-equivalent confirmation gate, history recording.
// -------------------------------------------------------------------------------------------

test("SimulationView.run(): safe default run NEVER enables speech/OBS/real-AI, even when a real ActionRunner is injected", async () => {
  const document = createFakeDocument();
  const historyStore = new EventHistoryStore();
  const executeCalls = [];
  const actionRunner = {
    async execute(plan, overrides) {
      executeCalls.push(overrides);
      return { planId: plan.id, eventId: plan.eventId, triggerId: plan.triggerId, actionIndex: plan.actionIndex, kind: plan.kind, status: "executed", reason: null, text: "ok", context: plan.context, personaId: null, usedFallback: false, fallbackReason: null, error: null };
    },
  };
  const view = new SimulationView({ document, getConfig: () => configWithRule(), historyStore, actionRunner, log: () => {} });
  const entry = await view.run({ productionEquivalent: false });

  assert.deepEqual(entry.trace.options, DEFAULT_SIMULATION_OPTIONS);
  assert.equal(executeCalls.length, 1);
  assert.equal(executeCalls[0].speak, false, "safe default must never speak");
  assert.equal(executeCalls[0].notifyObs, false, "safe default must never notify OBS");
  assert.equal(executeCalls[0].mockAi, true, "safe default must use the mock AI connector, never a real one");
});

test("SimulationView: productionEquivalent is NEVER passed through without the explicit confirmation step — clicking confirm before acknowledging runs NOTHING", async () => {
  const document = createFakeDocument();
  let recordCalls = 0;
  const historyStore = { recordSimulation: (args) => { recordCalls += 1; return new EventHistoryStore().recordSimulation(args); } };
  const view = new SimulationView({ document, getConfig: () => configWithRule(), historyStore, log: () => {} });
  const root = document.createElement("div");
  view.render(root);

  root.querySelector("[data-simulation-production-request]").click();
  assert.equal(view.confirmingProduction, true);

  // Click the confirm button WITHOUT ever checking the acknowledgment box — simulating a button that
  // is somehow clickable out of order (defense in depth beyond the `disabled` attribute, which a
  // real browser would already prevent). The view's own #confirmProductionRun() must refuse to run
  // ANYTHING — not even a safe-mode run — until `productionAcknowledged` is true.
  root.querySelector("[data-simulation-production-confirm]").click();
  await flush();
  assert.equal(recordCalls, 0, "no simulation of any kind may run before the operator explicitly acknowledges production-equivalent execution");
  assert.equal(view.running, false);

  // Now actually acknowledge, then confirm — THIS must run, and it must be recorded.
  root.querySelector("[data-production-ack]").checked = true;
  root.querySelector("[data-production-ack]").dispatch("change");
  assert.equal(view.productionAcknowledged, true);
  root.querySelector("[data-simulation-production-confirm]").click();
  await flush();
  assert.equal(recordCalls, 1, "after explicit acknowledgment, confirming must actually run exactly one simulation");
});

test("SimulationView.run({ productionEquivalent: true }): once actually invoked (post-confirmation), options are the REAL PRODUCTION_EQUIVALENT_OPTIONS, not a hand-rolled copy", async () => {
  const document = createFakeDocument();
  const historyStore = new EventHistoryStore();
  const view = new SimulationView({ document, getConfig: () => configWithRule(), historyStore, log: () => {} });
  const entry = await view.run({ productionEquivalent: true });
  // `simulateStreamEvent()`'s own `resolveEffectiveOptions()` spreads the caller's raw `options`
  // (which legitimately still carries `productionEquivalent: true` itself) on top of the resolved
  // base — so the effective options object carries that one extra marker key alongside the real
  // `PRODUCTION_EQUIVALENT_OPTIONS` fields; assert both together rather than a bare identity.
  assert.deepEqual(entry.trace.options, { ...PRODUCTION_EQUIVALENT_OPTIONS, productionEquivalent: true });
  assert.equal(PRODUCTION_EQUIVALENT_OPTIONS.enableSpeech, true);
  assert.equal(PRODUCTION_EQUIVALENT_OPTIONS.enableObs, true);
  assert.equal(PRODUCTION_EQUIVALENT_OPTIONS.useMockAi, false);
  assert.equal(PRODUCTION_EQUIVALENT_OPTIONS.bypassCooldown, false);
});

test("SimulationView.run(): an invalid override (fails validateStreamEvent) is recorded as a 'failed' history entry, never silently dropped", async () => {
  const document = createFakeDocument();
  const historyStore = new EventHistoryStore();
  const view = new SimulationView({ document, getConfig: () => configWithRule(), historyStore, log: () => {} });
  view.fixtureKind = "cheer";
  view.draft = { data: { bits: -50 } }; // fails schemas.js's "data.bits must be a positive number"
  const entry = await view.run({});
  assert.equal(entry.status, "failed");
  assert.equal(entry.trace.ok, false);
  assert.ok(entry.trace.issues.some((issue) => issue.path.join(".") === "data.bits"));
});

test("SimulationView: uses the triggers from the CURRENT config's eventTriggers (never a hardcoded/separate rule list), same as views/event-rules.js's own test-this-rule button", async () => {
  const document = createFakeDocument();
  const historyStore = new EventHistoryStore();
  const view = new SimulationView({
    document,
    getConfig: () => ({ personas: [], eventTriggers: { "only-rule": { id: "only-rule", enabled: true, eventTypes: ["cheer"], priority: 0, condition: { all: [{ field: "data.bits", operator: "gte", value: 1 }] }, actions: [] } } }),
    historyStore,
    log: () => {},
  });
  view.fixtureKind = "cheer";
  const entry = await view.run({});
  assert.equal(entry.trace.matches.length, 1);
  assert.equal(entry.trace.matches[0].triggerId, "only-rule");
});

test("SimulationView: a completed run calls onOpenTrace with the recorded entry id (links into Event History's own trace drawer, no duplicated rendering)", async () => {
  const document = createFakeDocument();
  const historyStore = new EventHistoryStore();
  const opened = [];
  const view = new SimulationView({ document, getConfig: () => configWithRule(), historyStore, onOpenTrace: (id) => opened.push(id), log: () => {} });
  const root = document.createElement("div");
  view.render(root);
  await view.run({});
  view.render(root);
  root.querySelector("[data-simulation-open-trace]").click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0], view.lastEntry.id);
});
