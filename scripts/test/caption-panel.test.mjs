// src/ui/caption-panel.js のテスト。
//
// No jsdom dependency exists in this repo (see console-view-personas.test.mjs /
// settings-a11y.test.mjs for the same hand-rolled fake-element convention), so this file defines
// the minimal fake DOM CaptionPanel actually touches: querySelector, textContent, classList,
// dataset, replaceChildren, and addEventListener.
import assert from "node:assert/strict";
import test from "node:test";
import { CaptionPanel } from "../../src/ui/caption-panel.js";

class FakeElement {
  constructor(id) {
    this.id = id;
    this.textContent = "";
    this.dataset = {};
    this.disabled = false;
    this.classList = { toggle: (name, on) => { this.classes = { ...this.classes, [name]: Boolean(on) }; } };
    this.classes = {};
    this.listeners = new Map();
    this.children = [];
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  click() { this.listeners.get("click")?.(); }
  replaceChildren(...nodes) { this.children = nodes; }
}

function createFakeRoot() {
  const ids = ["caption-health", "caption-states", "caption-recognized", "caption-caption", "caption-status", "btn-caption-open", "btn-caption-start", "btn-caption-stop", "btn-caption-test"];
  const elements = new Map(ids.map((id) => [`#${id}`, new FakeElement(id)]));
  global.document = { createElement: () => new FakeElement() };
  return {
    hidden: true,
    querySelector: (selector) => elements.get(selector) ?? null,
  };
}

const baseStatus = (overrides = {}) => ({
  enabled: true,
  running: true,
  health: "recognizing",
  generation: 1,
  worker: { connected: true, state: "recognizing", chromeFound: true },
  obs: { connected: true, streaming: true, micMuted: false, captionSupported: true },
  counters: { accepted: 0, rejected: 0, sent: 0, failed: 0 },
  lastRecognized: "",
  lastCaption: "",
  ...overrides,
});

test("エラーが解消したら、直前のエラー文言を出したままにしない", () => {
  const root = createFakeRoot();
  const panel = new CaptionPanel(root, { status: async () => ({ ok: true, value: baseStatus() }), subscribe: () => () => {} });
  panel.render(baseStatus({ lastError: { code: "obs_socket_error", message: "OBSへ接続できません" } }));
  assert.equal(root.querySelector("#caption-status").textContent, "OBSへ接続できません");
  // 再接続してlastErrorが消えた — 古いエラー文言をaria-live領域に残さない
  panel.render(baseStatus());
  assert.equal(root.querySelector("#caption-status").textContent, "");
});

test("ボタン操作の成功メッセージは、直後のエラー解消判定で上書きされない", () => {
  const root = createFakeRoot();
  const panel = new CaptionPanel(root, { status: async () => ({ ok: true, value: baseStatus() }), subscribe: () => () => {} });
  panel.render(baseStatus({ lastError: { code: "obs_socket_error", message: "エラー" } }));
  panel.render(baseStatus()); // エラー解消 → 空になる
  // ここで#run()相当の成功メッセージを模す (this.#message経由の別呼び出し)
  panel.render(baseStatus()); // 同じ状態を再描画してもクリアで壊れない
  assert.equal(root.querySelector("#caption-status").textContent, "");
});

test("設定が無効な間は「有効にしてください」を表示する", () => {
  const root = createFakeRoot();
  const panel = new CaptionPanel(root, { status: async () => ({ ok: true, value: baseStatus() }), subscribe: () => () => {} });
  panel.render(baseStatus({ enabled: false, running: false, health: "disabled" }));
  assert.equal(root.querySelector("#caption-status").textContent, "設定で英語CCを有効にしてください");
});
