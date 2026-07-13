// Tests for issue #96's Event History view (src/twitch-ui/history/*.js,
// src/twitch-ui/views/event-history.js) — plain `.mjs` `node --test`, no bundling needed (same
// un-bundled browser JS convention every other src/*.js test in this repo already uses; see
// scripts/test/twitch-ui.test.mjs's own header comment). Reuses the SAME minimal fake DOM harness
// scripts/test/twitch-event-rules-ui.test.mjs already established (createElement/append/
// replaceChildren/dataset/select+option/checkbox+radio/`[data-x]`/`[data-x="value"]`
// querySelector) — kept as its own copy here rather than a shared import, matching this repo's
// existing "each *-ui.test.mjs owns its own small harness" convention.
//
// Covers this issue's own テスト list (the Event History half): history append/update/trim/filter,
// production/simulation badge, handled/skipped/failed trace, prompt/diagnostic secret scan,
// keyboard/focus/mobile (focus restoration + aria-live).
import assert from "node:assert/strict";
import test from "node:test";

import { simulateStreamEvent } from "../../src/simulation/stream-event-simulator.js";
import { DEFAULT_HISTORY_MAX_ENTRIES, EventHistoryStore, deriveSimulationStatus } from "../../src/twitch-ui/history/history-store.js";
import { filterHistoryEntries } from "../../src/twitch-ui/history/history-filter.js";
import { renderTriggerTraceDrawer } from "../../src/twitch-ui/history/trigger-trace-drawer.js";
import { EventHistoryView } from "../../src/twitch-ui/views/event-history.js";

// -------------------------------------------------------------------------------------------
// Fake DOM (see scripts/test/twitch-event-rules-ui.test.mjs's own header comment for the design).
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
  removeEventListener(type, listener) { this._listeners[type] = (this._listeners[type] ?? []).filter((entry) => entry !== listener); }
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
    if (selector === "button") return this.tagName === "button";
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
  set textContent(v) { this._text = v == null ? "" : String(v); }
  matches() { return false; }
}

function createFakeDocument() {
  const document = {
    createElement: (tag) => new FakeElement(tag, document),
    createTextNode: (text) => new FakeTextNode(text, document),
  };
  return document;
}

let sequence = 0;
function cheerEvent(overrides = {}) {
  sequence += 1;
  return {
    schemaVersion: 1,
    id: overrides.id ?? `evt-${sequence}`,
    kind: "cheer",
    timestamp: "2026-07-12T10:00:00.000Z",
    actor: { id: "user-1", displayName: "Alice", isAnonymous: false },
    channel: { id: "channel-1", displayName: "AliceChannel" },
    sourceMetadata: {},
    data: { bits: 100 },
    ...overrides,
  };
}

function publishedOf(event, context = "production", publishedAtMs = 1_000) {
  return { context, publishedAtMs, event };
}

// -------------------------------------------------------------------------------------------
// history-store.js — append/update/trim/filter, production/simulation, bounded.
// -------------------------------------------------------------------------------------------

test("EventHistoryStore.recordProduction appends and is idempotent by (context, event.id) — snapshot/push overlap never duplicates a row", () => {
  const store = new EventHistoryStore();
  const event = cheerEvent({ id: "evt-dup" });
  const first = store.recordProduction(publishedOf(event));
  const second = store.recordProduction(publishedOf(event));
  assert.equal(first, second, "the exact same (context, id) must return the SAME entry, not a new one");
  assert.equal(store.list().length, 1);
  assert.equal(first.status, "pending");
  assert.equal(first.context, "production");
});

test("EventHistoryStore trims the oldest entries once over maxEntries (bounded for a long-running stream)", () => {
  const store = new EventHistoryStore({ maxEntries: 3 });
  for (let index = 0; index < 10; index += 1) store.recordProduction(publishedOf(cheerEvent({ id: `evt-${index}` }), "production", 1_000 + index));
  const list = store.list();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((entry) => entry.event.id), ["evt-7", "evt-8", "evt-9"]);
});

