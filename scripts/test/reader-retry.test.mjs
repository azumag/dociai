import assert from "node:assert/strict";
import test from "node:test";
import { NewsReader } from "../../src/news-reader.js";
import { TopicReader } from "../../src/topic-reader.js";
import { applyConfigDefaults } from "../../src/config/config-defaults.js";
import { MemoryItemProcessingStore } from "../../src/readers/item-processing-store.js";
import { retryDecision } from "../../src/readers/retry-policy.js";
import { isCancellation } from "../../src/runtime/request-registry.js";

const persona = { id: "reader", name: "Reader", connector: "mock", enabled: true, voice: {} };

function readerDependencies({ connector, now, store = new MemoryItemProcessingStore({ clock: () => now.value }), speechQueue = { enqueue: (item) => { item?.onDelivered?.(); return { state: "waiting" }; } } }) {
  return {
    getConnector: () => connector,
    personaRouter: { get: () => persona, defaultPersona: () => persona },
    contextBuilder: { build: () => ({ messages: [{ role: "user", content: "summarize" }], debugText: "safe debug" }) },
    speechQueue,
    store,
    clock: () => now.value,
  };
}

test("item processing store enforces lifecycle, generation, and bounded terminal cleanup", () => {
  let now = 1_000;
  const store = new MemoryItemProcessingStore({ maxEntries: 2, ttlMs: 100, clock: () => now });
  store.ensure({ key: "a", title: "a" }, 1);
  const first = store.begin("a", 1);
  assert.equal(first.attempts, 1);
  assert.equal(store.begin("a", 1), null, "duplicate begin is rejected");
  assert.equal(store.markFailure("a", 2, new Error("old"), { action: "retry", reason: "network", nextRetryAt: 2_000 }), false, "stale generation cannot update state");
  assert.equal(store.markFailure("a", 1, new Error("offline"), { action: "retry", reason: "network", nextRetryAt: 2_000 }), true);
  assert.equal(store.candidates(1, 1_999).length, 0);
  assert.equal(store.candidates(1, 2_000).length, 1);
  assert.equal(store.retryNow("a", 1, now), true);
  assert.equal(store.begin("a", 1)?.attempts, 1, "manual retry resets the attempt budget");
  assert.equal(store.markRead("a", 1), true);
  assert.equal(store.skip("a", 1), false, "read is immutable without an explicit restore policy");

  store.ensure({ key: "shared", title: "shared" }, 1);
  store.begin("shared", 1);
  store.ensure({ key: "shared", title: "shared" }, 2);
  assert.equal(store.get("shared")?.state, "unread", "new generation resets only an interrupted processing item");
  assert.equal(store.markRead("shared", 1), false, "old generation cannot complete after a reload");

  store.ensure({ key: "b", title: "b" }, 1);
  store.begin("b", 1);
  store.markRead("b", 1);
  store.ensure({ key: "c", title: "c" }, 1);
  assert.equal(store.list().length, 2, "oldest terminal record is removed to make bounded room");

  store.ensure({ key: "active", title: "active" }, 1);
  store.begin("active", 1);
  store.markFailure("active", 1, new Error("offline"), { action: "retry", reason: "network", nextRetryAt: 10_000 });
  now += 1_000;
  store.cleanup();
  assert.equal(store.get("active")?.state, "retry_wait", "retry_wait is never dropped by TTL cleanup");
});

test("retry policy uses Retry-After and makes permanent errors non-retryable", () => {
  assert.deepEqual(retryDecision({ kind: "rate_limit", retryAfter: 12 }, { attempts: 1, now: 100 }), { action: "retry", reason: "rate_limit", nextRetryAt: 12_100 });
  assert.deepEqual(retryDecision({ kind: "auth" }, { attempts: 1, now: 100 }), { action: "permanent", reason: "auth" });
  assert.deepEqual(retryDecision({ kind: "network" }, { attempts: 3, now: 100 }), { action: "permanent", reason: "network" });
});

