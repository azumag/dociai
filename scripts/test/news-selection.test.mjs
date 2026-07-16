import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTitleKey, computeUrlHash } from "../../src/news/selection/normalize-news-key.js";
import { normalizeTopicKey } from "../../src/news/selection/topic-key.js";
import { createSpamGate } from "../../src/news/selection/spam-gate.js";
import { sourceDiversityWeight } from "../../src/news/selection/source-diversity.js";
import { createSelectionPolicy } from "../../src/news/selection/selection-policy.js";
import { filterCandidates, deriveIdentityKeys, emptyFilterStats } from "../../src/news/selection/dedupe-candidates.js";
import { MemoryNewsHistoryStore } from "../../src/news/selection/memory-news-history-store.js";
import { createSelectStage } from "../../src/news/stages/select-stage.js";
import { MemoryItemProcessingStore } from "../../src/readers/item-processing-store.js";

test("normalizeTitleKey folds NFKC/case/punctuation and only strips source suffixes when configured", () => {
  const a = normalizeTitleKey("ローカルPoCが初起動！");
  const b = normalizeTitleKey("ローカル ＰｏＣ が初起動");
  assert.equal(a, b, "full-width/half-width and punctuation must fold to the same key");
  assert.equal(normalizeTitleKey("Breaking News - Reuters"), normalizeTitleKey("breaking news - reuters"));
  const withSuffix = normalizeTitleKey("速報タイトル - Reuters", { sourceSuffixPatterns: [/\s*-\s*Reuters$/i] });
  const withoutSuffixStripped = normalizeTitleKey("速報タイトル", {});
  assert.equal(withSuffix, withoutSuffixStripped, "configured source-suffix patterns must be stripped before keying");
  assert.equal(normalizeTitleKey("a".repeat(300)).length, 240, "titleKey is capped at 240 chars");
});

test("computeUrlHash canonicalizes tracking params, fragments, default ports, and host case", () => {
  const base = computeUrlHash("https://Example.com:443/article/1");
  const withTracking = computeUrlHash("https://example.com/article/1?utm_source=twitter&ref=home#section");
  assert.equal(base, withTracking);
  assert.notEqual(base, computeUrlHash("https://example.com/article/2"));
  assert.equal(computeUrlHash("not a url"), null);
  assert.equal(computeUrlHash("ftp://example.com/file"), null, "non-http(s) schemes are rejected");
});

test("normalizeTopicKey strips known prefixes/brackets and rejects too-short keys", () => {
  assert.equal(normalizeTopicKey("【速報】株価が急落"), normalizeTopicKey("株価が急落"));
  assert.equal(normalizeTopicKey("続報：株価が急落"), normalizeTopicKey("株価が急落"));
  assert.equal(normalizeTopicKey("独自"), null, "a key shorter than minLength is invalid");
  assert.equal(normalizeTopicKey(""), null);
});

test("spam gate flags deterministic PR/affiliate/keyword-stuffing markers but passes ordinary corporate news", async () => {
  const gate = createSpamGate();
  assert.equal((await gate.classify({ title: "【PR】今だけ50%offクーポン配布中" })).verdict, "spam");
  assert.equal((await gate.classify({ title: "Acme Acme Acme Acme Acme 新製品発表", description: "" })).verdict, "spam");
  assert.equal((await gate.classify({ title: "中央銀行が政策金利を発表", description: "会見の詳細" })).verdict, "news");
});

test("spam gate falls back to uncertain (never excludes) when an optional classifier times out or errors", async () => {
  const timeoutGate = createSpamGate({ classifier: { id: "timeout-model", classify: async () => { throw new Error("timeout"); } } });
  assert.equal((await timeoutGate.classify({ title: "普通のニュース" })).verdict, "uncertain");
  const emptyGate = createSpamGate({ classifier: { id: "empty-model", classify: async () => null } });
  assert.equal((await emptyGate.classify({ title: "普通のニュース" })).verdict, "uncertain");
  const passthroughGate = createSpamGate({ classifier: { id: "m", classify: async () => ({ verdict: "spam", reasonCode: "custom" }) } });
  assert.equal((await passthroughGate.classify({ title: "普通のニュース" })).verdict, "spam");
});

