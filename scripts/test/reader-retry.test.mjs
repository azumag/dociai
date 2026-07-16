import assert from "node:assert/strict";
import test from "node:test";
import { NewsReader } from "../../src/news-reader.js";
import { TopicReader } from "../../src/topic-reader.js";
import { applyConfigDefaults } from "../../src/config/config-defaults.js";
import { MemoryItemProcessingStore } from "../../src/readers/item-processing-store.js";
import { retryDecision } from "../../src/readers/retry-policy.js";
import { isCancellation } from "../../src/runtime/request-registry.js";

const persona = { id: "reader", name: "Reader", connector: "mock", enabled: true, voice: {} };

function readerDependencies({ connector, now, store = new MemoryItemProcessingStore({ clock: () => now.value }) }) {
  return {
    getConnector: () => connector,
    personaRouter: { get: () => persona, defaultPersona: () => persona },
    contextBuilder: { build: () => ({ messages: [{ role: "user", content: "summarize" }], debugText: "safe debug" }) },
    speechQueue: { enqueue: () => ({ state: "waiting" }) },
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