test("EventHistoryStore default bound mirrors the Main-process bus's own practical default (500)", () => {
  assert.equal(DEFAULT_HISTORY_MAX_ENTRIES, 500);
});

test("EventHistoryStore.updateStatus transitions an entry's status/trace in place (pending -> handled)", () => {
  const store = new EventHistoryStore();
  const entry = store.recordProduction(publishedOf(cheerEvent({ id: "evt-pending" })));
  assert.equal(entry.status, "pending");
  const trace = { ok: true, matches: [{ triggerId: "r1" }], skipped: [], plans: [], planSkips: [], results: [{ status: "executed" }] };
  const updated = store.updateStatus(entry.id, { status: "handled", trace });
  assert.equal(updated.status, "handled");
  assert.equal(updated.trace, trace);
  assert.equal(store.get(entry.id).status, "handled", "the store's own held entry must reflect the update");
  assert.equal(store.updateStatus("does-not-exist", { status: "failed" }), null);
});

test("deriveSimulationStatus: failed > handled > skipped priority, driven by the REAL simulateStreamEvent() result shape", () => {
  assert.equal(deriveSimulationStatus(null), "failed");
  assert.equal(deriveSimulationStatus({ ok: false }), "failed");
  assert.equal(deriveSimulationStatus({ ok: true, matches: [] }), "skipped");
  assert.equal(deriveSimulationStatus({ ok: true, matches: [{}], results: [] }), "skipped", "matched but never executed (no actionRunner) is skipped, not handled");
  assert.equal(deriveSimulationStatus({ ok: true, matches: [{}], results: [{ status: "executed" }] }), "handled");
  assert.equal(deriveSimulationStatus({ ok: true, matches: [{}], results: [{ status: "fallback" }] }), "failed");
  assert.equal(deriveSimulationStatus({ ok: true, matches: [{}], results: [{ status: "executed" }, { status: "fallback" }] }), "failed", "any failure in the batch takes priority over a partial success");
});

test("EventHistoryStore.clear() honors scope: all / production / simulation / olderThanMs", () => {
  let now = 10_000;
  const store = new EventHistoryStore({ clock: () => now });
  store.recordProduction(publishedOf(cheerEvent({ id: "p1" })));
  now += 1_000;
  store.recordSimulation({ event: cheerEvent({ id: "s1" }), result: { ok: true, matches: [], results: [] }, now });
  now += 1_000;
  store.recordProduction(publishedOf(cheerEvent({ id: "p2" })));

  assert.equal(store.clear("simulation"), 1);
  assert.deepEqual(store.list().map((entry) => entry.event.id), ["p1", "p2"]);

  now += 100_000;
  store.recordSimulation({ event: cheerEvent({ id: "s2" }), result: { ok: true, matches: [], results: [] }, now });
  assert.equal(store.clear({ olderThanMs: 50_000 }), 2, "only entries older than 50s (p1, p2) should be removed, not the just-added s2");
  assert.deepEqual(store.list().map((entry) => entry.event.id), ["s2"]);

  assert.equal(store.clear("all"), 1);
  assert.equal(store.list().length, 0);
});

// -------------------------------------------------------------------------------------------
// history-filter.js — production/simulation, type, result, text filters.
// -------------------------------------------------------------------------------------------

test("filterHistoryEntries: context/type/result/text filters compose (all default to unfiltered)", () => {
  const store = new EventHistoryStore();
  store.recordProduction(publishedOf(cheerEvent({ id: "p1", data: { bits: 50 } })));
  store.recordSimulation({ event: cheerEvent({ id: "s1", actor: { id: "u2", displayName: "Bob", isAnonymous: false } }), result: { ok: true, matches: [{ triggerId: "rule-x" }], results: [{ status: "executed" }] } });
  store.recordSimulation({ event: { ...cheerEvent({ id: "s2" }), kind: "subscription", data: { tier: "1000" } }, result: { ok: true, matches: [], results: [] } });

  assert.deepEqual(filterHistoryEntries(store.list(), { context: "simulation" }).map((e) => e.event.id), ["s1", "s2"]);
  assert.deepEqual(filterHistoryEntries(store.list(), { type: "subscription" }).map((e) => e.event.id), ["s2"]);
  assert.deepEqual(filterHistoryEntries(store.list(), { result: "handled" }).map((e) => e.event.id), ["s1"]);
  assert.deepEqual(filterHistoryEntries(store.list(), { text: "bob" }).map((e) => e.event.id), ["s1"], "text filter matches actor display name, case-insensitively");
  assert.deepEqual(filterHistoryEntries(store.list(), { context: "production", result: "pending" }).map((e) => e.event.id), ["p1"]);
});