test("MemoryNewsHistoryStore distinguishes delivered/spam outcomes and never records a bare selection", () => {
  const now = { value: 1_000_000 };
  const store = new MemoryNewsHistoryStore({ clock: () => now.value, maxEntries: 500, ttlDays: 30 });
  store.recordDelivered({ candidateId: "a", titleKey: "tk-a", topicKey: "topic-a", urlHash: "url-a", sourceId: "nhk" }, now.value);
  assert.equal(store.hasDeliveredTitle("tk-a"), true);
  assert.equal(store.hasDeliveredUrl("url-a"), true);
  assert.equal(store.hasRecentTopic("topic-a", now.value), true);
  store.recordSpam({ candidateId: "b", titleKey: "tk-b", topicKey: null, sourceId: "spammy" }, now.value);
  assert.equal(store.hasRecentSpam("tk-b", now.value), true);
  assert.equal(store.hasDeliveredTitle("tk-b"), false, "spam outcome must not count as a delivered duplicate");
  assert.deepEqual(store.recentSourceIds(10), ["nhk"], "only delivered outcomes count toward source diversity");
});

test("MemoryNewsHistoryStore expires entries by TTL and bounds by maxEntries", () => {
  const now = { value: 0 };
  const store = new MemoryNewsHistoryStore({ clock: () => now.value, maxEntries: 2, ttlDays: 1 });
  store.recordDelivered({ candidateId: "a", titleKey: "tk-a", sourceId: "s" }, now.value);
  now.value += 2 * 24 * 60 * 60 * 1000; // 2 days later, past the 1-day TTL
  assert.equal(store.hasDeliveredTitle("tk-a"), false, "expired entries stop counting as duplicates");

  now.value = 0;
  const bounded = new MemoryNewsHistoryStore({ clock: () => now.value, maxEntries: 2, ttlDays: 30 });
  bounded.recordDelivered({ candidateId: "1", titleKey: "t1", sourceId: "s" }, 1);
  bounded.recordDelivered({ candidateId: "2", titleKey: "t2", sourceId: "s" }, 2);
  bounded.recordDelivered({ candidateId: "3", titleKey: "t3", sourceId: "s" }, 3);
  assert.equal(bounded.list().length, 2, "oldest record is dropped once maxEntries is exceeded");
  assert.equal(bounded.hasDeliveredTitle("t1"), false);
  assert.equal(bounded.hasDeliveredTitle("t3"), true);
});

test("filterCandidates applies the documented exclusion order and records spam decisions into history", async () => {
  const now = 1_000;
  const historyStore = new MemoryNewsHistoryStore({ clock: () => now });
  historyStore.recordDelivered({ candidateId: "old", ...deriveIdentityKeys({ title: "既報のニュース", link: "https://example.com/old" }), sourceId: "s" }, now);

  const items = [
    { title: "", processingKey: "k-missing" }, // missing identity
    { title: "重複タイトル", link: "https://example.com/dup1", processingKey: "k-dup1" },
    { title: "重複タイトル", link: "https://example.com/dup2", processingKey: "k-dup2" }, // same-batch duplicate title
    { title: "既報のニュース", link: "https://example.com/old-again", processingKey: "k-past" }, // persistent duplicate title
    { title: "【PR】激安クーポン配布中", processingKey: "k-spam" },
    { title: "通常のニュース記事です", link: "https://example.com/fresh", sourceName: "s", processingKey: "k-ok" },
  ];
  const candidateKeys = new Set(items.map((i) => i.processingKey));
  const { eligible, stats } = await filterCandidates({ items, candidateKeys, historyStore, spamGate: createSpamGate(), now, topicCooldownMs: 1000 });

  assert.equal(stats.missingIdentity, 1);
  assert.equal(stats.duplicateTitle, 1);
  assert.equal(stats.pastTitle, 1);
  assert.equal(stats.spam, 1);
  assert.deepEqual(eligible.map((e) => e.item.processingKey), ["k-dup1", "k-ok"]);
  assert.equal(historyStore.hasRecentSpam(normalizeTitleKey("【PR】激安クーポン配布中")), true, "spam verdicts must be persisted so repeats stay excluded");
});

