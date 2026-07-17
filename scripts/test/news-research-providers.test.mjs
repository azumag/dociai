import assert from "node:assert/strict";
import test from "node:test";

import { callElectronResearchIpc } from "../../src/news/research/providers/electron-ipc-provider.js";
import { createNewsSearchProvider } from "../../src/news/research/providers/news-search-provider.js";
import { createWikipediaProvider } from "../../src/news/research/providers/wikipedia-provider.js";
import { isCancellation, RequestCancelledError } from "../../src/runtime/request-registry.js";

test("callElectronResearchIpc builds a prefixed requestId, resolves the ok value, and wires/unwires abort->cancel", async () => {
  const calls = [];
  const cancelled = [];
  const controller = new AbortController();
  const promise = callElectronResearchIpc({
    prefix: "search",
    query: "テスト",
    context: { requestId: "run-1", signal: controller.signal },
    call: async (requestId) => { calls.push(requestId); return { ok: true, value: { hello: "world" } }; },
    cancel: async (requestId) => { cancelled.push(requestId); },
  });
  assert.deepEqual(await promise, { hello: "world" });
  assert.deepEqual(calls, ["run-1:search:テスト"]);
  controller.abort();
  assert.deepEqual(cancelled, [], "abort after settle must not fire cancel (listener was removed)");
});

test("callElectronResearchIpc short-circuits without calling `call` when the signal is already aborted (an 'abort' event never fires on an already-aborted signal)", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    callElectronResearchIpc({
      prefix: "search",
      query: "テスト",
      context: { requestId: "run-1", signal: controller.signal },
      call: async () => { called = true; return { ok: true, value: {} }; },
      cancel: async () => {},
    }),
    (error) => isCancellation(error),
  );
  assert.equal(called, false, "must not spend a real Main-process call on a request that was already cancelled before it started");
});

test("callElectronResearchIpc maps error.code === CANCELLED to a recognizable cancellation, and other failures to a plain Error", async () => {
  await assert.rejects(
    callElectronResearchIpc({ prefix: "search", query: "q", context: {}, call: async () => ({ ok: false, error: { code: "CANCELLED" } }), cancel: async () => {} }),
    (error) => error instanceof RequestCancelledError && isCancellation(error),
  );
  await assert.rejects(
    callElectronResearchIpc({ prefix: "search", query: "q", context: {}, call: async () => ({ ok: false, error: { code: "BAD_REQUEST", message: "だめでした" } }), cancel: async () => {} }),
    (error) => !(error instanceof RequestCancelledError) && error.message === "だめでした",
  );
});

test("callElectronResearchIpc invokes cancel(requestId) when the context signal aborts before settling", async () => {
  const cancelled = [];
  const controller = new AbortController();
  const promise = callElectronResearchIpc({
    prefix: "wikipedia",
    query: "q",
    context: { requestId: "run-2", signal: controller.signal },
    call: () => new Promise(() => {}), // never settles on its own
    cancel: async (requestId) => { cancelled.push(requestId); },
  });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cancelled, ["run-2:wikipedia:q"]);
  void promise; // intentionally left pending; nothing else awaits it in this test
});

function withStubbedDociai(stub, fn) {
  const original = globalThis.dociai;
  globalThis.dociai = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => { if (original === undefined) delete globalThis.dociai; else globalThis.dociai = original; });
}

// Regression test for a real bug caught by review: the Electron Main NewsSearchService/
// WikipediaService's own ServiceRuntime.generation never advances past 0 (nothing calls
// reload() on either service), while a real pipeline run's context.generation is the
// Renderer's RuntimeGenerationManager value, which is >=1 after the first boot. If a
// provider forwarded context.generation into the IPC payload, every real call would compare
// a nonzero Renderer generation against the Main service's permanently-0 generation and
// throw CANCELLED on 100% of invocations — exactly like legacy-news-adapter.js's feed fetch
// deliberately avoids by never sending `generation` at all.
test("createNewsSearchProvider does not forward a Renderer runtime generation into the IPC payload", async () => {
  let received = null;
  await withStubbedDociai({ newsSearch: { query: async (input) => { received = input; return { ok: true, value: { results: [] } }; }, cancel: async () => {} } }, async () => {
    const provider = createNewsSearchProvider();
    await provider.research({ queries: ["テスト"], language: "ja" }, { requestId: "run-1", generation: 3 });
  });
  assert.ok(received);
  assert.equal("generation" in received, false, "must not send the Renderer's runtime generation to a Main service whose own generation never advances");
});

test("createWikipediaProvider does not forward a Renderer runtime generation into the IPC payload", async () => {
  let received = null;
  await withStubbedDociai({ wikipedia: { search: async (input) => { received = input; return { ok: true, value: { summary: null } }; }, cancel: async () => {} } }, async () => {
    const provider = createWikipediaProvider();
    await provider.research({ queries: ["テスト"], language: "ja" }, { requestId: "run-1", generation: 3 });
  });
  assert.ok(received);
  assert.equal("generation" in received, false, "must not send the Renderer's runtime generation to a Main service whose own generation never advances");
});

test("createNewsSearchProvider and createWikipediaProvider propagate a CANCELLED IPC response as a recognizable cancellation, not a generic failure that gets swallowed by the coordinator's failure isolation", async () => {
  await withStubbedDociai({ newsSearch: { query: async () => ({ ok: false, error: { code: "CANCELLED" } }), cancel: async () => {} } }, async () => {
    const provider = createNewsSearchProvider();
    await assert.rejects(provider.research({ queries: ["テスト"], language: "ja" }, {}), (error) => isCancellation(error));
  });
  await withStubbedDociai({ wikipedia: { search: async () => ({ ok: false, error: { code: "CANCELLED" } }), cancel: async () => {} } }, async () => {
    const provider = createWikipediaProvider();
    await assert.rejects(provider.research({ queries: ["テスト"], language: "ja" }, {}), (error) => isCancellation(error));
  });
});
