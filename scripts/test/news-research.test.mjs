import assert from "node:assert/strict";
import test from "node:test";

import { buildQueries } from "../../src/news/research/query-builder.js";
import { normalizeEvidenceFact, normalizeSourceCitation } from "../../src/news/research/evidence-normalizer.js";
import { mergeProviderResults } from "../../src/news/research/source-merger.js";
import { emptyResearchBundle } from "../../src/news/research/research-bundle.js";
import { buildResearchCacheKey, createResearchCache } from "../../src/news/research/research-cache.js";
import { createProviderResult } from "../../src/news/research/research-provider.js";
import { createResearchCoordinator } from "../../src/news/research/research-coordinator.js";
import { createGroundingResearchStage, createResearchStage } from "../../src/news/stages/research-stage.js";
import { RequestCancelledError } from "../../src/runtime/request-registry.js";

test("buildQueries strips decorations and produces a shortened secondary query", () => {
  assert.deepEqual(buildQueries("  "), []);
  assert.deepEqual(buildQueries(null), []);

  const decorated = "【速報】東京都、新条例を可決、来月から施行 - 朝日新聞";
  const queries = buildQueries(decorated);
  assert.ok(queries.length >= 1);
  assert.ok(!queries[0].startsWith("【"));
  assert.ok(!queries[0].includes("速報"));
  assert.ok(!queries[0].endsWith("朝日新聞"));

  const short = buildQueries("短い");
  assert.deepEqual(short, ["短い"]);

  const capped = buildQueries("x".repeat(200), { maxQueryLength: 10 });
  assert.equal(capped[0].length, 10);

  const limited = buildQueries("見出し、続き、さらに続き", { maxQueries: 1 });
  assert.equal(limited.length, 1);
});

test("normalizeEvidenceFact falls back to defaults for invalid confidence/kind", () => {
  const normalized = normalizeEvidenceFact({ text: "  事実A  ", confidence: "bogus", kind: "bogus" }, { kind: "background", defaultConfidence: "low" });
  assert.equal(normalized.text, "事実A");
  assert.equal(normalized.confidence, "low");
  assert.equal(normalized.kind, "background");

  const valid = normalizeEvidenceFact({ text: "事実B", confidence: "high", kind: "viewpoint", sourceUrl: "https://example.com", sourceName: "Example" });
  assert.equal(valid.confidence, "high");
  assert.equal(valid.kind, "viewpoint");
  assert.equal(valid.sourceUrl, "https://example.com");
});

test("normalizeSourceCitation defaults missing fields safely", () => {
  const citation = normalizeSourceCitation({ url: "https://example.com/a", sourceName: "Example" });
  assert.deepEqual(citation, { url: "https://example.com/a", sourceName: "Example", publishedAt: null, license: null, isPrimary: false });
  assert.equal(normalizeSourceCitation({}).sourceName, "");
});

test("emptyResearchBundle provides a fully-shaped fallback bundle", () => {
  const bundle = emptyResearchBundle({ candidateId: "c1" });
  assert.equal(bundle.candidateId, "c1");
  assert.deepEqual(bundle.facts, []);
  assert.equal(bundle.coverage.sourceCount, 0);
});

