// Tests for issue #95's Event Rule editor (src/twitch-ui/rules/*.js, src/twitch-ui/views/
// event-rules.js) — plain `.mjs` `node --test`, no bundling needed (same un-bundled browser JS
// convention every other src/*.js test in this repo already uses; see scripts/test/twitch-ui.test.mjs's
// own header comment). Defines its own small fake DOM (twitch-ui.test.mjs's own FakeElement only
// supports `[data-x]` PRESENCE selectors; this file's condition builder / reward selector / rule
// list all need `[data-config-path="exact-value"]` matching for validation-error navigation, so this
// harness extends that idea with a real (if minimal) attribute-VALUE matcher, plus <select>/<option>
// support neither #94 nor #62's own test harnesses needed).
//
// Covers this issue's own テスト list: event type別field候補, nested all/any編集, invalid
// type/range/reference, reward select/unknown/fetch error, cooldown/rate/aggregation/action round
// trip, delete/clone/focus restoration, validation error navigation, config save/reload後同等.
import assert from "node:assert/strict";
import test from "node:test";

import { createEventTriggerConfig } from "../../src/triggers/event-trigger-schema.js";
import { defaultLeaf, defaultValueForFieldOperator, fieldOptionsForEventTypes, renderConditionBuilder } from "../../src/twitch-ui/rules/condition-builder.js";
import { describeRewardsError, isUnknownReward, renderRewardSelector } from "../../src/twitch-ui/rules/reward-selector.js";
import { defaultAction, renderActionEditor, renderActionList } from "../../src/twitch-ui/rules/action-editor.js";
import { movePriority, orderRules, renderRuleList } from "../../src/twitch-ui/rules/rule-list.js";
import { rewardWarningsForRule, summarizeActions, summarizeBudget, summarizeCondition, summarizeValidation } from "../../src/twitch-ui/rules/rule-summary.js";
import { EventRulesView, collectRuleIssues, groupIssuesByRuleId, hasBlockingIssues } from "../../src/twitch-ui/views/event-rules.js";

