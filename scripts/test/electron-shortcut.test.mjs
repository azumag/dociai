import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { applyConfigDefaults } from "../../src/config/config-defaults.js";
import { TriggerEngine } from "../../src/trigger-engine.js";

async function loadService() {
  const root = path.resolve(new URL("../..", import.meta.url).pathname);
  const result = await build({ stdin: { contents: `export { ShortcutService, normalizeShortcut } from "./electron/main/services/shortcut-service.ts";`, resolveDir: root, sourcefile: "shortcut-test.ts", loader: "ts" }, bundle: true, format: "esm", platform: "node", write: false });
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "dociai-shortcut-"));
  const file = path.join(directory, "service.mjs"); await fs.writeFile(file, result.outputFiles[0].text); return { modules: await import(file), directory };
}

test("shortcut accelerator normalization rejects unsafe and ambiguous input", async () => {
  const { modules, directory } = await loadService();
  try {
    assert.equal(modules.normalizeShortcut("Alt+1"), "Alt+1");
    assert.equal(modules.normalizeShortcut("Ctrl+Shift+F12"), "Control+Shift+F12");
    assert.equal(modules.normalizeShortcut("Cmd+K"), "CommandOrControl+K");
    assert.throws(() => modules.normalizeShortcut("Alt"), /key is required/);
    assert.throws(() => modules.normalizeShortcut("Alt+1+2"), /one key/);
    assert.throws(() => modules.normalizeShortcut("Ctrl+Ctrl+A"), /duplicate/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("hotkey defaults remain local unless global is explicitly enabled", () => {
  const config = applyConfigDefaults({ schemaVersion: 2, connectors: {}, personas: [], triggers: { local: { type: "hotkey", keys: "Alt+1" }, global: { type: "hotkey", keys: "Alt+2", global: true } } });
  assert.equal(config.triggers.local.global, false);
  assert.equal(config.triggers.global.global, true);
});

test("renderer trigger engine accepts only opted-in global shortcut events and cleans subscriptions", () => {
  const originalWindow = globalThis.window; const originalDociai = globalThis.dociai; const listeners = new Map(); const fired = [];
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.dociai = { events: { subscribe(type, listener) { listeners.set(type, listener); return () => listeners.delete(type); } } };
  try {
    const engine = new TriggerEngine({ global: { type: "hotkey", keys: "Alt+1", global: true }, local: { type: "hotkey", keys: "Alt+2" } }, { onFire: (id, event) => fired.push([id, event.reason]) });
    engine.start(); listeners.get("shortcut:trigger")({ triggerId: "global" }); listeners.get("shortcut:trigger")({ triggerId: "local" });
    assert.deepEqual(fired, [["global", "global-hotkey"]]);
    engine.stop(); assert.equal(listeners.size, 0);
  } finally {
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    if (originalDociai === undefined) delete globalThis.dociai; else globalThis.dociai = originalDociai;
  }
});

test("shortcut service registers only opted-in hotkeys, reports occupied keys, and unregisters on sync/dispose", async () => {
  const { modules, directory } = await loadService();
  try {
    const callbacks = new Map(); const unregistered = []; const status = []; const triggered = [];
    const fake = { register(accelerator, callback) { if (accelerator === "Alt+3") return false; callbacks.set(accelerator, callback); return true; }, unregister(accelerator) { unregistered.push(accelerator); callbacks.delete(accelerator); } };
    const service = new modules.ShortcutService(fake, (value) => status.push(value), (value) => triggered.push(value));
    const first = service.sync({ global: { type: "hotkey", keys: "Alt+1", global: true }, local: { type: "hotkey", keys: "Alt+2" }, occupied: { type: "hotkey", keys: "Alt+3", global: true } });
    assert.deepEqual(first.entries.map(({ triggerId, registered, reason }) => ({ triggerId, registered, reason })), [{ triggerId: "global", registered: true, reason: undefined }, { triggerId: "occupied", registered: false, reason: "occupied" }]);
    callbacks.get("Alt+1")(); assert.deepEqual(triggered, [{ triggerId: "global" }]);
    const second = service.sync({ global: { type: "hotkey", keys: "Ctrl+G", global: true } });
    assert.equal(second.entries[0].accelerator, "Control+G"); assert.deepEqual(unregistered, ["Alt+1"]); assert.equal(status.length, 2);
    service.dispose(); assert.deepEqual(unregistered, ["Alt+1", "Control+G"]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