test("reader retry settings receive safe defaults while preserving configured values", () => {
  const config = applyConfigDefaults({
    news: { retry: { maxAttempts: 2 } },
    topics: { retry: { initialDelaySeconds: 5 } },
  });
  assert.deepEqual(config.news.retry, { maxAttempts: 2, initialDelaySeconds: 30, maxDelaySeconds: 900 });
  assert.deepEqual(config.topics.retry, { maxAttempts: 3, initialDelaySeconds: 5, maxDelaySeconds: 900 });
});

test("NewsReader retries transient failures without blocking later items, then marks successful retry read", async () => {
  const now = { value: 10_000 };
  let calls = 0;
  const reads = [];
  const reader = new NewsReader({
    config: { news: { enabled: true, maxItems: 2, retry: { initialDelaySeconds: 30, maxAttempts: 3 } } },
    ...readerDependencies({
      now,
      connector: {
        chat: async () => {
          calls++;
          if (calls === 1) throw Object.assign(new Error("temporary outage"), { kind: "timeout" });
          return { text: `summary-${calls}` };
        },
      },
    }),
    onRead: ({ item }) => reads.push(item.guid),
  });
  const items = reader.refineItems([
    { guid: "first", title: "first", sourceName: "source", publishedAt: "2026-07-02T10:00:00Z" },
    { guid: "second", title: "second", sourceName: "source", publishedAt: "2026-07-02T09:00:00Z" },
  ]);
  reader.fetchAll = async () => items;

  await reader.run({ generation: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(reader.status().counts, { unread: 0, processing: 0, read: 1, retry_wait: 1, failed_permanent: 0, skipped: 0 });
  assert.equal(reader.status().nextRetryAt, 40_000);
  assert.deepEqual(reads, ["second"], "one failing item does not stop the following item");

  await reader.run({ generation: 1 });
  assert.equal(calls, 2, "not-due retry item is not called in the same retry window");
  now.value = 40_000;
  await reader.run({ generation: 1 });
  assert.equal(calls, 3);
  assert.equal(reader.status().counts.read, 2);
  assert.equal(reader.status().counts.retry_wait, 0);
  assert.deepEqual(reads, ["second", "first"]);
});

test("NewsReader preserves unread items for missing/auth connectors and resets a cancelled generation", async () => {
  const now = { value: 1_000 };
  const config = { news: { enabled: true, maxItems: 1 } };
  const item = { guid: "only", title: "only", sourceName: "source", publishedAt: "2026-07-02T10:00:00Z" };

  const missing = new NewsReader({ config, ...readerDependencies({ now, connector: null }) });
  missing.fetchAll = async () => missing.refineItems([item]);
  await missing.run({ generation: 1 });
  assert.equal(missing.status().counts.unread, 1);

  const auth = new NewsReader({
    config,
    ...readerDependencies({ now, connector: { chat: async () => { throw Object.assign(new Error("bad key"), { kind: "auth" }); } } }),
  });
  auth.fetchAll = async () => auth.refineItems([item]);
  await auth.run({ generation: 1 });
  assert.equal(auth.status().counts.unread, 1, "authentication failure does not consume the item");

  let current = true;
  const cancelled = new NewsReader({
    config,
    ...readerDependencies({ now, connector: { chat: async () => { current = false; return { text: "late" }; } } }),
  });
  cancelled.fetchAll = async () => cancelled.refineItems([item]);
  await assert.rejects(cancelled.run({ generation: 1, isCurrent: () => current }), isCancellation);
  assert.equal(cancelled.status().counts.unread, 1, "stale generation cannot mark a late response read");
});

test("NewsReader/TopicReader stay enabled per config.news.enabled/config.topics.enabled but pause once isRuntimeEnabled() reports the main-screen toggle is off", async () => {
  const now = { value: 1_000 };
  let newsRuntimeEnabled = true;
  const news = new NewsReader({
    config: { news: { enabled: true, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    isRuntimeEnabled: () => newsRuntimeEnabled,
  });
  news.fetchAll = async () => news.refineItems([{ guid: "news-only", title: "news-only", sourceName: "source", publishedAt: "2026-07-02T10:00:00Z" }]);

  assert.equal(news.enabled, true);
  await news.run({ generation: 1 });
  assert.equal(news.status().counts.read, 1, "runs normally while the toggle is on");

  newsRuntimeEnabled = false;
  assert.equal(news.enabled, false, "config.news.enabled stays true — only the session toggle flips .enabled");
  news.fetchAll = async () => news.refineItems([{ guid: "news-second", title: "news-second", sourceName: "source", publishedAt: "2026-07-02T11:00:00Z" }]);
  await news.run({ generation: 1 });
  assert.equal(news.status().counts.read, 1, "paused: no new item is processed while the toggle is off");

  let topicsRuntimeEnabled = true;
  const topics = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    isRuntimeEnabled: () => topicsRuntimeEnabled,
  });
  topics.fetchAll = async () => topics.refineItems([{ guid: "topic-only", title: "topic-only", sourceName: "todoist" }]);
  assert.equal(topics.enabled, true);

  topicsRuntimeEnabled = false;
  assert.equal(topics.enabled, false, "config.topics.enabled stays true — only the session toggle flips .enabled");
  await topics.run({ generation: 1 });
  assert.equal(topics.status().counts.read, 0, "paused before any topic is picked up");
});

test("NewsReader/TopicReader: run({ manual: true }) bypasses the isRuntimeEnabled() pause (manual panel buttons), but config.news.enabled/config.topics.enabled still gate everything", async () => {
  const now = { value: 1_000 };
  const news = new NewsReader({
    config: { news: { enabled: true, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    isRuntimeEnabled: () => false,
  });
  news.fetchAll = async () => news.refineItems([{ guid: "manual-news", title: "manual-news", sourceName: "source", publishedAt: "2026-07-02T10:00:00Z" }]);
  await news.run({ generation: 1, manual: true });
  assert.equal(news.status().counts.read, 1, "context.manual must bypass the runtime-toggle pause");

  const disabledNews = new NewsReader({
    config: { news: { enabled: false, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    isRuntimeEnabled: () => false,
  });
  disabledNews.fetchAll = async () => disabledNews.refineItems([{ guid: "should-not-run", title: "should-not-run", sourceName: "source", publishedAt: "2026-07-02T10:00:00Z" }]);
  await disabledNews.run({ generation: 1, manual: true });
  assert.equal(disabledNews.status().counts.read, 0, "config.news.enabled: false must still block even a manual run");

  const topics = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    isRuntimeEnabled: () => false,
  });
  topics.fetchAll = async () => topics.refineItems([{ guid: "manual-topic", title: "manual-topic", sourceName: "todoist" }]);
  await topics.run({ generation: 1, manual: true });
  assert.equal(topics.status().counts.read, 1, "context.manual must bypass the runtime-toggle pause");

  const disabledTopics = new TopicReader({
    config: { topics: { enabled: false, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    isRuntimeEnabled: () => false,
  });
  disabledTopics.fetchAll = async () => disabledTopics.refineItems([{ guid: "should-not-run", title: "should-not-run", sourceName: "todoist" }]);
  await disabledTopics.run({ generation: 1, manual: true });
  assert.equal(disabledTopics.status().counts.read, 0, "config.topics.enabled: false must still block even a manual run");
});

test("TopicReader applies the same retry lifecycle and stops permanent-error loops", async () => {
  const now = { value: 1_000 };
  let calls = 0;
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => { calls++; throw Object.assign(new Error("invalid request"), { kind: "bad_request" }); } } }),
  });
  reader.fetchAll = async () => reader.refineItems([{ guid: "topic", title: "topic", sourceName: "todoist" }]);
  await reader.run({ generation: 1 });
  await reader.run({ generation: 1 });
  assert.equal(calls, 1);
  assert.equal(reader.status().counts.failed_permanent, 1);
  const failure = reader.status().failures[0];
  assert.equal(reader.retryNow(failure.key), true);
  assert.equal(reader.skip(failure.key), true);
  assert.equal(reader.restore(failure.key), true);
});

test("TopicReader randomPersona picks per item from the enabled candidate pool", async () => {
  const now = { value: 1_000 };
  const personaA = { id: "a", name: "A", connector: "mock", enabled: true, voice: {} };
  const personaB = { id: "b", name: "B", connector: "mock", enabled: true, voice: {} };
  const personaDisabled = { id: "c", name: "C", connector: "mock", enabled: false, voice: {} };
  const personas = { a: personaA, b: personaB, c: personaDisabled };
  const seenPersonas = [];
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 3, randomPersona: true, personas: ["a", "b", "c"] } },
    getConnector: () => ({ chat: async () => ({ text: "ok" }) }),
    personaRouter: { get: (id) => personas[id], defaultPersona: () => personaA },
    contextBuilder: { build: () => ({ messages: [{ role: "user", content: "x" }], debugText: "d" }) },
    speechQueue: { enqueue: (item) => { item?.onDelivered?.(); return { state: "waiting" }; } },
    store: new MemoryItemProcessingStore({ clock: () => now.value }),
    clock: () => now.value,
    onRead: ({ persona }) => seenPersonas.push(persona.id),
  });
  reader.fetchAll = async () => reader.refineItems([
    { guid: "1", title: "t1", sourceName: "todoist" },
    { guid: "2", title: "t2", sourceName: "todoist" },
    { guid: "3", title: "t3", sourceName: "todoist" },
  ]);
  const sequence = [0, 0.9, 0.4];
  let i = 0;
  reader.random = () => sequence[i++ % sequence.length];
  await reader.run({ generation: 1 });
  assert.deepEqual(seenPersonas, ["a", "b", "a"]);
  assert.equal(reader.status().counts.read, 3);
});