test("mergeProviderResults dedupes facts by text, promotes confidence when 2+ independent sources agree, and flags numeric conflicts", () => {
  const results = [
    createProviderResult("article", {
      facts: [{ text: "現場からの報道によると死者数は12人に上るとみられている", sourceUrl: "https://a.example/1", sourceName: "A", confidence: "medium", kind: "fact" }],
      sources: [{ url: "https://a.example/1", sourceName: "A" }],
    }),
    createProviderResult("news-search", {
      facts: [
        { text: "現場からの報道によると死者数は12人に上るとみられている", sourceUrl: "https://b.example/2", sourceName: "B", confidence: "medium", kind: "fact" },
        { text: "現場からの報道によると死者数は15人に上るとみられている", sourceUrl: "https://c.example/3", sourceName: "C", confidence: "medium", kind: "fact" },
      ],
      sources: [{ url: "https://b.example/2", sourceName: "B" }, { url: "https://c.example/3", sourceName: "C" }],
    }),
    createProviderResult("wikipedia", {
      facts: [{ text: "この地域の背景情報です", sourceUrl: "https://ja.wikipedia.org/wiki/x", sourceName: "Wikipedia", confidence: "medium", kind: "background" }],
      sources: [{ url: "https://ja.wikipedia.org/wiki/x", sourceName: "Wikipedia" }],
    }),
  ];

  const merged = mergeProviderResults("candidate-1", "見出し", results);

  assert.equal(merged.candidateId, "candidate-1");
  assert.equal(merged.headline, "見出し");
  assert.equal(merged.background.length, 1);
  assert.equal(merged.sources.length, 4);
  assert.equal(merged.coverage.sourceCount, 4);
  assert.equal(merged.coverage.independentPublisherCount, 4);

  const sharedFact = merged.facts.find((f) => f.text === "現場からの報道によると死者数は12人に上るとみられている");
  assert.ok(sharedFact);
  assert.equal(sharedFact.confidence, "high");
  assert.equal(sharedFact.sourceIds.length, 2);

  assert.equal(merged.coverage.hasConflictingClaims, true);
  assert.ok(merged.unresolved.some((entry) => entry.includes("数値が食い違")));
});

test("mergeProviderResults handles a single source without inflating confidence or manufacturing conflicts", () => {
  const results = [
    createProviderResult("article", {
      facts: [{ text: "単独ソースの事実です", sourceUrl: "https://only.example/1", sourceName: "Only", confidence: "medium", kind: "fact" }],
      sources: [{ url: "https://only.example/1", sourceName: "Only", isPrimary: true }],
    }),
  ];
  const merged = mergeProviderResults("c2", "見出し2", results);
  assert.equal(merged.facts[0].confidence, "medium");
  assert.equal(merged.coverage.hasConflictingClaims, false);
  assert.equal(merged.coverage.hasPrimarySource, true);
  assert.deepEqual(merged.unresolved, []);
});

test("mergeProviderResults carries forward provider-reported unresolved entries without flagging them as a conflicting claim", () => {
  const results = [createProviderResult("llm", { facts: [], sources: [], unresolved: ["情報源間で発表時刻が食い違う"] })];
  const merged = mergeProviderResults("c3", "見出し3", results);
  assert.deepEqual(merged.unresolved, ["情報源間で発表時刻が食い違う"]);
  assert.equal(merged.coverage.hasConflictingClaims, false, "a provider note is not itself a detected numeric conflict");
});

test("mergeProviderResults does not promote confidence when the only 2 corroborating sources share the same publisher host", () => {
  const results = [
    createProviderResult("article", {
      facts: [{ text: "同じ主張です", sourceUrl: "https://news.example/a/1", sourceName: "Example" }],
      sources: [{ url: "https://news.example/a/1", sourceName: "Example" }],
    }),
    createProviderResult("news-search", {
      facts: [{ text: "同じ主張です", sourceUrl: "https://news.example/a/2", sourceName: "Example" }],
      sources: [{ url: "https://news.example/a/2", sourceName: "Example" }],
    }),
  ];
  const merged = mergeProviderResults("c4", "見出し4", results);
  const fact = merged.facts.find((f) => f.text === "同じ主張です");
  assert.equal(fact.sourceIds.length, 2, "still records both source citations");
  assert.equal(fact.confidence, "medium", "same-host reprints must not count as independent corroboration");
  assert.equal(merged.coverage.independentPublisherCount, 1);
});

