import assert from "node:assert/strict";
import test from "node:test";
import { fieldIds } from "../../src/settings/a11y/field-a11y.js";
import { createLiveAnnouncer } from "../../src/settings/a11y/live-region.js";
import { createTabsController } from "../../src/settings/a11y/tabs-controller.js";

function button(tab) {
  return { dataset: { tab }, focus() {} };
}

function key(key, currentTarget) {
  let prevented = false;
  return { key, currentTarget, preventDefault: () => { prevented = true; }, get prevented() { return prevented; } };
}

test("tabs controller follows roving tabindex keyboard navigation", () => {
  const tabs = [button("connectors"), button("personas"), button("triggers")];
  const calls = [];
  const controller = createTabsController({ tabs: () => tabs, activate: (id, options) => calls.push({ id, options }) });
  const down = key("ArrowDown", tabs[0]); controller.onKeydown(down);
  const end = key("End", tabs[0]); controller.onKeydown(end);
  const home = key("Home", tabs[2]); controller.onKeydown(home);
  assert.deepEqual(calls.map((entry) => entry.id), ["personas", "triggers", "connectors"]);
  assert.ok(down.prevented && end.prevented && home.prevented);
});

test("live announcer suppresses duplicate messages and field IDs are stable", async () => {
  const region = { textContent: "" };
  const announcer = createLiveAnnouncer(region);
  announcer.announce("保存しました");
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(region.textContent, "保存しました");
  announcer.announce("保存しました");
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(region.textContent, "保存しました");
  assert.deepEqual(fieldIds("personas.0.voice.name"), {
    input: "settings-field-personas-0-voice-name",
    label: "settings-label-personas-0-voice-name",
    error: "settings-error-personas-0-voice-name",
  });
});