// -------------------------------------------------------------------------------------------
// views/event-history.js — production/simulation badge, handled/skipped/failed trace rendering,
// focus restoration, aria-live, collapsed message.
// -------------------------------------------------------------------------------------------

function makeView({ document, store, client = null, getConfig = () => ({ personas: [], eventTriggers: {} }) } = {}) {
  return new EventHistoryView({ document, client, historyStore: store, getConfig, log: () => {} });
}

test("EventHistoryView row list: production and simulation entries are visibly distinct badges (never misidentified)", () => {
  const document = createFakeDocument();
  const store = new EventHistoryStore();
  store.recordProduction(publishedOf(cheerEvent({ id: "p1" })));
  store.recordSimulation({ event: cheerEvent({ id: "s1" }), result: { ok: true, matches: [], results: [] } });
  const view = makeView({ document, store });
  const root = document.createElement("div");
  view.render(root);

  const rows = root.querySelectorAll("li");
  const productionRow = rows.find((row) => row.dataset.historyRow === "production:p1");
  const simulationRow = rows.find((row) => row.dataset.historyRow?.startsWith("simulation:s1"));
  assert.ok(productionRow, "production row must be present");
  assert.ok(simulationRow, "simulation row must be present");
  const productionBadge = productionRow.querySelector('[data-x]') ?? productionRow.children.find((c) => c._className?.includes("history-row-badge"));
  const simulationBadge = simulationRow.children.find((c) => c._className?.includes("history-row-badge"));
  assert.equal(productionBadge.textContent, "本番");
  assert.equal(simulationBadge.textContent, "シミュレーション");
  assert.notEqual(productionBadge.className, simulationBadge.className);
});

test("EventHistoryView collapses user text by default (a <details> element, not a raw open row), sanitized", () => {
  const document = createFakeDocument();
  const store = new EventHistoryStore();
  store.recordProduction(publishedOf(cheerEvent({ id: "p1", data: { bits: 10, message: "hello   world" } })));
  const view = makeView({ document, store });
  const root = document.createElement("div");
  view.render(root);

  const row = root.querySelector('[data-history-row="production:p1"]');
  const details = row.children.find((child) => child.tagName === "details");
  assert.ok(details, "a message field must render as a collapsible <details>, not inline in the row");
  const summary = details.children.find((child) => child.tagName === "summary");
  assert.equal(summary.textContent, "メッセージを表示", "the row itself must never show the raw message text directly");
  const body = details.children.find((child) => child.tagName === "p");
  assert.equal(body.textContent, "hello world", "control chars stripped and whitespace collapsed inside the (still collapsed-by-default) detail");
});

