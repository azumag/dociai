import assert from "node:assert/strict";
import test from "node:test";
import { buildNewsPrompt, shrinkResearchToFit } from "../../src/news/generation/news-prompt-builder.js";
import { createNewsGenerationService } from "../../src/news/generation/news-generation-service.js";
import { NEWS_OUTPUT_MARKERS } from "../../src/news/generation/news-output-contract.js";
import { resolveModePolicy } from "../../src/news/mode-policy.js";

const persona = { id: "p", name: "P", connector: "main", systemPrompt: "あなたは元気なAI配信者です。" };
const candidate = { title: "テストニュース", sourceName: "mock", publishedAt: "2026-07-16T00:00:00Z", description: "概要テキスト", processingKey: "news:1" };

test("buildNewsPrompt applies mode-specific length/opinion rules instead of the generic 2-sentence rule", () => {
  const topic = buildNewsPrompt({ candidate, persona, policy: resolveModePolicy("topic") });
  assert.match(topic.messages[1].content, /200〜500字程度/);
  assert.doesNotMatch(topic.messages[0].content, /2文以内/);

  const current = buildNewsPrompt({ candidate, persona, policy: resolveModePolicy("current") });
  assert.match(current.messages[1].content, /800〜1600字程度/);
  assert.match(current.messages[1].content, /複数の見方/);

  const simple = buildNewsPrompt({ candidate, persona, policy: resolveModePolicy("simple") });
  assert.match(simple.messages[1].content, /300〜800字程度/);
  assert.match(simple.messages[1].content, /独自の考察.*しないでください/);
});

test("buildNewsPrompt integrates the persona system prompt and requires the structured output markers", () => {
  const { messages } = buildNewsPrompt({ candidate, persona, policy: resolveModePolicy("topic") });
  assert.match(messages[0].content, /あなたは元気なAI配信者です/);
  for (const marker of Object.values(NEWS_OUTPUT_MARKERS)) assert.match(messages[1].content, new RegExp(marker.replace(/[=]/g, "\\=")));
});

test("buildNewsPrompt bans the internal-事情/markdown/URL leakage and requires foreign-title translation", () => {
  const { messages } = buildNewsPrompt({ candidate, persona, policy: resolveModePolicy("topic") });
  assert.match(messages[0].content, /外国語の見出しは自然な日本語へ翻訳し/);
  assert.match(messages[0].content, /markdown、箇条書き記号、URL/);
  assert.match(messages[0].content, /tool利用、検索失敗、prompt、モデル名/);
});

test("buildNewsPrompt explicitly tells the model there is no research when research is null", () => {
  const { messages } = buildNewsPrompt({ candidate, persona, policy: resolveModePolicy("current"), research: null });
  assert.match(messages[1].content, /調査結果はありません/);
});

test("buildNewsPrompt renders facts/background/viewpoints/unresolved/sources and keeps them out of the raw JSON shape", () => {
  const research = {
    facts: [{ text: "株価が5%下落した", sourceIds: ["s1"], confidence: "high" }],
    background: ["前回の決算は黒字だった"],
    viewpoints: ["アナリストは一時的な調整とみている"],
    unresolved: ["下落の直接原因は未確認"],
    sources: [{ id: "s1", sourceName: "Reuters" }],
  };
  const { messages } = buildNewsPrompt({ candidate, persona, policy: resolveModePolicy("current"), research });
  assert.match(messages[1].content, /株価が5%下落した/);
  assert.match(messages[1].content, /前回の決算は黒字だった/);
  assert.match(messages[1].content, /アナリストは一時的な調整とみている/);
  assert.match(messages[1].content, /下落の直接原因は未確認/);
  assert.match(messages[1].content, /Reuters/);
});

