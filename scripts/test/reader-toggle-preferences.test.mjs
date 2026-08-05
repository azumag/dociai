import assert from "node:assert/strict";
import test from "node:test";
import { loadReaderToggles, saveReaderToggles } from "../../src/ui/reader-toggle-preferences.js";

// Node has no global localStorage — a minimal in-memory stand-in is enough to exercise the
// module's own load/save contract without needing jsdom.
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    _data: data,
  };
}

test("saveReaderToggles/loadReaderToggles round-trip both booleans", () => {
  const storage = fakeStorage();
  saveReaderToggles({ newsRuntimeEnabled: false, topicsRuntimeEnabled: true }, storage);
  assert.deepEqual(loadReaderToggles(storage), { newsRuntimeEnabled: false, topicsRuntimeEnabled: true });
});

test("loadReaderToggles returns {} (caller falls back to its own default) when nothing was ever saved", () => {
  assert.deepEqual(loadReaderToggles(fakeStorage()), {});
});

test("loadReaderToggles returns {} without throwing on malformed JSON or non-boolean values", () => {
  assert.deepEqual(loadReaderToggles(fakeStorage({ "dociai:reader-toggles": "{not json" })), {});
  assert.deepEqual(loadReaderToggles(fakeStorage({ "dociai:reader-toggles": JSON.stringify({ newsRuntimeEnabled: "yes", topicsRuntimeEnabled: 1 }) })), {});
});

test("loadReaderToggles restores only whichever key was actually saved (partial object)", () => {
  const storage = fakeStorage({ "dociai:reader-toggles": JSON.stringify({ newsRuntimeEnabled: false }) });
  assert.deepEqual(loadReaderToggles(storage), { newsRuntimeEnabled: false });
});

test("loadReaderToggles/saveReaderToggles never throw when storage is unavailable (no argument, no global localStorage under Node)", () => {
  assert.deepEqual(loadReaderToggles(), {});
  assert.doesNotThrow(() => saveReaderToggles({ newsRuntimeEnabled: true, topicsRuntimeEnabled: true }));
});

test("saveReaderToggles swallows a storage that throws (e.g. quota exceeded) instead of breaking the caller", () => {
  const throwingStorage = { getItem() { throw new Error("nope"); }, setItem() { throw new Error("quota exceeded"); } };
  assert.doesNotThrow(() => saveReaderToggles({ newsRuntimeEnabled: true, topicsRuntimeEnabled: false }, throwingStorage));
  assert.deepEqual(loadReaderToggles(throwingStorage), {});
});