test("TopicReader falls back to topics.persona when randomPersona has no enabled candidates", async () => {
  const now = { value: 1_000 };
  const personaFixed = { id: "fixed", name: "Fixed", connector: "mock", enabled: true, voice: {} };
  const personaDisabled = { id: "c", name: "C", connector: "mock", enabled: false, voice: {} };
  const personas = { fixed: personaFixed, c: personaDisabled };
  const seenPersonas = [];
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1, persona: "fixed", randomPersona: true, personas: ["c"] } },
    getConnector: () => ({ chat: async () => ({ text: "ok" }) }),
    personaRouter: { get: (id) => personas[id], defaultPersona: () => personaFixed },
    contextBuilder: { build: () => ({ messages: [{ role: "user", content: "x" }], debugText: "d" }) },
    speechQueue: { enqueue: (item) => { item?.onDelivered?.(); return { state: "waiting" }; } },
    store: new MemoryItemProcessingStore({ clock: () => now.value }),
    clock: () => now.value,
    onRead: ({ persona }) => seenPersonas.push(persona.id),
  });
  reader.fetchAll = async () => reader.refineItems([{ guid: "1", title: "t1", sourceName: "todoist" }]);
  await reader.run({ generation: 1 });
  assert.deepEqual(seenPersonas, ["fixed"]);
});