test("EventHistoryView trace drawer: a handled (executed) simulation trace renders matcher/plan/execution sections", async () => {
  const document = createFakeDocument();
  const store = new EventHistoryStore();
  const trigger = { id: "rule-1", enabled: true, eventTypes: ["cheer"], priority: 0, condition: { all: [{ field: "data.bits", operator: "gte", value: 1 }] }, actions: [{ id: "a1", kind: "template-speech", template: "ありがとう!" }] };
  const runner = {
    async execute(plan) {
      return { planId: plan.id, eventId: plan.eventId, triggerId: plan.triggerId, actionIndex: plan.actionIndex, kind: plan.kind, status: "executed", reason: null, text: "ありがとう!", context: plan.context, personaId: null, usedFallback: false, fallbackReason: null, error: null };
    },
  };
  const event = cheerEvent({ id: "evt-handled", data: { bits: 100 } });
  const result = await simulateStreamEvent({ event, triggers: [trigger], actionRunner: runner });
  const entry = store.recordSimulation({ event, result });
  assert.equal(entry.status, "handled");

  const view = makeView({ document, store });
  const root = document.createElement("div");
  view.render(root);
  root.querySelector(`[data-history-row-open="${entry.id}"]`).click();

  const drawerText = root.textContent;
  assert.match(drawerText, /Matcher/);
  assert.match(drawerText, /rule-1/);
  assert.match(drawerText, /Plan/);
  assert.match(drawerText, /テンプレ発話/);
  assert.match(drawerText, /Execution/);
  assert.match(drawerText, /処理済み|executed|ありがとう/, "execution result text should surface somewhere in the drawer");
});

test("EventHistoryView trace drawer: a skipped (no match) and a failed (validation error) trace render distinctly", async () => {
  const document = createFakeDocument();
  const store = new EventHistoryStore();

  const skippedEvent = cheerEvent({ id: "evt-skip", data: { bits: 1 } });
  const skippedResult = await simulateStreamEvent({ event: skippedEvent, triggers: [{ id: "rule-1", enabled: true, eventTypes: ["cheer"], condition: { all: [{ field: "data.bits", operator: "gte", value: 999 }] }, actions: [] }] });
  const skippedEntry = store.recordSimulation({ event: skippedEvent, result: skippedResult });
  assert.equal(skippedEntry.status, "skipped");

  const failedResult = await simulateStreamEvent({ event: { schemaVersion: 1, id: "evt-bad", kind: "cheer", timestamp: "not-a-date" }, triggers: [] });
  const failedEntry = store.recordSimulation({ event: { schemaVersion: 1, id: "evt-bad", kind: "cheer", timestamp: "not-a-date" }, result: failedResult });
  assert.equal(failedEntry.status, "failed");

  const view = makeView({ document, store });
  const root = document.createElement("div");

  view.render(root);
  root.querySelector(`[data-history-row-open="${skippedEntry.id}"]`).click();
  assert.match(root.textContent, /条件not-met|condition-not-met|スキップ/);
  root.querySelector("[data-trace-drawer-close]").click(); // back to the row list before opening the next one

  root.querySelector(`[data-history-row-open="${failedEntry.id}"]`).click();
  assert.match(root.textContent, /検証エラー/);
});

test("EventHistoryView: opening then closing the trace drawer restores focus to the row's own open button", () => {
  const document = createFakeDocument();
  const store = new EventHistoryStore();
  store.recordProduction(publishedOf(cheerEvent({ id: "p1" })));
  const view = makeView({ document, store });
  const root = document.createElement("div");
  view.render(root);

  const openButton = root.querySelector('[data-history-row-open="production:p1"]');
  openButton.click(); // #openTrace() already calls render() internally — do not re-render here, it would rebuild the drawer and discard the very focus-call count this test observes

  const closeButton = root.querySelector("[data-trace-drawer-close]");
  assert.ok(closeButton, "the drawer's close button must carry the data hook used for focus restoration");
  const focusCallsBeforeClose = closeButton._focusCalls;
  assert.ok(focusCallsBeforeClose >= 1, "opening the drawer must move focus into it (onto the close button)");

  closeButton.click();
  const reopenedButton = root.querySelector('[data-history-row-open="production:p1"]');
  assert.ok(reopenedButton._focusCalls >= 1, "closing the drawer must restore focus back to the row's own open button");
});

test("EventHistoryView: an aria-live region exists and announces new production events / clear results", async () => {
  const document = createFakeDocument();
  const store = new EventHistoryStore();
  const view = makeView({ document, store });
  const root = document.createElement("div");
  view.render(root);

  assert.equal(view.liveRegion.getAttribute("aria-live"), "polite");

  store.recordProduction(publishedOf(cheerEvent({ id: "p-live" })));
  view.render(root);
  root.querySelector("[data-history-clear-open]").click();
  root.querySelector("[data-history-clear-confirm]").click();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.match(view.liveRegion.textContent, /削除しました/);
});