test("mergeProviderResults does not treat a numeric superset as a conflict, but does flag genuinely different numbers", () => {
  const supersetResults = [
    createProviderResult("article", { facts: [{ text: "この事故で死者12人が確認された", sourceUrl: "https://a.example/1", sourceName: "A" }], sources: [{ url: "https://a.example/1", sourceName: "A" }] }),
    createProviderResult("news-search", { facts: [{ text: "この事故で死者12人、負傷者3人が確認された", sourceUrl: "https://b.example/2", sourceName: "B" }], sources: [{ url: "https://b.example/2", sourceName: "B" }] }),
  ];
  const supersetMerged = mergeProviderResults("c5", "見出し5", supersetResults);
  assert.equal(supersetMerged.coverage.hasConflictingClaims, false, "additional non-contradicting numbers must not be flagged as a conflict");

  const genuineConflict = [
    createProviderResult("article", { facts: [{ text: "この事故で死者12人が確認された", sourceUrl: "https://a.example/1", sourceName: "A" }], sources: [{ url: "https://a.example/1", sourceName: "A" }] }),
    createProviderResult("news-search", { facts: [{ text: "この事故で死者15人が確認された", sourceUrl: "https://b.example/2", sourceName: "B" }], sources: [{ url: "https://b.example/2", sourceName: "B" }] }),
  ];
  assert.equal(mergeProviderResults("c6", "見出し6", genuineConflict).coverage.hasConflictingClaims, true);
});

test("mergeProviderResults normalizes full-width digits so half-width/full-width duplicate facts dedupe and conflict-detect correctly", () => {
  const dedupeAcrossWidths = [
    createProviderResult("article", { facts: [{ text: "死者は12人と発表された", sourceUrl: "https://a.example/1", sourceName: "A" }], sources: [{ url: "https://a.example/1", sourceName: "A" }] }),
    createProviderResult("news-search", { facts: [{ text: "死者は１２人と発表された", sourceUrl: "https://b.example/2", sourceName: "B" }], sources: [{ url: "https://b.example/2", sourceName: "B" }] }),
  ];
  const merged = mergeProviderResults("c7", "見出し7", dedupeAcrossWidths);
  assert.equal(merged.facts.length, 1, "full-width and half-width digit variants of the same fact must dedupe to one entry");
  assert.equal(merged.facts[0].confidence, "high");

  const fullWidthConflict = [
    createProviderResult("article", { facts: [{ text: "この事故で死者12人が確認された", sourceUrl: "https://a.example/1", sourceName: "A" }], sources: [{ url: "https://a.example/1", sourceName: "A" }] }),
    createProviderResult("news-search", { facts: [{ text: "この事故で死者１５人が確認された", sourceUrl: "https://b.example/2", sourceName: "B" }], sources: [{ url: "https://b.example/2", sourceName: "B" }] }),
  ];
  assert.equal(mergeProviderResults("c8", "見出し8", fullWidthConflict).coverage.hasConflictingClaims, true, "a full-width digit must still be recognized as a genuinely conflicting number");
});

test("mergeProviderResults strips thousands-separator commas before comparing numbers, so '1,000' and '1000' are recognized as the same value", () => {
  const sameValueDifferentGrouping = [
    createProviderResult("article", { facts: [{ text: "現場からの報道によると死者数は1,000人に上るとみられている", sourceUrl: "https://a.example/1", sourceName: "A" }], sources: [{ url: "https://a.example/1", sourceName: "A" }] }),
    createProviderResult("news-search", { facts: [{ text: "現場からの報道によると死者数は1000人に上るとみられている", sourceUrl: "https://b.example/2", sourceName: "B" }], sources: [{ url: "https://b.example/2", sourceName: "B" }] }),
  ];
  assert.equal(mergeProviderResults("c9", "見出し9", sameValueDifferentGrouping).coverage.hasConflictingClaims, false, "'1,000' and '1000' are the same number and must not be flagged as a conflict");
});

test("buildResearchCacheKey buckets by hour, includes researchMode/candidateId to avoid cross-candidate leakage, and createResearchCache expires entries by TTL", () => {
  const now = Date.parse("2026-07-17T10:30:00Z");
  const key = buildResearchCacheKey({ query: "テスト", mode: "current", now, researchMode: "multi_source", candidateId: "c1" });
  assert.equal(key, "current:multi_source:c1:2026-07-17T10:テスト");

  const other = buildResearchCacheKey({ query: "テスト", mode: "current", now, researchMode: "multi_source", candidateId: "c2" });
  assert.notEqual(key, other, "different candidates sharing a cleaned query must not collide");

  const differentResearchMode = buildResearchCacheKey({ query: "テスト", mode: "current", now, researchMode: "article", candidateId: "c1" });
  assert.notEqual(key, differentResearchMode, "different researchMode must not collide even for the same candidate/query");

  let time = 1000;
  const cache = createResearchCache({ ttlMs: 500, clock: () => time });
  cache.set("k", { value: 1 });
  assert.deepEqual(cache.get("k"), { value: 1 });
  time = 1600;
  assert.equal(cache.get("k"), null);

  cache.set("k2", { value: 2 });
  cache.clear();
  assert.equal(cache.get("k2"), null);
});