test("TopicReader runs Web research before chat and includes grounded results", async () => {
  const now = { value: 1_000 };
  const order = [];
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1 } },
    ...readerDependencies({
      now,
      connector: { chat: async (messages) => { order.push("chat"); assert.equal(messages[0].content, "grounded"); return { text: "topic comment" }; } },
    }),
    contextBuilder: { build: (input) => { order.push("context"); assert.equal(input.research.results[0].title, "result"); return { messages: [{ role: "user", content: "grounded" }], debugText: "research debug" }; } },
    webResearcher: { enabled: true, research: async ({ task }) => { order.push("research"); assert.equal(task, "topic title\nnote"); return { query: task, results: [{ title: "result", link: "https://example.com", snippet: "facts" }] }; } },
  });
  reader.fetchAll = async () => reader.refineItems([{ guid: "topic", title: "topic title", description: "note", sourceName: "todoist" }]);
  await reader.run({ generation: 1 });
  assert.deepEqual(order, ["research", "context", "chat"]);
  assert.equal(reader.status().counts.read, 1);
});

test("TopicReader resets a dropped item back to unread (not markRead) so a later run can retry it, and skips the Todoist completion", async () => {
  const now = { value: 1_000 };
  let todoistCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { todoistCalls++; return { ok: true, json: async () => ({}) }; };
  try {
    const reader = new TopicReader({
      config: { topics: { enabled: true, maxItems: 1 } },
      ...readerDependencies({ now, connector: { chat: async () => ({ text: "generated comment" }) } }),
      speechQueue: { enqueue: () => ({ state: "dropped" }) },
    });
    reader.fetchAll = async () => reader.refineItems([{ guid: "topic", title: "topic", sourceName: "todoist", _todoistTaskId: "t1", _todoistToken: "tok" }]);
    await reader.run({ generation: 1 });
    assert.equal(reader.status().counts.read, 0, "a dropped item must never be marked read — it was never actually spoken");
    assert.equal(reader.status().counts.unread, 1, "a dropped item must go back to unread so a later run can retry it");
    assert.equal(todoistCalls, 0, "onDelivered (which completes the Todoist task) must never fire for a dropped item");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TopicReader fails open when Web research fails", async () => {
  const now = { value: 1_000 };
  const warnings = [];
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "fallback comment" }) } }),
    contextBuilder: { build: ({ research }) => { assert.equal(research, null); return { messages: [{ role: "user", content: "no research" }], debugText: "no research" }; } },
    webResearcher: { enabled: true, research: async () => { throw new Error("search unavailable"); } },
    log: (message, level) => { if (level === "warn") warnings.push(message); },
  });
  reader.fetchAll = async () => reader.refineItems([{ guid: "topic", title: "topic title", sourceName: "todoist" }]);
  await reader.run({ generation: 1 });
  assert.equal(reader.status().counts.read, 1, "research failure falls back to the normal response instead of blocking readout");
  assert.ok(warnings.some((message) => /Web調査prepass/.test(message)));
});