test("EventHistoryView clear-history confirmation: scope selection (all/production/simulation/older-than) actually narrows what gets removed", () => {
  const document = createFakeDocument();
  const store = new EventHistoryStore();
  store.recordProduction(publishedOf(cheerEvent({ id: "p1" })));
  store.recordSimulation({ event: cheerEvent({ id: "s1" }), result: { ok: true, matches: [], results: [] } });
  const view = makeView({ document, store });
  const root = document.createElement("div");
  view.render(root);

  root.querySelector("[data-history-clear-open]").click();
  const scopeRadio = root.querySelector('[data-history-clear-scope="simulation"]');
  scopeRadio.checked = true;
  scopeRadio.dispatch("change");
  root.querySelector("[data-history-clear-confirm]").click();

  assert.deepEqual(store.list().map((entry) => entry.event.id), ["p1"], "only the simulation-scoped entry should have been removed");
});

// -------------------------------------------------------------------------------------------
// SECURITY: genuine secret scan — a token-shaped secret configured in connectors.*.apiKey must
// never appear in rendered history/trace/prompt-preview output, even when it happens to also be
// present inside a viewer's own (untrusted) message text.
// -------------------------------------------------------------------------------------------

test("SECURITY: a configured connector apiKey never appears in the rendered history row, trace drawer, or prompt preview — even when it is embedded inside a viewer's message", async () => {
  const document = createFakeDocument();
  const secret = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const getConfig = () => ({
    connectors: { main: { provider: "openai", apiKey: secret } },
    personas: [{ id: "persona-1", name: "Persona One", systemPrompt: "" }],
    eventTriggers: {},
  });
  const store = new EventHistoryStore();
  // The condition itself matches against `data.message` (not an empty `all: []`) so the matcher's
  // per-leaf trace records the raw secret-laden message as `detail.actual` — this is the exact
  // rendering path (trigger-trace-drawer.js's renderConditionDetails) that a prior review found
  // leaking the raw value unscrubbed; a trigger with no field conditions would never exercise it.
  const trigger = {
    id: "rule-1",
    enabled: true,
    eventTypes: ["cheer"],
    priority: 0,
    condition: { all: [{ field: "data.message", operator: "contains", value: "token" }] },
    actions: [{ id: "a1", kind: "ai-response", personaId: "persona-1" }],
  };
  const event = cheerEvent({ id: "evt-secret", data: { bits: 100, message: `look at this token: ${secret}` } });
  const result = await simulateStreamEvent({ event, triggers: [trigger] });
  const entry = store.recordSimulation({ event, result });
  assert.ok(result.matches.length > 0, "sanity: the trigger must actually match so a prompt preview plan exists");
  assert.ok(result.matches[0].details?.length > 0, "sanity: the match must carry per-leaf condition details, or this test would not exercise renderConditionDetails at all");

  const view = makeView({ document, store, getConfig });
  const root = document.createElement("div");
  view.render(root);
  const rowText = root.textContent;
  assert.ok(!rowText.includes(secret), "the raw secret must not leak into the collapsed row list, even before expanding the message detail");

  root.querySelector(`[data-history-row-open="${entry.id}"]`).click();
  const drawerText = root.textContent;
  assert.ok(!drawerText.includes(secret), "the raw secret must not leak into the trace drawer (normalized event / matcher condition details / prompt preview)");
  assert.match(drawerText, /USER \(task/, "sanity: the prompt preview section actually rendered");
  assert.match(drawerText, /実際値/, "sanity: the matcher's per-leaf condition-details ('実際値') section actually rendered, so it was genuinely exercised");
  assert.ok(drawerText.includes("sk-l") && drawerText.includes("…"), "the scrubbed/masked form of the secret should still be visible (proves scrubbing, not silent field removal)");
});