// -------------------------------------------------------------------------------------------
// Fake DOM — createElement/append/replaceChildren/dataset/select+option/checkbox/focus, plus a
// real (minimal) `[data-attr]` / `[data-attr="value"]` querySelector matcher.
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
    this.multiple = false;
    this._value = "";
    this.title = "";
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
  get selectedOptions() {
    return this.children.filter((option) => option.selected);
  }
  setAttribute(name, value) { this._attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null; }
  addEventListener(type, listener) { (this._listeners[type] ??= []).push(listener); }
  removeEventListener(type, listener) { this._listeners[type] = (this._listeners[type] ?? []).filter((entry) => entry !== listener); }
  dispatch(type) { for (const listener of [...(this._listeners[type] ?? [])]) listener({ preventDefault() {}, target: this }); }
  click() { this.dispatch("click"); }
  focus() { this._focusCalls += 1; }
  scrollIntoView() {}
  appendChild(node) { node.ownerDocument = this.ownerDocument; node.parentNode = this; this.children.push(node); return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  prepend(node) { node.ownerDocument = this.ownerDocument; node.parentNode = this; this.children.unshift(node); }
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
  findButtonByText(text) {
    const stack = [...this.children];
    while (stack.length) {
      const node = stack.shift();
      if (node.tagName === "button" && node.textContent === text) return node;
      stack.push(...node.children);
    }
    return null;
  }
  findAllByTag(tag) {
    return this.querySelectorAll(tag);
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

if (typeof globalThis.CSS === "undefined") {
  // settings-navigation.js's navigateToIssue() calls `CSS.escape` — a real-browser-only global.
  // None of this file's rule ids/paths contain characters that need real CSS ident-escaping (only
  // letters/digits/`.`/`-`), so identity is a faithful-enough polyfill for this test's purposes.
  globalThis.CSS = { escape: (value) => String(value) };
}

function findInputByLabelText(root, text) {
  return [...root.querySelectorAll("input")].find((input) => input.parentNode?.textContent?.includes(text));
}

// -------------------------------------------------------------------------------------------
// condition-builder.js
// -------------------------------------------------------------------------------------------

test("fieldOptionsForEventTypes: narrows to only fields valid for the given event type(s)", () => {
  const cheerFields = fieldOptionsForEventTypes(["cheer"]).map((entry) => entry.key);
  assert.ok(cheerFields.includes("data.bits"));
  assert.ok(!cheerFields.includes("data.rewardId"), "cheer must not offer a reward-redemption-only field");
  assert.ok(cheerFields.includes("actor.isAnonymous"), "base fields apply to every kind");

  const rewardFields = fieldOptionsForEventTypes(["reward-redemption"]).map((entry) => entry.key);
  assert.ok(rewardFields.includes("data.rewardId"));
  assert.ok(!rewardFields.includes("data.bits"));

  const multiKind = fieldOptionsForEventTypes(["cheer", "reward-redemption"]).map((entry) => entry.key);
  assert.ok(multiKind.includes("data.bits") && multiKind.includes("data.rewardId"), "a multi-kind trigger offers the union of both kinds' fields");

  assert.deepEqual(fieldOptionsForEventTypes([]), []);
});

test("defaultValueForFieldOperator / defaultLeaf: type-driven defaults, not per-field hardcoding", () => {
  assert.equal(defaultValueForFieldOperator("data.bits", "eq"), 0);
  assert.deepEqual(defaultValueForFieldOperator("data.bits", "in"), [0]);
  assert.deepEqual(defaultValueForFieldOperator("data.bits", "between"), [0, 0]);
  assert.equal(defaultValueForFieldOperator("actor.isAnonymous", "eq"), false);
  assert.equal(defaultValueForFieldOperator("data.rewardTitle", "eq"), "");
  assert.deepEqual(defaultValueForFieldOperator("data.rewardTitle", "in"), [""]);

  const leaf = defaultLeaf(["cheer"]);
  assert.equal(leaf.field, "actor.isAnonymous"); // registry-order first field valid for "cheer"
  assert.equal(leaf.operator, "eq");
  assert.deepEqual(defaultLeaf([]), { field: null, operator: null, value: "" });
});

test("renderConditionBuilder: nested all/any editing — add leaf, add nested group, swap all<->any, remove", () => {
  const document = createFakeDocument();
  const condition = { all: [] };
  const root = document.createElement("div");
  const rerender = () => renderConditionBuilder(root, condition, { eventTypes: ["cheer"], path: "eventTriggers.r1.condition", onStructuralChange: rerender }, document);
  rerender();

  root.findButtonByText("＋ 条件を追加").click();
  assert.equal(condition.all.length, 1);
  assert.equal(condition.all[0].field, "actor.isAnonymous");

  root.findButtonByText("＋ グループを追加").click();
  assert.equal(condition.all.length, 2);
  assert.deepEqual(condition.all[1], { all: [] });

  const groupSelects = root.querySelectorAll('[data-config-path="eventTriggers.r1.condition.all.1"]');
  assert.equal(groupSelects.length, 1);
  groupSelects[0].value = "any";
  groupSelects[0].dispatch("change");
  assert.deepEqual(condition.all[1], { any: [] });

  root.findAllByTag("button").find((button) => button.textContent === "条件を削除").click();
  assert.equal(condition.all.length, 1);
  assert.deepEqual(condition.all[0], { any: [] }, "removing index 0 must leave the nested group, not the leaf");

  const removeGroupButtons = root.findAllByTag("button").filter((button) => button.textContent === "グループを削除");
  assert.equal(removeGroupButtons.length, 1, "the root group itself must not offer a self-remove button");
  removeGroupButtons[0].click();
  assert.deepEqual(condition, { all: [] });
});

test("renderConditionBuilder: field select narrows by eventTypes and editing a value control mutates the leaf in place without a re-render", () => {
  const document = createFakeDocument();
  const condition = { all: [{ field: "data.bits", operator: "gte", value: 100 }] };
  const root = document.createElement("div");
  let renders = 0;
  renderConditionBuilder(root, condition, { eventTypes: ["cheer"], path: "eventTriggers.r1.condition", onStructuralChange: () => { renders += 1; } }, document);

  const fieldSelect = root.querySelector('[data-config-path="eventTriggers.r1.condition.all.0.field"]');
  const fieldOptionValues = fieldSelect.children.map((option) => option.value);
  assert.ok(!fieldOptionValues.includes("data.rewardId"));

  const valueInput = root.querySelector('[data-config-path="eventTriggers.r1.condition.all.0.value"]');
  valueInput.value = "250";
  valueInput.dispatch("input");
  assert.equal(condition.all[0].value, 250);
  assert.equal(renders, 0, "a plain value edit must mutate in place, not trigger a structural re-render");
});

// -------------------------------------------------------------------------------------------
// reward-selector.js
// -------------------------------------------------------------------------------------------

test("reward-selector: renders a known reward selected, and never resets an unknown/stale reward id", () => {
  const document = createFakeDocument();
  const rewardsState = { status: "loaded", rewards: [{ id: "r1", title: "配信者に一言", cost: 500, isEnabled: true, isPaused: false }] };

  const knownRoot = document.createElement("div");
  renderRewardSelector(knownRoot, { value: "r1", rewardsState }, {}, document);
  assert.equal(knownRoot.querySelector("select").value, "r1");

  assert.equal(isUnknownReward("deleted-reward", rewardsState), true);
  assert.equal(isUnknownReward("r1", rewardsState), false);
  assert.equal(isUnknownReward("", rewardsState), false);

  const unknownRoot = document.createElement("div");
  renderRewardSelector(unknownRoot, { value: "deleted-reward", rewardsState }, {}, document);
  const unknownSelect = unknownRoot.querySelector("select");
  assert.equal(unknownSelect.value, "deleted-reward", "an unknown/deleted reward id must stay selected, never silently reset");
  const optionTexts = unknownSelect.children.map((option) => option.textContent).join(" ");
  assert.ok(optionTexts.includes("不明なreward"));
  assert.ok(unknownRoot.textContent.includes("現在の一覧に存在しません"), "a visible warning badge must accompany the kept reference");
});

test("reward-selector: fetch error states surface a specific, actionable message and a manual fallback input, never a silently-empty list", () => {
  const document = createFakeDocument();
  for (const errorCode of ["missing_scope", "wrong_broadcaster", "unauthorized", "network", "rate_limited", "server", "unknown"]) {
    const root = document.createElement("div");
    renderRewardSelector(root, { value: "r9", rewardsState: { status: "error", errorCode, rewards: [] } }, {}, document);
    assert.equal(root.querySelector("select"), null, "an error state must not render the normal dropdown");
    const fallback = root.querySelector("input");
    assert.ok(fallback, `${errorCode} must offer a manual fallback input`);
    assert.equal(fallback.value, "r9", "the fallback input must keep the previously-saved value");
    assert.equal(root.textContent.includes(describeRewardsError(errorCode)), true);
  }
});

test("reward-selector: loading state disables the select and shows a loading placeholder, refresh button always present", () => {
  const document = createFakeDocument();
  const root = document.createElement("div");
  renderRewardSelector(root, { value: "", rewardsState: { status: "loading", rewards: [] } }, {}, document);
  const select = root.querySelector("select");
  assert.equal(select.disabled, true);
  assert.ok(root.findButtonByText("取得中…"));
});

// -------------------------------------------------------------------------------------------
// action-editor.js
// -------------------------------------------------------------------------------------------

test("action-editor: kind switch shows the right fields (ai-response: persona, template-speech: template) and round-trips edits", () => {
  const document = createFakeDocument();
  const action = defaultAction("template-speech");
  const root = document.createElement("div");
  let structuralChanges = 0;
  renderActionEditor(root, action, { path: "eventTriggers.r1.actions.0", personaOptions: [{ value: "p1", label: "Persona 1" }], onStructuralChange: () => { structuralChanges += 1; }, onRemove: () => {} }, document);
  assert.ok(root.querySelector('[data-config-path="eventTriggers.r1.actions.0.template"]'));
  assert.equal(root.querySelector('[data-config-path="eventTriggers.r1.actions.0.personaId"]'), null);

  const kindSelect = root.querySelector('[data-config-path="eventTriggers.r1.actions.0.kind"]');
  kindSelect.value = "ai-response";
  kindSelect.dispatch("change");
  assert.equal(action.kind, "ai-response");
  assert.equal(structuralChanges, 1);

  renderActionEditor(root, action, { path: "eventTriggers.r1.actions.0", personaOptions: [{ value: "p1", label: "Persona 1" }], onStructuralChange: () => {}, onRemove: () => {} }, document);
  const personaSelect = root.querySelector('[data-config-path="eventTriggers.r1.actions.0.personaId"]');
  assert.ok(personaSelect);
  personaSelect.value = "p1";
  personaSelect.dispatch("change");
  assert.equal(action.personaId, "p1");

  const speakCb = root.querySelector('[data-config-path="eventTriggers.r1.actions.0.speak"]');
  speakCb.checked = false;
  speakCb.dispatch("change");
  assert.equal(action.speak, false);
});

test("action-editor: renderActionList add/remove", () => {
  const document = createFakeDocument();
  const actions = [];
  const root = document.createElement("div");
  const rerender = () => renderActionList(root, actions, { path: "eventTriggers.r1.actions", personaOptions: [], onStructuralChange: rerender }, document);
  rerender();
  root.findButtonByText("＋ テンプレ発話actionを追加").click();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "template-speech");
  root.findButtonByText("＋ AI応答actionを追加").click();
  assert.equal(actions.length, 2);
  root.findAllByTag("button").find((button) => button.textContent === "actionを削除").click();
  assert.equal(actions.length, 1);
});

// -------------------------------------------------------------------------------------------
// rule-list.js: orderRules / movePriority (pure) + create/clone/delete/reorder wiring
// -------------------------------------------------------------------------------------------

test("orderRules: sorts by priority descending, ties broken by original insertion order (matches event-trigger-matcher.js)", () => {
  const rulesById = { a: { priority: 0 }, b: { priority: 5 }, c: { priority: 5 }, d: { priority: -1 } };
  assert.deepEqual(orderRules(rulesById).map((entry) => entry.id), ["b", "c", "a", "d"]);
});

test("movePriority: swaps priority with a differently-prioritized neighbor, bumps past a tied one", () => {
  const rulesById = { a: { priority: 5 }, b: { priority: 0 } };
  assert.equal(movePriority(rulesById, "b", "up"), true);
  assert.deepEqual([rulesById.a.priority, rulesById.b.priority], [0, 5]);

  const tied = { a: { priority: 3 }, b: { priority: 3 } };
  movePriority(tied, "b", "up");
  assert.equal(tied.b.priority > tied.a.priority, true);

  assert.equal(movePriority({ a: { priority: 0 } }, "a", "up"), false, "no neighbor above the top entry");
  assert.equal(movePriority({ a: { priority: 0 } }, "missing", "up"), false);
});

test("renderRuleList: enabled/name/event/condition/priority/budget/action/validation columns + create/clone/delete/reorder callbacks", () => {
  const document = createFakeDocument();
  const rulesById = {
    "rule-1": { id: "rule-1", name: "テスト", enabled: true, eventTypes: ["cheer"], priority: 0, condition: { all: [{ field: "data.bits", operator: "gte", value: 100 }] }, cooldown: { cooldownMs: 30000 }, actions: [{ kind: "template-speech", template: "hi" }] },
  };
  const calls = [];
  const root = document.createElement("div");
  renderRuleList(root, { rulesById, selectedId: null, rewardsState: { status: "idle", rewards: [] }, issuesByRuleId: {} }, {
    onSelect: (id) => calls.push(["select", id]),
    onCreate: () => calls.push(["create"]),
    onClone: (id) => calls.push(["clone", id]),
    onDelete: (id) => calls.push(["delete", id]),
    onMoveUp: (id) => calls.push(["up", id]),
    onMoveDown: (id) => calls.push(["down", id]),
    onToggleEnabled: (id, enabled) => calls.push(["toggle", id, enabled]),
    onTest: (id) => calls.push(["test", id]),
  }, document);

  const row = root.querySelector('[data-rule-id="rule-1"]');
  assert.ok(row, "row must carry data-rule-id");
  assert.ok(row.textContent.includes("テスト (rule-1)"));
  assert.ok(row.textContent.includes("data.bits gte 100"));
  assert.ok(row.textContent.includes("CD 30s"));
  assert.ok(row.textContent.includes("テンプレ発話"));

  root.findButtonByText("＋ 新規Ruleを追加").click();
  row.findButtonByText("複製").click();
  row.findButtonByText("削除").click();
  row.findButtonByText("テスト実行").click();
  row.findButtonByText("↑").click();
  row.findButtonByText("↓").click();
  assert.deepEqual(calls, [["create"], ["clone", "rule-1"], ["delete", "rule-1"], ["test", "rule-1"], ["up", "rule-1"], ["down", "rule-1"]]);
});

// -------------------------------------------------------------------------------------------
// rule-summary.js
// -------------------------------------------------------------------------------------------

test("rule-summary: condition/budget/action summaries and validation counts", () => {
  assert.equal(summarizeCondition({ all: [{ field: "data.bits", operator: "gte", value: 100 }, { field: "actor.isAnonymous", operator: "eq", value: false }] }), "data.bits gte 100 かつ actor.isAnonymous eq false");
  assert.equal(summarizeBudget({}), "-");
  assert.equal(summarizeBudget({ cooldown: { cooldownMs: 30000, keyBy: ["actor"] }, rateLimit: { windowMs: 60000, maxActions: 5, overflowPolicy: "drop" } }), "CD 30s/actor / RL 5/60s→drop");
  assert.equal(summarizeActions({ actions: [{ kind: "ai-response", personaId: "p1" }, { kind: "template-speech" }] }), "AI:p1, テンプレ発話");
  assert.deepEqual(summarizeValidation([{ severity: "error" }, { severity: "warning" }, { severity: "warning" }]), { errors: 1, warnings: 2 });
});

test("rewardWarningsForRule: walks nested all/any for data.rewardId leaves and flags ids missing from the fetched list", () => {
  const rule = { condition: { all: [{ any: [{ field: "data.rewardId", operator: "eq", value: "gone" }, { field: "data.rewardId", operator: "in", value: ["r1", "also-gone"] }] }] } };
  const rewardsState = { status: "loaded", rewards: [{ id: "r1", title: "x", cost: 1, isEnabled: true, isPaused: false }] };
  assert.deepEqual(rewardWarningsForRule(rule, rewardsState).sort(), ["also-gone", "gone"]);
});

// -------------------------------------------------------------------------------------------
// views/event-rules.js: collectRuleIssues (invalid type/range/reference)
// -------------------------------------------------------------------------------------------

test("collectRuleIssues: flags an unregistered field, a wrong-kind field, an operator/type mismatch, and out-of-range cooldown/rateLimit", () => {
  const draft = {
    "bad-field": createEventTriggerConfig({ id: "bad-field", eventTypes: ["cheer"], condition: { all: [{ field: "not.a.real.field", operator: "eq", value: 1 }] } }),
    "wrong-kind": createEventTriggerConfig({ id: "wrong-kind", eventTypes: ["cheer"], condition: { all: [{ field: "data.rewardId", operator: "eq", value: "r1" }] } }),
    "bad-type": createEventTriggerConfig({ id: "bad-type", eventTypes: ["cheer"], condition: { all: [{ field: "data.bits", operator: "eq", value: "not-a-number" }] } }),
    "bad-cooldown": { ...createEventTriggerConfig({ id: "bad-cooldown", eventTypes: ["cheer"], condition: { all: [{ field: "data.bits", operator: "gte", value: 1 }] } }), cooldown: { cooldownMs: -5 } },
    "bad-ratelimit": { ...createEventTriggerConfig({ id: "bad-ratelimit", eventTypes: ["cheer"], condition: { all: [{ field: "data.bits", operator: "gte", value: 1 }] } }), rateLimit: { windowMs: 0, maxActions: 0, overflowPolicy: "not-a-policy" } },
    "bad-persona-ref": { ...createEventTriggerConfig({ id: "bad-persona-ref", eventTypes: ["cheer"], condition: { all: [{ field: "data.bits", operator: "gte", value: 1 }] } }), actions: [{ id: "a1", kind: "ai-response", personaId: "ghost-persona" }] },
  };
  const issues = collectRuleIssues(draft, { personaIds: ["real-persona"] });
  const byRule = groupIssuesByRuleId(issues);
  assert.ok(byRule["bad-field"].some((entry) => entry.code === "field.unknown"));
  assert.ok(byRule["wrong-kind"].some((entry) => entry.code === "field.notApplicable"));
  assert.ok(byRule["bad-type"].some((entry) => entry.code === "type.number"));
  assert.ok(byRule["bad-cooldown"].some((entry) => entry.code === "type.positiveInteger" && entry.path.includes("cooldownMs")));
  assert.ok(byRule["bad-ratelimit"].some((entry) => entry.path.includes("windowMs")));
  assert.ok(byRule["bad-ratelimit"].some((entry) => entry.path.includes("maxActions")));
  assert.ok(byRule["bad-ratelimit"].some((entry) => entry.path.includes("overflowPolicy")));
  const personaIssue = byRule["bad-persona-ref"].find((entry) => entry.code === "reference.missing");
  assert.ok(personaIssue);
  assert.equal(personaIssue.severity, "warning", "an unresolved persona reference warns but does not block save");
  assert.equal(hasBlockingIssues(issues), true);

  const clean = { ok1: createEventTriggerConfig({ id: "ok1", eventTypes: ["cheer"], condition: { all: [{ field: "data.bits", operator: "gte", value: 100 }] } }) };
  assert.equal(hasBlockingIssues(collectRuleIssues(clean, { personaIds: [] })), false);
});

// -------------------------------------------------------------------------------------------
// EventRulesView: full controller — create/clone/delete/focus restoration, round trip,
// validation-error navigation, save/reload equivalence.
// -------------------------------------------------------------------------------------------

function makeConfig(eventTriggers = {}) {
  return { personas: [{ id: "persona-1", name: "Persona One" }], eventTriggers };
}

test("EventRulesView: create -> clone -> delete, with focus restored to the expected element each time", () => {
  const document = createFakeDocument();
  let config = makeConfig();
  const view = new EventRulesView({ document, getConfig: () => config, onApplyConfig: async (next) => { config = next; } });
  const root = document.createElement("div");
  view.render(root);

  root.findButtonByText("＋ 新規Ruleを追加").click();
  assert.deepEqual(Object.keys(view.draft), ["rule-1"]);
  assert.equal(view.selectedRuleId, "rule-1");
  const nameField = root.querySelector('[data-config-path="eventTriggers.rule-1.name"]');
  assert.ok(nameField, "the new rule's editor must be showing");
  assert.equal(nameField._focusCalls, 1, "focus must move to the new rule's name field");

  root.findButtonByText("← 一覧へ戻る").click();
  root.querySelector('[data-rule-id="rule-1"]').findButtonByText("複製").click();
  assert.deepEqual(Object.keys(view.draft).sort(), ["rule-1", "rule-1-copy"]);
  assert.equal(view.selectedRuleId, "rule-1-copy");
  const clonedNameField = root.querySelector('[data-config-path="eventTriggers.rule-1-copy.name"]');
  assert.equal(clonedNameField._focusCalls, 1);

  root.findButtonByText("← 一覧へ戻る").click();
  root.querySelector('[data-rule-id="rule-1-copy"]').findButtonByText("削除").click();
  assert.deepEqual(Object.keys(view.draft), ["rule-1"]);
  const addButton = root.querySelector("[data-rule-list-add]");
  assert.equal(addButton._focusCalls, 1, "focus must return to the list's add button after delete");
});

test("EventRulesView: cooldown/rateLimit/aggregation/action round trip through save -> getConfig -> reload, going through the same onApplyConfig every settings section uses", async () => {
  const document = createFakeDocument();
  let config = makeConfig({
    "rule-1": createEventTriggerConfig({ id: "rule-1", eventTypes: ["cheer"], condition: { all: [{ field: "data.bits", operator: "gte", value: 100 }] } }),
  });
  const applied = [];
  const view = new EventRulesView({ document, getConfig: () => config, onApplyConfig: async (next) => { applied.push(next); config = next; } });
  const root = document.createElement("div");
  view.render(root);
  root.querySelector('[data-rule-id="rule-1"]').findButtonByText("rule-1").click();

  const cooldownEnableCb = findInputByLabelText(root, "cooldownを設定する");
  cooldownEnableCb.checked = true;
  cooldownEnableCb.dispatch("change");
  const cooldownMsField = root.querySelector('[data-config-path="eventTriggers.rule-1.cooldown.cooldownMs"]');
  cooldownMsField.value = "45";
  cooldownMsField.dispatch("input");
  const consumeOnField = root.querySelector('[data-config-path="eventTriggers.rule-1.cooldown.consumeOn"]');
  consumeOnField.value = "started";
  consumeOnField.dispatch("change");
  const actorKeyByCb = root.querySelectorAll('[data-config-path="eventTriggers.rule-1.cooldown.keyBy"]')[0];
  actorKeyByCb.checked = true;
  actorKeyByCb.dispatch("change");

  const rlEnableCb = findInputByLabelText(root, "rate limitを設定する");
  rlEnableCb.checked = true;
  rlEnableCb.dispatch("change");
  root.querySelector('[data-config-path="eventTriggers.rule-1.rateLimit.windowMs"]').value = "60";
  root.querySelector('[data-config-path="eventTriggers.rule-1.rateLimit.windowMs"]').dispatch("input");
  root.querySelector('[data-config-path="eventTriggers.rule-1.rateLimit.maxActions"]').value = "3";
  root.querySelector('[data-config-path="eventTriggers.rule-1.rateLimit.maxActions"]').dispatch("input");
  root.querySelector('[data-config-path="eventTriggers.rule-1.rateLimit.overflowPolicy"]').value = "aggregate";
  root.querySelector('[data-config-path="eventTriggers.rule-1.rateLimit.overflowPolicy"]').dispatch("change");

  const aggEnableCb = findInputByLabelText(root, "集約windowを設定する");
  aggEnableCb.checked = true;
  aggEnableCb.dispatch("change");
  root.querySelector('[data-config-path="eventTriggers.rule-1.aggregation.windowMs"]').value = "10";
  root.querySelector('[data-config-path="eventTriggers.rule-1.aggregation.windowMs"]').dispatch("input");

  root.findButtonByText("＋ テンプレ発話actionを追加").click();
  const templateField = root.querySelector('[data-config-path="eventTriggers.rule-1.actions.0.template"]');
  templateField.value = "ありがとう {{actor.displayName}}!";
  templateField.dispatch("input");

  await view.save();

  assert.equal(applied.length, 1);
  const savedRule = applied[0].eventTriggers["rule-1"];
  assert.deepEqual(savedRule.cooldown, { cooldownMs: 45000, consumeOn: "started", keyBy: ["actor"] });
  assert.deepEqual(savedRule.rateLimit, { windowMs: 60000, maxActions: 3, overflowPolicy: "aggregate" });
  assert.deepEqual(savedRule.aggregation, { windowMs: 10000, maxBatchSize: 20 });
  assert.equal(savedRule.actions[0].template, "ありがとう {{actor.displayName}}!");
  assert.equal(view.saveStatus.kind, "saved");

  // "config save/reload後同等" — discard-and-reload from the (now updated) config source must
  // reproduce the exact same draft shape that was just saved.
  view.resetDraft();
  assert.deepEqual(view.draft["rule-1"].cooldown, savedRule.cooldown);
  assert.deepEqual(view.draft["rule-1"].rateLimit, savedRule.rateLimit);
  assert.deepEqual(view.draft["rule-1"].aggregation, savedRule.aggregation);
  assert.deepEqual(view.draft["rule-1"].actions, savedRule.actions);
});

test("EventRulesView: save is blocked by a blocking validation issue and never calls onApplyConfig", async () => {
  const document = createFakeDocument();
  const config = makeConfig({
    "rule-1": createEventTriggerConfig({ id: "rule-1", eventTypes: ["cheer"], condition: { all: [{ field: "data.rewardId", operator: "eq", value: "x" }] } }),
  });
  let applyCalls = 0;
  const view = new EventRulesView({ document, getConfig: () => config, onApplyConfig: async () => { applyCalls += 1; } });
  const root = document.createElement("div");
  view.render(root);
  await view.save();
  assert.equal(applyCalls, 0);
  assert.equal(view.saveStatus.kind, "error");
  assert.ok(view.lastIssues.some((entry) => entry.code === "field.notApplicable"));
});

test("EventRulesView: a validation-error button navigates to the offending rule and focuses/marks the field invalid", async () => {
  const document = createFakeDocument();
  const config = makeConfig({
    "rule-1": createEventTriggerConfig({ id: "rule-1", eventTypes: ["cheer"], condition: { all: [{ field: "data.bits", operator: "eq", value: "not-a-number" }] } }),
  });
  const view = new EventRulesView({ document, getConfig: () => config, onApplyConfig: async () => {} });
  const root = document.createElement("div");
  view.render(root);
  assert.equal(view.selectedRuleId, null, "starts on the list view");

  const issueButton = root.findAllByTag("button").find((button) => button.textContent.includes("value must be a number"));
  assert.ok(issueButton, "an error must be listed in the issues panel");
  issueButton.click();

  assert.equal(view.selectedRuleId, "rule-1", "clicking the issue must switch to that rule's editor");
  const target = root.querySelector('[data-config-path="eventTriggers.rule-1.condition.all.0.value"]');
  assert.ok(target, "the offending field must exist in the freshly-rendered editor");
  assert.equal(target._focusCalls, 1, "the offending field must receive focus");
  assert.equal(target.getAttribute("aria-invalid"), "true");
});

test("EventRulesView: refreshRewards surfaces a Helix fetch error via rewardsState, and reward warnings never strip the saved reference", async () => {
  const document = createFakeDocument();
  const config = makeConfig({
    "rule-1": createEventTriggerConfig({ id: "rule-1", eventTypes: ["reward-redemption"], condition: { all: [{ field: "data.rewardId", operator: "eq", value: "gone-reward" }] } }),
  });
  const client = { rewardsList: async () => ({ ok: false, errorCode: "missing_scope", message: "missing scope" }) };
  const view = new EventRulesView({ document, getConfig: () => config, onApplyConfig: async () => {}, client });
  const root = document.createElement("div");
  view.render(root); // triggers the initial reward fetch
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.rewardsState.status, "error");
  assert.equal(view.rewardsState.errorCode, "missing_scope");

  // Saving must still be possible (an unresolvable reward reference is a WARNING badge, not a
  // save-blocking error) and must keep the reward id exactly as authored.
  const issues = collectRuleIssues(view.draft, { personaIds: [] });
  assert.equal(hasBlockingIssues(issues), false);
  assert.equal(view.draft["rule-1"].condition.all[0].value, "gone-reward");
});