test("emptyFilterStats starts every counter at zero", () => {
  assert.deepEqual(emptyFilterStats(), { missingIdentity: 0, duplicateTitle: 0, duplicateTopic: 0, duplicateUrl: 0, pastTitle: 0, pastTopic: 0, pastUrl: 0, spam: 0 });
});

test("selection policy freshness halves at the configured half-life and floors unknown dates at 0.25", () => {
  const now = Date.parse("2026-07-16T12:00:00Z");
  const newest = { title: "newest", publishedAt: new Date(now).toISOString(), sourceName: "s", processingKey: "newest" };
  const halfLifeOld = { title: "half-life-old", publishedAt: new Date(now - 12 * 3600_000).toISOString(), sourceName: "s2", processingKey: "half" };
  const unknownDate = { title: "unknown", sourceName: "s3", processingKey: "unknown" };
  const policy = createSelectionPolicy({ freshnessHalfLifeHours: 12, rng: () => 0 });
  const historyStore = new MemoryNewsHistoryStore({ clock: () => now });
  const eligible = [newest, halfLifeOld, unknownDate].map((item) => ({ item, keys: deriveIdentityKeys(item) }));
  const { picks } = policy.select(eligible, { maxItems: 3, historyStore, now });
  const scoreOf = (id) => picks.find((p) => p.item.processingKey === id).score;
  assert.ok(Math.abs(scoreOf("half") - scoreOf("newest") * 0.5) < 1e-6, "score halves after exactly one half-life");
  assert.ok(Math.abs(scoreOf("unknown") - 0.25 * scoreOf("newest")) < 1e-6, "missing publishedAt uses the fixed 0.25 freshness weight");
});

test("selection policy clamps future timestamps to now and records a warning instead of over-scoring them", () => {
  const now = Date.parse("2026-07-16T12:00:00Z");
  const future = { title: "future", publishedAt: new Date(now + 3600_000).toISOString(), sourceName: "s", processingKey: "future" };
  const policy = createSelectionPolicy({ rng: () => 0 });
  const historyStore = new MemoryNewsHistoryStore({ clock: () => now });
  const { picks, warnings } = policy.select([{ item: future, keys: deriveIdentityKeys(future) }], { maxItems: 1, historyStore, now });
  assert.equal(picks[0].score, 0.35, "clamped-to-now freshness (1.0) times the headline-only content-quality weight (0.35)");
  assert.ok(warnings.some((w) => w.includes("future publishedAt clamped")));
});

test("source diversity penalizes sources that appear often or were just used", () => {
  const fresh = sourceDiversityWeight("nhk", { recentSourceIds: [] });
  const frequent = sourceDiversityWeight("nhk", { recentSourceIds: ["nhk", "nhk", "nhk"] });
  const justUsed = sourceDiversityWeight("nhk", { recentSourceIds: ["nhk"], lastSourceId: "nhk" });
  assert.ok(frequent < fresh);
  assert.ok(justUsed < fresh);
  assert.equal(sourceDiversityWeight("nhk", { recentSourceIds: [], sourcePriority: { nhk: 2 } }), 2);
});

