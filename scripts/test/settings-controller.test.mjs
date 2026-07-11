import assert from "node:assert/strict";
import test from "node:test";
import { SettingsController } from "../../src/settings/settings-controller.js";

test("dirty returns false after undo and close guard shares every close reason", async () => {
  let choice = "continue";
  const controller = new SettingsController({ confirmDiscard: async () => choice });
  const base = { schemaVersion: 2, value: 1 };
  controller.open(base);
  assert.equal(controller.changed({ value: 1, schemaVersion: 2 }), false);
  assert.equal(controller.changed({ ...base, value: 2 }), true);
  assert.equal(await controller.requestClose("escape"), "continued");
  choice = "discard";
  assert.equal(await controller.requestClose("config-reload"), "closed");
});

test("save requests coalesce and preserve draft on failure", async () => {
  let calls = 0, reject;
  const pending = new Promise((_resolve, no) => { reject = no; });
  const controller = new SettingsController({ save: () => { calls++; return pending; } });
  controller.open({ schemaVersion: 2 }); controller.changed({ schemaVersion: 2, changed: true });
  const first = controller.save(); const second = controller.save();
  assert.equal(first, second); assert.equal(calls, 1);
  reject(new Error("offline")); await assert.rejects(first, /offline/);
  assert.equal(controller.state.status, "save-error"); assert.equal(controller.state.draft.changed, true);
});