test("EventRulesView: an invalid rename (empty or duplicate id) is rejected and the original id is kept", () => {
  const document = createFakeDocument();
  const config = makeConfig({
    "rule-1": createEventTriggerConfig({ id: "rule-1", eventTypes: ["cheer"], condition: { all: [] } }),
    "rule-2": createEventTriggerConfig({ id: "rule-2", eventTypes: ["cheer"], condition: { all: [] } }),
  });
  const view = new EventRulesView({ document, getConfig: () => config, onApplyConfig: async () => {} });
  const root = document.createElement("div");
  view.render(root);
  root.querySelector('[data-rule-id="rule-1"]').findButtonByText("rule-1").click();

  const idInput = root.querySelector('[data-config-path="eventTriggers.rule-1.id"]');
  idInput.value = "rule-2";
  idInput.dispatch("change");
  assert.deepEqual(Object.keys(view.draft).sort(), ["rule-1", "rule-2"]);
  assert.equal(view.selectedRuleId, "rule-1", "a duplicate-id rename must be rejected, keeping the original id");
});

// -------------------------------------------------------------------------------------------
// "test this rule" fixture button — issue #93's REAL stream-event-simulator.js
// (buildFixtureEvent/matchEvent/planActions), never a synthetic shortcut.
// -------------------------------------------------------------------------------------------