test("weighted-random selection is deterministic given an injected rng, and max-score strategy always takes the top score", () => {
  const now = 0;
  const historyStore = new MemoryNewsHistoryStore({ clock: () => now });
  const low = { item: { title: "low", sourceName: "a", publishedAt: new Date(now - 48 * 3600_000).toISOString(), processingKey: "low" }, keys: {} };
  const high = { item: { title: "high", sourceName: "b", publishedAt: new Date(now).toISOString(), processingKey: "high" }, keys: {} };
  const maxPolicy = createSelectionPolicy({ strategy: "max-score" });
  assert.equal(maxPolicy.select([low, high], { maxItems: 1, historyStore, now }).picks[0].item.processingKey, "high");

  const seededPolicy = createSelectionPolicy({ strategy: "weighted-random", rng: () => 0.999 });
  const { picks: firstRun } = seededPolicy.select([low, high], { maxItems: 1, historyStore, now });
  const { picks: secondRun } = seededPolicy.select([low, high], { maxItems: 1, historyStore, now });
  assert.equal(firstRun[0].item.processingKey, secondRun[0].item.processingKey, "the same rng sequence must pick the same candidate");
});

test("multiple picks avoid repeating the same topic/source until alternatives are exhausted", () => {
  const now = 0;
  const historyStore = new MemoryNewsHistoryStore({ clock: () => now });
  const items = [
    { title: "株価ニュースA", sourceName: "nhk", publishedAt: new Date(now).toISOString(), processingKey: "a" },
    { title: "株価ニュースB", sourceName: "nhk", publishedAt: new Date(now).toISOString(), processingKey: "b" },
    { title: "別の話題", sourceName: "asahi", publishedAt: new Date(now).toISOString(), processingKey: "c" },
  ];
  const eligible = items.map((item) => ({ item, keys: deriveIdentityKeys(item) }));
  const policy = createSelectionPolicy({ rng: () => 0 });
  const { picks } = policy.select(eligible, { maxItems: 2, historyStore, now });
  const sources = picks.map((p) => p.item.sourceName);
  assert.equal(new Set(sources).size, 2, "the second pick must come from a different source when one is available");
});

test("createSelectStage wires acquisition -> ItemProcessingStore -> dedupe/spam/selection end-to-end", async () => {
  const now = { value: 1000 };
  const store = new MemoryItemProcessingStore({ clock: () => now.value });
  const historyStore = new MemoryNewsHistoryStore({ clock: () => now.value });
  const stage = createSelectStage({ store, clock: () => now.value, historyStore });
  const items = [
    { title: "通常のニュース記事です", link: "https://example.com/1", sourceName: "s", publishedAt: "2026-07-16T00:00:00Z", guid: "1", processingKey: "news:1" },
    { title: "【PR】激安セール開催中", link: "https://example.com/2", sourceName: "s", publishedAt: "2026-07-16T00:00:00Z", guid: "2", processingKey: "news:2" },
  ];
  const result = await stage.run({ items, generation: 1, maxItems: 3 }, {});
  assert.deepEqual(result.picks.map((p) => p.processingKey), ["news:1"]);
  assert.equal(result.stats.spam, 1);
});

test("createSelectStage exposes keysByProcessingKey computed with the same sourceSuffixPatterns used for dedupe, so the coordinator can commit history without re-deriving a different key", async () => {
  const now = { value: 1000 };
  const store = new MemoryItemProcessingStore({ clock: () => now.value });
  const historyStore = new MemoryNewsHistoryStore({ clock: () => now.value });
  const sourceSuffixPatterns = [/\s*-\s*Reuters$/i];
  const stage = createSelectStage({ store, clock: () => now.value, historyStore, sourceSuffixPatterns });
  const item = { title: "速報タイトル - Reuters", link: "https://example.com/1", sourceName: "s", publishedAt: "2026-07-16T00:00:00Z", guid: "1", processingKey: "news:1" };
  const result = await stage.run({ items: [item], generation: 1, maxItems: 3 }, {});
  assert.deepEqual(result.picks.map((p) => p.processingKey), ["news:1"]);
  const keys = result.keysByProcessingKey.get("news:1");
  assert.equal(keys.titleKey, normalizeTitleKey("速報タイトル - Reuters", { sourceSuffixPatterns }), "the exposed key must match what filterCandidates used for dedupe, not a plain (no-patterns) re-derivation");
});