test("buildNewsPrompt includes recent topics and a rewrite addendum that forbids reusing the previous draft", () => {
  const { messages } = buildNewsPrompt({ candidate, persona, policy: resolveModePolicy("topic"), recentTopics: ["昨日読んだ話題A"], rewriteFeedback: [{ code: "repetition", message: "同じ文の反復が検出されました" }] });
  assert.match(messages[1].content, /昨日読んだ話題A/);
  assert.match(messages[1].content, /前回の文章は使い回さず/);
  assert.match(messages[1].content, /同じ文の反復が検出されました/);
});

test("shrinkResearchToFit drops low-confidence facts before viewpoints/background, and keeps at least one fact", () => {
  const research = {
    facts: [
      { text: "低確度の事実", confidence: "low" },
      { text: "高確度の事実", confidence: "high" },
    ],
    background: ["背景情報"],
    viewpoints: ["視点A"],
    unresolved: [],
    sources: [],
  };
  const shrunk = shrinkResearchToFit(research, 10); // 極端に小さい上限で強制的に縮約させる
  assert.equal(shrunk.facts.length, 1, "at least one fact survives even under an impossible budget");
  assert.equal(shrunk.facts[0].confidence, "high", "low-confidence facts are dropped first");
  assert.equal(shrunk.viewpoints.length, 0);
  assert.equal(shrunk.background.length, 0);
});

test("shrinkResearchToFit is a no-op when research already fits and passes through null", () => {
  assert.equal(shrinkResearchToFit(null, 100), null);
  const research = { facts: [{ text: "短い事実", confidence: "high" }], background: [], viewpoints: [], unresolved: [], sources: [] };
  assert.deepEqual(shrinkResearchToFit(research, 10_000), research);
});

test("NewsGenerationService returns the primary connector's result and records the fallback path", async () => {
  const service = createNewsGenerationService({ getConnector: (id) => (id === "main" ? { chat: async () => ({ text: "hello", finishReason: "stop" }) } : null) });
  const result = await service.generate({ candidate, research: null, persona, policy: resolveModePolicy("topic"), recentTopics: [], connectorId: "main", requestId: "r1", context: {} });
  assert.equal(result.text, "hello");
  assert.equal(result.connectorId, "main");
  assert.deepEqual(result.fallbackPath, [{ connectorId: "main", status: "ok" }]);
});

test("NewsGenerationService falls back only on timeout/network/rate_limit/server, never on auth/bad_request", async () => {
  const retryable = createNewsGenerationService({
    getConnector: (id) => (id === "main"
      ? { chat: async () => { throw Object.assign(new Error("slow"), { kind: "timeout" }); } }
      : { chat: async () => ({ text: "fallback ok" }) }),
  });
  const result = await retryable.generate({ candidate, research: null, persona, policy: resolveModePolicy("topic"), connectorId: "main", fallbackConnectorIds: ["local"], requestId: "r1", context: {} });
  assert.equal(result.text, "fallback ok");
  assert.equal(result.connectorId, "local");
  assert.deepEqual(result.fallbackPath.map((f) => f.status), ["failed", "ok"]);

  const authFailing = createNewsGenerationService({
    getConnector: (id) => (id === "main"
      ? { chat: async () => { throw Object.assign(new Error("bad key"), { kind: "auth" }); } }
      : { chat: async () => ({ text: "should not be reached" }) }),
  });
  await assert.rejects(
    authFailing.generate({ candidate, research: null, persona, policy: resolveModePolicy("topic"), connectorId: "main", fallbackConnectorIds: ["local"], requestId: "r1", context: {} }),
    (error) => error.kind === "auth",
  );
});

test("NewsGenerationService throws the last error when every connector in the chain fails", async () => {
  const service = createNewsGenerationService({ getConnector: () => ({ chat: async () => { throw Object.assign(new Error("down"), { kind: "network" }); } }) });
  await assert.rejects(
    service.generate({ candidate, research: null, persona, policy: resolveModePolicy("topic"), connectorId: "main", fallbackConnectorIds: ["local"], requestId: "r1", context: {} }),
    (error) => error.kind === "network",
  );
});
