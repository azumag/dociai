import assert from "node:assert/strict";
import { validateConfig, applyDefaults } from "../src/config-loader.js";
import { ContextBuilder } from "../src/context-builder.js";
import { NewsReader } from "../src/news-reader.js";
import { TopicReader } from "../src/topic-reader.js";

const baseConfig = {
  connectors: {
    mock_main: { provider: "mock" },
  },
  personas: [
    {
      id: "news_ai",
      name: "ニュースAI",
      connector: "mock_main",
      systemPrompt: "ニュース担当です。",
    },
  ],
  triggers: {
    news_interval: { type: "interval", seconds: 30 },
  },
  news: {
    enabled: true,
    trigger: "news_interval",
    persona: "news_ai",
    mode: "current",
    sources: [{ name: "mock", type: "mock" }],
    maxItems: 10,
  },
};

const validation = validateConfig(baseConfig);
assert.deepEqual(validation.errors, []);

const config = applyDefaults(baseConfig);
const contextBuilder = new ContextBuilder({
  commentStore: { streamSummary: "", recent: () => [] },
  config,
});
const reader = new NewsReader({
  config,
  getConnector: () => ({ chat: async () => ({ text: "ok" }) }),
  personaRouter: {
    get: () => config.personas[0],
    defaultPersona: () => config.personas[0],
  },
  contextBuilder,
  speechQueue: { enqueue: () => {} },
});

const items = await reader.fetchAll();
assert.equal(items.length, 3);
assert.deepEqual(items.map((item) => item.guid), ["mock-3", "mock-2", "mock-1"]);
assert.ok(items.every((item) => item.normalizedTitle));

const { debugText } = contextBuilder.build({ persona: config.personas[0], news: items[0], includeScreen: "never" });
assert.match(debugText, /時事モード/);
assert.match(debugText, /短い考察/);
assert.match(debugText, /ソース: mock/);
assert.match(debugText, /日時: 2026-07-01T09:10:00\+09:00/);

const invalid = validateConfig({
  ...baseConfig,
  news: { ...baseConfig.news, mode: "deep", sources: [{ name: "bad", type: "rss" }] },
});
assert.ok(invalid.errors.some((e) => e.includes('news.mode "deep"')));
assert.ok(invalid.errors.some((e) => e.includes("news.sources[bad].url")));

const legacyTodoistConfig = {
  ...baseConfig,
  news: {
    ...baseConfig.news,
    sources: [{ name: "legacy-todoist", type: "todoist", token: "todoist-token", projectId: "p1" }],
    topicIntro: "この話題に反応してください。",
    topicStyle: "雑談っぽく短く返す",
  },
};
const legacyValidation = validateConfig(legacyTodoistConfig);
assert.deepEqual(legacyValidation.errors, []);
assert.ok(legacyValidation.warnings.some((w) => w.includes("news から分離")));
const migrated = applyDefaults(legacyTodoistConfig);
assert.equal(migrated.news.enabled, false);
assert.equal(migrated.news.sources.length, 0);
assert.equal(migrated.topics.enabled, true);
assert.equal(migrated.topics.sources[0].type, "todoist");
assert.equal(migrated.topics.intro, "この話題に反応してください。");

const topicConfig = applyDefaults({
  ...baseConfig,
  triggers: {
    ...baseConfig.triggers,
    topics_interval: { type: "interval", seconds: 45 },
  },
  topics: {
    enabled: true,
    trigger: "topics_interval",
    persona: "news_ai",
    sources: [{ name: "todoist", type: "todoist", token: "todoist-token", projectId: "p1" }],
    maxItems: 5,
    intro: "拾った話題にコメントしてください。",
    style: "自然な雑談",
  },
});
const topicContextBuilder = new ContextBuilder({
  commentStore: { streamSummary: "", recent: () => [] },
  config: topicConfig,
});

const originalFetch = globalThis.fetch;
const fetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url: String(url), method: init.method ?? "GET", auth: init.headers?.Authorization ?? "" });
  if (String(url).includes("/tasks?")) {
    return {
      ok: true,
      json: async () => ({
        results: [
          { id: "t2", project_id: "p1", content: "次の配信で話すネタ", description: "メモ本文", created_at: "2026-07-01T10:00:00+09:00" },
          { id: "other", project_id: "p2", content: "別プロジェクト" },
        ],
      }),
    };
  }
  if (String(url).endsWith("/tasks/t2/close")) {
    return { ok: true };
  }
  throw new Error(`unexpected fetch ${url}`);
};

try {
  const topicReader = new TopicReader({
    config: topicConfig,
    getConnector: () => ({ chat: async () => ({ text: "topic ok" }) }),
    personaRouter: {
      get: () => topicConfig.personas[0],
      defaultPersona: () => topicConfig.personas[0],
    },
    contextBuilder: topicContextBuilder,
    speechQueue: { enqueue: () => {} },
  });
  const topicItems = await topicReader.fetchAll();
  assert.equal(topicItems.length, 1);
  assert.equal(topicItems[0].guid, "todoist:t2");
  const topicPrompt = topicContextBuilder.build({ persona: topicConfig.personas[0], topic: topicItems[0], includeScreen: "never" }).debugText;
  assert.match(topicPrompt, /拾った話題/);
  assert.match(topicPrompt, /拾った話題にコメントしてください。/);
  assert.match(topicPrompt, /自然な雑談/);

  await topicReader.run();
  assert.equal(topicReader.status().readCount, 1);
  assert.ok(fetchCalls.some((c) => c.url.endsWith("/tasks/t2/close") && c.method === "POST"));
  assert.ok(fetchCalls.every((c) => c.auth === "Bearer todoist-token"));
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS | news reader refinement, topic split, and mode prompts");
