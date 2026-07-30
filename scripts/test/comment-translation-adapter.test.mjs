import assert from "node:assert/strict";
import test from "node:test";
import { createElectronTranslationAdapter } from "../../src/comment-translation-adapter.js";

function withDociaiTranslation(translation, run) {
  const original = globalThis.dociai;
  globalThis.dociai = { translation };
  return Promise.resolve()
    .then(run)
    .finally(() => { if (original === undefined) delete globalThis.dociai; else globalThis.dociai = original; });
}

test("translate() calls dociai.translation.translate with a freshly-generated requestId and unwraps a successful Result", async () => {
  const calls = [];
  await withDociaiTranslation({
    translate: async (input) => { calls.push(input); return { ok: true, value: { text: "配信ありがとう!", requestId: input.requestId, durationMs: 12, modelId: "m", sourceLanguage: "en", targetLanguage: "ja" } }; },
    cancel: async () => ({ ok: true, value: { cancelled: true } }),
  }, async () => {
    const adapter = createElectronTranslationAdapter();
    const result = await adapter.translate({ text: "Thank you!", sourceLanguage: "en", targetLanguage: "ja" });
    assert.deepEqual(result, { text: "配信ありがとう!" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "Thank you!");
    assert.equal(calls[0].sourceLanguage, "en");
    assert.equal(calls[0].targetLanguage, "ja");
    assert.equal(typeof calls[0].requestId, "string");
    assert.ok(calls[0].requestId.length > 0);
  });
});

test("translate() throws an Error carrying .code/.retryable when the IPC call returns a failed Result", async () => {
  await withDociaiTranslation({
    translate: async () => ({ ok: false, error: { code: "UNAVAILABLE", message: "モデル未導入です", retryable: false } }),
    cancel: async () => ({ ok: true, value: { cancelled: true } }),
  }, async () => {
    const adapter = createElectronTranslationAdapter();
    await assert.rejects(
      adapter.translate({ text: "hi", sourceLanguage: "en", targetLanguage: "ja" }),
      (error) => error.message === "モデル未導入です" && error.code === "UNAVAILABLE" && error.retryable === false,
    );
  });
});

test("aborting the caller's signal cancels the same requestId that was sent to translate()", async () => {
  const cancelledIds = [];
  let capturedRequestId = null;
  await withDociaiTranslation({
    translate: (input) => { capturedRequestId = input.requestId; return new Promise(() => {}); }, // never resolves
    cancel: async (requestId) => { cancelledIds.push(requestId); return { ok: true, value: { cancelled: true } }; },
  }, async () => {
    const adapter = createElectronTranslationAdapter();
    const controller = new AbortController();
    const promise = adapter.translate({ text: "hi", sourceLanguage: "en", targetLanguage: "ja", signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(cancelledIds, [capturedRequestId]);
    void promise; // intentionally left pending — the adapter itself never times this out (the caller's own timeout does)
  });
});

test("two concurrent translate() calls get distinct requestIds", async () => {
  const seen = [];
  await withDociaiTranslation({
    translate: async (input) => { seen.push(input.requestId); return { ok: true, value: { text: "x" } }; },
    cancel: async () => ({ ok: true, value: { cancelled: true } }),
  }, async () => {
    const adapter = createElectronTranslationAdapter();
    await Promise.all([
      adapter.translate({ text: "a", sourceLanguage: "en", targetLanguage: "ja" }),
      adapter.translate({ text: "b", sourceLanguage: "fr", targetLanguage: "ja" }),
    ]);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
  });
});
