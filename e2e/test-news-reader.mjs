import assert from "node:assert/strict";
import { validateConfig, applyDefaults } from "../src/config-loader.js";
import { ContextBuilder } from "../src/context-builder.js";
import { NewsReader } from "../src/news-reader.js";

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

console.log("PASS | news reader refinement and mode prompts");