test("TopicReader turns a Todoist 401 from the Electron Main process into an actionable auth message", async () => {
  const now = { value: 1_000 };
  const logs = [];
  const originalDociai = globalThis.dociai;
  try {
    globalThis.dociai = { topics: { fetch: async () => ({ ok: false, error: { code: "AUTH", message: "HTTP 401", retryable: false } }) } };
    const reader = new TopicReader({
      config: { topics: { enabled: true, sources: [{ name: "配信ネタ (Todoist)", type: "todoist", enabled: true, projectId: "1" }] } },
      ...readerDependencies({ now, connector: { chat: async () => ({ text: "unused" }) } }),
      log: (message, level) => logs.push({ message, level }),
    });
    assert.deepEqual(await reader.fetchAll({}), []);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, "error");
    assert.match(logs[0].message, /認証に失敗/);
    assert.match(logs[0].message, /設定でTodoist個人アクセストークンを再設定/);
    assert.match(logs[0].message, /HTTP 401/, "the underlying status is still visible for diagnosis");
  } finally {
    if (originalDociai === undefined) delete globalThis.dociai; else globalThis.dociai = originalDociai;
  }
});

test("TopicReader turns a direct-fetch Todoist 401 (Browser mode without Electron Main) into the same actionable auth message", async () => {
  const now = { value: 1_000 };
  const logs = [];
  const originalDociai = globalThis.dociai;
  const originalFetch = globalThis.fetch;
  try {
    delete globalThis.dociai;
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
    const reader = new TopicReader({
      config: { topics: { enabled: true, sources: [{ name: "配信ネタ (Todoist)", type: "todoist", enabled: true, token: "expired-token", projectId: "1" }] } },
      ...readerDependencies({ now, connector: { chat: async () => ({ text: "unused" }) } }),
      log: (message, level) => logs.push({ message, level }),
    });
    assert.deepEqual(await reader.fetchAll({}), []);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, "error");
    assert.match(logs[0].message, /認証に失敗/);
  } finally {
    if (originalDociai === undefined) delete globalThis.dociai; else globalThis.dociai = originalDociai;
    globalThis.fetch = originalFetch;
  }
});