test("EventRulesView: \"test this rule\" runs the REAL matcher/planner against a fixture and shows a rendered template preview, both from the rule-editor's test section and the rule-list's quick-test button", async () => {
  const document = createFakeDocument();
  const config = makeConfig({
    "rule-1": {
      ...createEventTriggerConfig({ id: "rule-1", eventTypes: ["cheer"], condition: { all: [{ field: "data.bits", operator: "gte", value: 50 }] } }),
      actions: [{ id: "a1", kind: "template-speech", template: "{{actor.displayName}} さん、{{data.bits}} bitsありがとう!" }],
    },
  });
  const view = new EventRulesView({ document, getConfig: () => config, onApplyConfig: async () => {} });
  const root = document.createElement("div");
  view.render(root);
  root.querySelector('[data-rule-id="rule-1"]').findButtonByText("rule-1").click();

  const fixtureSelect = root.querySelector("select[type]") ?? [...root.querySelectorAll("select")].find((select) => select.children.some((option) => option.value === "cheer"));
  assert.ok(fixtureSelect, "the fixture select must offer this rule's own event type");
  root.findButtonByText("実行").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(view.testResults["rule-1"], "a test result must be recorded for this rule");
  assert.equal(view.testResults["rule-1"].matches.length, 1, "the cheer fixture (100 bits) must match a >=50 bits condition");
  assert.ok(root.textContent.includes("マッチしました"));
  assert.ok(root.textContent.includes("bitsありがとう"), "the template-speech plan must be pre-rendered against the real fixture event, not just named");
  assert.equal(root.textContent.includes("実際のAI呼び出しはテストでは行いません"), false, "this rule only has a template-speech action, no AI call text should appear");

  // The rule-list's own per-row quick-test button reaches the SAME test path with a sensible
  // default fixture (the rule's own first eventType) without requiring the operator to open the
  // editor first.
  root.findButtonByText("← 一覧へ戻る").click();
  view.testResults = {};
  root.querySelector('[data-rule-id="rule-1"]').findButtonByText("テスト実行").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(view.testResults["rule-1"], "the list's quick-test button must also produce a result");
  assert.equal(view.selectedRuleId, "rule-1", "quick-test opens the rule's own editor so the result is visible");
});