function fakeProvider(id, { supports = () => true, result = null, error = null } = {}) {
  return {
    id,
    supports,
    async research() {
      if (error) throw error;
      return result;
    },
  };
}

test("createResearchCoordinator selects providers by modePolicy.research", async () => {
  const seen = [];
  const providers = [
    fakeProvider("article", { result: createProviderResult("article", { facts: [{ text: "記事本文の事実", sourceUrl: "https://a.example", sourceName: "A" }] }) }),
    { id: "news-search", supports: () => { seen.push("news-search:supports"); return true; }, async research() { seen.push("news-search:research"); return null; } },
  ];
  const coordinator = createResearchCoordinator({ providers });

  const candidate = { title: "テストの見出しです", processingKey: "p1" };

  const noneResult = await coordinator.research({ candidate, mode: "current", modePolicy: { research: "none" } });
  assert.equal(noneResult, null);
  assert.deepEqual(seen, []);

  const articleOnlyResult = await coordinator.research({ candidate, mode: "current", modePolicy: { research: "article" } });
  assert.ok(articleOnlyResult);
  assert.equal(articleOnlyResult.facts[0].text, "記事本文の事実");
  assert.deepEqual(seen, []);

  const multiResult = await coordinator.research({ candidate, mode: "current", modePolicy: { research: "multi_source" } });
  assert.ok(multiResult);
  assert.deepEqual(seen, ["news-search:supports", "news-search:research"]);
  assert.deepEqual(multiResult.fallbackPath, ["article:ok", "news-search:empty"]);
});

test("createResearchCoordinator isolates a single provider's failure without aborting the others", async () => {
  const providers = [
    fakeProvider("article", { error: new Error("boom") }),
    fakeProvider("news-search", { result: createProviderResult("news-search", { facts: [{ text: "検索から得た事実", sourceUrl: "https://b.example", sourceName: "B" }] }) }),
  ];
  const coordinator = createResearchCoordinator({ providers });
  const bundle = await coordinator.research({ candidate: { title: "見出し" }, mode: "current", modePolicy: { research: "multi_source" } });
  assert.ok(bundle);
  assert.equal(bundle.facts[0].text, "検索から得た事実");
  assert.deepEqual(bundle.fallbackPath, ["article:failed", "news-search:ok"]);
});

test("createResearchCoordinator re-throws cancellation instead of swallowing it", async () => {
  const providers = [fakeProvider("article", { error: new RequestCancelledError("cancelled") })];
  const coordinator = createResearchCoordinator({ providers });
  await assert.rejects(
    coordinator.research({ candidate: { title: "見出し" }, mode: "current", modePolicy: { research: "multi_source" } }),
    (error) => error instanceof RequestCancelledError,
  );
});

test("createResearchCoordinator returns null when no provider supports the request or all return empty", async () => {
  const unsupported = createResearchCoordinator({ providers: [fakeProvider("article", { supports: () => false })] });
  assert.equal(await unsupported.research({ candidate: { title: "見出し" }, mode: "current", modePolicy: { research: "multi_source" } }), null);

  const empty = createResearchCoordinator({ providers: [fakeProvider("article", { result: null })] });
  assert.equal(await empty.research({ candidate: { title: "見出し" }, mode: "current", modePolicy: { research: "multi_source" } }), null);
});

