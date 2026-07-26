// Tests for src/ui/console-view.js's persona list keyed update.
//
// The periodic console refresh re-renders the persona list every couple of seconds. It used to
// `replaceChildren()` the whole list, which detached the checkbox the user was interacting with
// ("Node is detached from document" in the browser E2E run). renderPersonas() now reuses the
// existing `li[data-persona-id]` node per persona, so these tests pin the properties that fix
// depends on: node identity across refreshes, in-place state updates, ordering, add/remove, the
// empty-state placeholder, and that reused nodes call the *current* actions object.
//
// No jsdom dependency exists in this repo (see settings-a11y.test.mjs / twitch-ui.test.mjs and
// their hand-rolled fake-element convention), so this file defines a small fake `document` that
// supports exactly what console-view.js touches: children, dataset, class/descendant
// querySelector(All), insertBefore/remove, and a minimal innerHTML parser.

import assert from "node:assert/strict";
import test from "node:test";
import { ConsoleView } from "../../src/ui/console-view.js";

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.style = {};
    this.textContent = "";
    this.title = "";
    this.type = "";
    this.checked = false;
    this.listeners = {};
  }
  /** Supports only the two literal templates console-view.js assigns to a persona list node. */
  set innerHTML(html) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const [, tag, className, text] of html.matchAll(/<(\w+)(?:\s+class="([^"]*)")?>([^<]*)<\/\1>/g)) {
      const child = new FakeElement(tag, this.ownerDocument);
      child.className = className ?? "";
      child.textContent = text;
      this.appendChild(child);
    }
  }
  get innerHTML() { return ""; }
  appendChild(node) {
    const child = typeof node === "string" ? Object.assign(new FakeElement("#text", this.ownerDocument), { textContent: node }) : node;
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(node, reference) {
    node.remove();
    node.parentNode = this;
    const at = reference ? this.children.indexOf(reference) : -1;
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  dispatch(type) { for (const listener of this.listeners[type] ?? []) listener({ preventDefault() {} }); }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  matches(selector) {
    const [, tag, className, dataAttr] = /^([a-z]*)(?:\.([\w-]+))?(?:\[data-([a-z-]+)\])?$/i.exec(selector) ?? [];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (className && !this.className.split(/\s+/).includes(className)) return false;
    if (dataAttr) {
      const key = dataAttr.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (!Object.prototype.hasOwnProperty.call(this.dataset, key)) return false;
    }
    return Boolean(tag || className || dataAttr);
  }
  querySelectorAll(selector) {
    let matched = [this];
    for (const part of selector.trim().split(/\s+/)) {
      matched = matched.flatMap((node) => node.descendants().filter((descendant) => descendant.matches(part)));
    }
    return matched;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function createFakeDocument() {
  const document = {
    createElement: (tag) => new FakeElement(tag, document),
    querySelector: (selector) => document.byId.get(selector) ?? null,
    byId: new Map(),
  };
  for (const id of ["#persona-list", "#persona-summary", "#tally"]) {
    document.byId.set(id, new FakeElement(id === "#persona-list" ? "ul" : "div", document));
  }
  return document;
}

function persona(id, overrides = {}) {
  return { id, name: `名前:${id}`, detail: `詳細:${id}`, state: "ready", enabled: true, dotColor: "#123456", ...overrides };
}

function noopActions() {
  return { setPersonaEnabled() {}, firePersona() {} };
}

function personaIds(list) {
  return list.querySelectorAll("li[data-persona-id]").map((item) => item.dataset.personaId);
}

function setup(initialPlaceholder = true) {
  const document = createFakeDocument();
  const list = document.byId.get("#persona-list");
  if (initialPlaceholder) list.innerHTML = `<li class="detail">設定を読み込むと表示されます</li>`;
  return { document, list, view: new ConsoleView(document), summary: document.byId.get("#persona-summary") };
}

test("renderPersonas renders one keyed li per persona and replaces the placeholder", () => {
  const { view, list, summary } = setup();
  view.renderPersonas([persona("a"), persona("b", { enabled: false, state: "off" })], noopActions());

  assert.deepEqual(personaIds(list), ["a", "b"]);
  assert.equal(list.children[0].querySelector(".name").textContent, "名前:a");
  assert.equal(list.children[0].querySelector(".detail").textContent, "詳細:a");
  assert.equal(list.children[0].querySelector(".persona-dot").className, "persona-dot is-ready");
  assert.equal(list.children[0].querySelector(".persona-dot").style.background, "#123456");
  assert.equal(list.children[0].querySelector(".switch input").checked, true);
  assert.equal(list.children[1].querySelector(".switch input").checked, false);
  assert.equal(list.children[1].querySelector(".persona-dot").className, "persona-dot is-off");
  assert.equal(summary.textContent, "有効 1/2");
});

test("an unchanged refresh keeps the exact same li and input nodes attached", () => {
  const { view, list } = setup();
  view.renderPersonas([persona("a"), persona("b")], noopActions());
  const [firstLi, secondLi] = list.children;
  const firstInput = firstLi.querySelector(".switch input");

  view.renderPersonas([persona("a"), persona("b")], noopActions());

  assert.equal(list.children[0], firstLi, "persona li must be reused across refreshes");
  assert.equal(list.children[1], secondLi);
  assert.equal(list.children[0].querySelector(".switch input"), firstInput, "checkbox node must survive a refresh");
  assert.equal(firstLi.parentNode, list, "reused li must stay attached to the list");
  assert.equal(firstInput.parentNode.parentNode, firstLi);
});

test("a refresh updates persona state in place without recreating nodes", () => {
  const { view, list, summary } = setup();
  view.renderPersonas([persona("a")], noopActions());
  const li = list.children[0];

  view.renderPersonas([persona("a", { name: "改名", detail: "更新", state: "speaking", enabled: false, dotColor: "#abcdef" })], noopActions());

  assert.equal(list.children[0], li);
  assert.equal(li.querySelector(".name").textContent, "改名");
  assert.equal(li.querySelector(".detail").textContent, "更新");
  assert.equal(li.querySelector(".persona-dot").className, "persona-dot is-speaking");
  assert.equal(li.querySelector(".persona-dot").style.background, "#abcdef");
  assert.equal(li.querySelector(".switch input").checked, false);
  assert.equal(summary.textContent, "有効 0/1 · 稼働中 1");
});

test("reordering personas moves the existing nodes instead of rebuilding them", () => {
  const { view, list } = setup();
  view.renderPersonas([persona("a"), persona("b"), persona("c")], noopActions());
  const [liA, liB, liC] = list.children;

  view.renderPersonas([persona("c"), persona("a"), persona("b")], noopActions());

  assert.deepEqual(personaIds(list), ["c", "a", "b"]);
  assert.deepEqual(list.children, [liC, liA, liB]);
  for (const li of list.children) assert.equal(li.parentNode, list);
});

test("added personas append and removed personas detach", () => {
  const { view, list } = setup();
  view.renderPersonas([persona("a"), persona("b")], noopActions());
  const [liA, liB] = list.children;

  view.renderPersonas([persona("a"), persona("c")], noopActions());

  assert.deepEqual(personaIds(list), ["a", "c"]);
  assert.equal(list.children[0], liA, "surviving persona keeps its node");
  assert.equal(liB.parentNode, null, "removed persona node is detached");
});

test("personas sharing an id reuse both nodes instead of leaking one per refresh", () => {
  const { view, list } = setup();
  view.renderPersonas([persona("dup"), persona("dup")], noopActions());
  const [firstLi, secondLi] = list.children;

  view.renderPersonas([persona("dup"), persona("dup")], noopActions());
  view.renderPersonas([persona("dup"), persona("dup")], noopActions());

  assert.equal(list.children.length, 2, "duplicate ids must not accumulate nodes across refreshes");
  assert.deepEqual(list.children, [firstLi, secondLi]);

  view.renderPersonas([persona("dup")], noopActions());
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0], firstLi);
  assert.equal(secondLi.parentNode, null, "the surplus duplicate is detached");
});

test("an empty persona list falls back to the placeholder and recovers from it", () => {
  const { view, list, summary } = setup();
  view.renderPersonas([persona("a")], noopActions());

  view.renderPersonas([], noopActions());
  assert.deepEqual(personaIds(list), []);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].textContent, "設定を読み込むと表示されます");
  assert.equal(summary.textContent, "未設定");

  view.renderPersonas([persona("a")], noopActions());
  assert.deepEqual(personaIds(list), ["a"]);
  assert.equal(list.children.length, 1, "placeholder is dropped once personas exist again");
});