test("AI-backed readers warn about output limits before handing text to speech", async () => {
  for (const { Reader, key, source } of [
    { Reader: NewsReader, key: "news", source: "source" },
    { Reader: TopicReader, key: "topics", source: "todoist" },
  ]) {
    const now = { value: 1_000 };
    const events = [];
    const dependencies = readerDependencies({ now, connector: { chat: async () => ({ text: "途中まで", finishReason: "length" }) } });
    const reader = new Reader({
      config: { [key]: { enabled: true, maxItems: 1 } },
      ...dependencies,
      log: (message, level) => events.push({ type: "log", message, level }),
      speechQueue: { enqueue: () => { events.push({ type: "speech" }); return { state: "waiting" }; } },
    });
    reader.fetchAll = async () => reader.refineItems([{ guid: key, title: key, sourceName: source }]);

    await reader.run({ generation: 1 });

    const warningIndex = events.findIndex((event) => event.type === "log" && event.level === "warn" && /読み上げ処理による切断ではありません/.test(event.message));
    const speechIndex = events.findIndex((event) => event.type === "speech");
    assert.ok(warningIndex >= 0, `${key} reader must report the AI output limit`);
    assert.ok(warningIndex < speechIndex, `${key} reader must diagnose the limit before speech`);
  }
});

test("TopicReader never reads the same topic twice across runs with different task ids (issue #278)", async () => {
  const now = { value: 1_000 };
  const reads = [];
  const warnings = [];
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    onRead: ({ item }) => reads.push(item.guid),
    log: (message, level) => warnings.push({ message, level }),
  });
  reader.fetchAll = async () => reader.refineItems([{ guid: "todoist:1", title: "お題A", sourceName: "todoist" }]);
  await reader.run({ generation: 1 });
  assert.deepEqual(reads, ["todoist:1"]);
  assert.equal(reader.status().counts.read, 1);

  // 同じお題が別タスクIDとして再登場 (Todoist完了失敗や手動再追加) しても、タイトル履歴で弾く。
  reader.fetchAll = async () => reader.refineItems([{ guid: "todoist:2", title: "お題A", sourceName: "todoist" }]);
  await reader.run({ generation: 1 });
  assert.deepEqual(reads, ["todoist:1"], "同じタイトルの話題は二度読まない");
  assert.equal(reader.status().counts.read, 1);
  assert.equal(reader.status().counts.unread, 1, "履歴で弾かれた項目は未読のまま残る (newsと同じ挙動)");
  assert.ok(warnings.some((w) => w.message.includes("重複")), "重複スキップはログで可視化される");
});

test("TopicReader marks within-batch duplicate titles skipped so they never become candidates again (issue #278)", async () => {
  const now = { value: 1_000 };
  const reads = [];
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    onRead: ({ item }) => reads.push(item.guid),
  });
  reader.fetchAll = async () => reader.refineItems([
    { guid: "todoist:1", title: "お題A", sourceName: "todoist" },
    { guid: "todoist:2", title: "お題A", sourceName: "todoist" },
  ]);
  await reader.run({ generation: 1 });
  assert.deepEqual(reads, ["todoist:1"]);
  assert.equal(reader.status().counts.skipped, 1, "バッチ内重複はストア上でskippedになる");

  // 翌runで重複側のタスクだけが残っても、skipped済みのため候補にならない。
  reader.fetchAll = async () => reader.refineItems([{ guid: "todoist:2", title: "お題A", sourceName: "todoist" }]);
  await reader.run({ generation: 1 });
  assert.deepEqual(reads, ["todoist:1"], "skipped済みの重複タスクは二度読まれない");
  assert.equal(reader.status().counts.read, 1);
});