test("createResearchCoordinator caches bundles by query+mode+hour bucket", async () => {
  let calls = 0;
  const provider = {
    id: "article",
    supports: () => true,
    async research() {
      calls += 1;
      return createProviderResult("article", { facts: [{ text: `事実${calls}` }] });
    },
  };
  let time = Date.parse("2026-07-17T10:00:00Z");
  const cache = createResearchCache({ clock: () => time });
  const coordinator = createResearchCoordinator({ providers: [provider], cache, clock: () => time });

  const candidate = { title: "キャッシュされる見出し" };
  const first = await coordinator.research({ candidate, mode: "current", modePolicy: { research: "article" } });
  const second = await coordinator.research({ candidate, mode: "current", modePolicy: { research: "article" } });
  assert.equal(first.facts[0].text, second.facts[0].text);
  assert.equal(calls, 1);

  time = Date.parse("2026-07-17T12:00:00Z");
  const third = await coordinator.research({ candidate, mode: "current", modePolicy: { research: "article" } });
  assert.equal(calls, 2);
  assert.notEqual(third.facts[0].text, first.facts[0].text);
});

test("createResearchCoordinator's cache does not leak one candidate's bundle to a different candidate that cleans to the same query, nor across a researchMode change for the same candidate", async () => {
  let calls = 0;
  const provider = {
    id: "article",
    supports: () => true,
    async research() {
      calls += 1;
      return createProviderResult("article", { facts: [{ text: `事実${calls}` }] });
    },
  };
  const time = Date.parse("2026-07-17T10:00:00Z");
  const cache = createResearchCache({ clock: () => time });
  const coordinator = createResearchCoordinator({ providers: [provider], cache, clock: () => time });

  const candidateA = { title: "首相が辞任", processingKey: "cand-a" };
  const candidateB = { title: "首相が辞任", processingKey: "cand-b" };
  const first = await coordinator.research({ candidate: candidateA, mode: "current", modePolicy: { research: "article" } });
  const second = await coordinator.research({ candidate: candidateB, mode: "current", modePolicy: { research: "article" } });
  assert.equal(calls, 2, "two different candidates sharing a cleaned query must each trigger their own provider call");
  assert.equal(first.candidateId, "cand-a");
  assert.equal(second.candidateId, "cand-b");

  const cachedAgain = await coordinator.research({ candidate: candidateA, mode: "current", modePolicy: { research: "article" } });
  assert.equal(calls, 2, "the same candidate/mode/researchMode must still hit the cache");
  assert.equal(cachedAgain.candidateId, "cand-a");

  const changedResearchMode = await coordinator.research({ candidate: candidateA, mode: "current", modePolicy: { research: "multi_source" } });
  assert.ok(changedResearchMode);
  assert.equal(calls, 3, "a researchMode change for the same candidate/mode/query must not reuse a stale cache entry");
});

test("createResearchStage (legacy no-op default) always returns null", async () => {
  const stage = createResearchStage();
  assert.equal(stage.id, "research");
  assert.equal(await stage.run({ item: { title: "見出し" }, modePolicy: { research: "multi_source" } }, {}), null);
});

test("createGroundingResearchStage translates {item, modePolicy} into a coordinator call and honors capability gating", async () => {
  const article = fakeProvider("article", { result: createProviderResult("article", { facts: [{ text: "記事本文の事実" }] }) });
  let capabilitiesSeen = null;
  const newsSearch = {
    id: "news-search",
    supports(_input, capabilities) { capabilitiesSeen = capabilities; return Boolean(capabilities.newsSearch); },
    async research() { return createProviderResult("news-search", { facts: [{ text: "検索の事実" }] }); },
  };
  const stage = createGroundingResearchStage({
    providers: [article, newsSearch],
    getCapabilities: () => ({ newsSearch: false, wikipedia: false }),
  });
  assert.equal(stage.id, "research");

  const bundle = await stage.run({ item: { title: "見出し", processingKey: "p1" }, modePolicy: { mode: "current", research: "multi_source" } }, { requestId: "req-1" });
  assert.ok(bundle);
  assert.deepEqual(bundle.fallbackPath, ["article:ok", "news-search:unsupported"]);
  assert.deepEqual(capabilitiesSeen, { newsSearch: false, wikipedia: false });

  const noneBundle = await stage.run({ item: { title: "見出し" }, modePolicy: { mode: "current", research: "none" } }, {});
  assert.equal(noneBundle, null);
});