test("reused nodes call the actions object from the latest render", () => {
  const { view, list } = setup();
  view.renderPersonas([persona("a", { enabled: false })], { setPersonaEnabled: () => assert.fail("stale actions used"), firePersona: () => assert.fail("stale actions used") });

  const toggled = [];
  const fired = [];
  view.renderPersonas([persona("a", { enabled: false })], {
    setPersonaEnabled: (id, enabled) => toggled.push([id, enabled]),
    firePersona: (id) => fired.push(id),
  });

  const li = list.children[0];
  const checkbox = li.querySelector(".switch input");
  checkbox.checked = true;
  checkbox.dispatch("change");
  li.querySelector("button").dispatch("click");

  assert.deepEqual(toggled, [["a", true]]);
  assert.deepEqual(fired, ["a"]);
});

test("renderTally rebuilds one lamp per persona", () => {
  const { view, document } = setup();
  view.renderTally([persona("a"), persona("b", { state: "off" })]);
  const tally = document.byId.get("#tally");

  assert.deepEqual(tally.children.map((lamp) => lamp.className), ["tally-lamp is-ready", "tally-lamp is-off"]);

  view.renderTally([persona("a", { state: "thinking" })]);
  assert.deepEqual(tally.children.map((lamp) => lamp.className), ["tally-lamp is-thinking"]);
});