test("TopicReader does not skip the kept item when a duplicate shares its processingKey (issue #278)", async () => {
  const now = { value: 1_000 };
  const reads = [];
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    onRead: ({ item }) => reads.push(item.guid),
  });
  // 同一タスク (同一guid・同一source) がfetch結果に重複して含まれるケース。
  reader.fetchAll = async () => reader.refineItems([
    { guid: "todoist:1", title: "お題A", sourceName: "todoist" },
    { guid: "todoist:1", title: "お題A", sourceName: "todoist" },
  ]);
  await reader.run({ generation: 1 });
  assert.deepEqual(reads, ["todoist:1"], "採用側のタスクは読み上げられる");
  assert.equal(reader.status().counts.skipped, 0, "採用項目と同じキーの重複はskippedにしない");
  assert.equal(reader.status().counts.read, 1);
});

test("TopicReader history-filtered items do not consume the maxItems slot (issue #278)", async () => {
  const now = { value: 1_000 };
  const reads = [];
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1 } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    onRead: ({ item }) => reads.push(item.guid),
  });
  // run1: お題Aを読み、タイトル履歴に記録する。
  reader.fetchAll = async () => reader.refineItems([{ guid: "todoist:1", title: "お題A", sourceName: "todoist" }]);
  await reader.run({ generation: 1 });
  // run2: 履歴で弾かれる「お題A (別タスクID)」と未読の「お題B」が混在。
  // maxItems: 1 でも履歴で弾かれた項目が枠を消費せず、Bが読まれる。
  reader.fetchAll = async () => reader.refineItems([
    { guid: "todoist:3", title: "お題A", sourceName: "todoist" },
    { guid: "todoist:2", title: "お題B", sourceName: "todoist" },
  ]);
  await reader.run({ generation: 1 });
  assert.deepEqual(reads, ["todoist:1", "todoist:2"], "履歴で弾かれた項目が枠を消費せず、後続の候補が読まれる");
});

test("TopicReader topics.dedupe: false disables both batch and history dedupe (issue #278)", async () => {
  const now = { value: 1_000 };
  const reads = [];
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 2, dedupe: false } },
    ...readerDependencies({ now, connector: { chat: async () => ({ text: "summary" }) } }),
    onRead: ({ item }) => reads.push(item.guid),
  });
  reader.fetchAll = async () => reader.refineItems([
    { guid: "todoist:1", title: "お題A", sourceName: "todoist" },
    { guid: "todoist:2", title: "お題A", sourceName: "todoist" },
  ]);
  await reader.run({ generation: 1 });
  assert.deepEqual(reads, ["todoist:1", "todoist:2"], "dedupe: falseなら同一バッチ内の重複も両方読む");

  // 履歴チェックも無効のため、同じお題が別タスクIDで再登場しても読む。
  reader.fetchAll = async () => reader.refineItems([{ guid: "todoist:3", title: "お題A", sourceName: "todoist" }]);
  await reader.run({ generation: 1 });
  assert.deepEqual(reads, ["todoist:1", "todoist:2", "todoist:3"]);
});

test("TopicReader dropped-at-enqueue items stay retryable — history is only recorded on delivery (issue #278)", async () => {
  const now = { value: 1_000 };
  const reads = [];
  let drop = true;
  const reader = new TopicReader({
    config: { topics: { enabled: true, maxItems: 1 } },
    ...readerDependencies({
      now,
      connector: { chat: async () => ({ text: "summary" }) },
      speechQueue: { enqueue: (item) => { if (drop) return { state: "dropped" }; item?.onDelivered?.(); return { state: "waiting" }; } },
    }),
    onRead: ({ item }) => reads.push(item.guid),
  });
  reader.fetchAll = async () => reader.refineItems([{ guid: "todoist:1", title: "お題A", sourceName: "todoist" }]);
  await reader.run({ generation: 1 });
  assert.deepEqual(reads, [], "dropped時はonReadもTodoist完了も発火しない");
  assert.equal(reader.status().counts.unread, 1, "dropped→resetUnreadで再試行可能");

  drop = false;
  await reader.run({ generation: 1 });
  assert.deepEqual(reads, ["todoist:1"], "履歴に記録されていないため再試行で読まれる");
  assert.equal(reader.status().counts.read, 1);
});
