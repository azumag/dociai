import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../../src/config-loader.js";
import { processConfig } from "../../src/config/config-pipeline.js";

test("validateConfig warns about a missing apiKey unless apiKeyConfigured is set", () => {
  const withoutKey = { connectors: { main: { provider: "openai", model: "gpt-4" } }, personas: [], triggers: {} };
  const { warnings: withoutKeyWarnings } = validateConfig(withoutKey);
  assert.ok(withoutKeyWarnings.some((w) => w.includes("connectors.main にapiKeyがありません")));

  const configured = { connectors: { main: { provider: "openai", model: "gpt-4", apiKeyConfigured: true, apiKeySecretRef: "connectors.main.apiKey" } }, personas: [], triggers: {} };
  const { warnings: configuredWarnings } = validateConfig(configured);
  assert.ok(!configuredWarnings.some((w) => w.includes("apiKeyがありません")));
});

test("validateConfig accepts only integer connector maxTokens within the runtime bounds", () => {
  const config = (maxTokens) => ({ connectors: { local: { provider: "ollama", model: "gemma4:12b", maxTokens } }, personas: [], triggers: {} });
  for (const value of [1, 32768]) assert.ok(!validateConfig(config(value)).errors.some((error) => error.includes("maxTokens")), String(value));
  for (const value of [0, 32769, 1.5, "not-a-number"]) assert.ok(validateConfig(config(value)).errors.some((error) => error.includes("maxTokens")), String(value));
});

test("validateConfig errors on a missing Todoist topics.sources token unless tokenConfigured is set", () => {
  const withoutToken = { connectors: {}, personas: [], triggers: {}, topics: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x" }] } };
  const { errors: withoutTokenErrors } = validateConfig(withoutToken);
  assert.ok(withoutTokenErrors.some((e) => e.includes("token がありません")));

  const configured = { connectors: {}, personas: [], triggers: {}, topics: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true, tokenSecretRef: "topics.sources.0.token" }] } };
  const { errors: configuredErrors } = validateConfig(configured);
  assert.ok(!configuredErrors.some((e) => e.includes("token がありません")));
});

test("validateConfig warns on unavailable topics.personas ids and when randomPersona has no candidates", () => {
  const base = { connectors: { mock: { provider: "mock" } }, personas: [{ id: "p", name: "P", connector: "mock" }], triggers: {} };

  const unknownId = { ...base, topics: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true }], personas: ["missing"] } };
  const { errors, warnings: unknownWarnings } = validateConfig(unknownId);
  assert.ok(!errors.some((e) => e.includes("topics.personas")));
  assert.ok(unknownWarnings.some((warning) => warning.includes(`topics.personas の "missing"`)));

  const emptyPool = { ...base, topics: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true }], randomPersona: true, personas: [] } };
  const { warnings } = validateConfig(emptyPool);
  assert.ok(warnings.some((w) => w.includes("topics.randomPersona が true ですが topics.personas が空です")));

  const valid = { ...base, topics: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true }], randomPersona: true, personas: ["p"] } };
  const { errors: validErrors, warnings: validWarnings } = validateConfig(valid);
  assert.deepEqual(validErrors, []);
  assert.ok(!validWarnings.some((w) => w.includes("topics.randomPersona")));
});

test("validateConfig accepts news random persona candidates, warns on unavailable IDs, and keeps an empty pool runnable through fallback", () => {
  const base = {
    connectors: { mock: { provider: "mock" } },
    personas: [{ id: "fixed", name: "Fixed", connector: "mock" }, { id: "disabled", name: "Disabled", connector: "mock", enabled: false }],
    triggers: {},
    news: { enabled: true, sources: [{ type: "mock", name: "mock" }], persona: "fixed", randomPersona: true, personas: ["disabled", "missing"] },
  };
  const unavailable = validateConfig(base);
  assert.deepEqual(unavailable.errors, []);
  assert.ok(unavailable.warnings.some((warning) => warning.includes('"disabled" は無効化')));
  assert.ok(unavailable.warnings.some((warning) => warning.includes('"missing" が personas に存在しない')));

  const empty = validateConfig({ ...base, news: { ...base.news, personas: [] } });
  assert.deepEqual(empty.errors, []);
  assert.ok(empty.warnings.some((warning) => warning.includes("news.randomPersona が true")));

  const malformed = validateConfig({ ...base, news: { ...base.news, personas: "fixed" } });
  assert.ok(malformed.errors.some((error) => error.includes("news.personas はペルソナIDの配列")));
  const malformedToggle = validateConfig({ ...base, news: { ...base.news, randomPersona: "yes" } });
  assert.ok(malformedToggle.errors.some((error) => error.includes("news.randomPersona は真偽値")));
});

test("validateConfig errors on a missing legacy news.sources Todoist token unless tokenConfigured is set", () => {
  const withoutToken = { connectors: {}, personas: [], triggers: {}, news: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x" }] } };
  const { errors: withoutTokenErrors } = validateConfig(withoutToken);
  assert.ok(withoutTokenErrors.some((e) => e.includes("token がありません")));

  const configured = { connectors: {}, personas: [], triggers: {}, news: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true, tokenSecretRef: "news.sources.0.token" }] } };
  const { errors: configuredErrors } = validateConfig(configured);
  assert.ok(!configuredErrors.some((e) => e.includes("token がありません")));
});

test("validateConfig (issue #188) accepts google-news sources and validates articleFetch/allowedHosts/license", () => {
  const valid = {
    connectors: { main: { provider: "mock" } }, personas: [{ id: "p", name: "P", connector: "main" }], triggers: {},
    news: {
      enabled: true,
      sources: [{
        type: "google-news", name: "gn", url: "https://news.google.com/rss/search?q=x",
        articleFetch: "auto", allowedHosts: ["news.google.com", "example.com"],
        license: { name: "CC BY", url: "https://example.com/license", attributionRequired: true },
      }],
    },
  };
  assert.deepEqual(validateConfig(valid).errors, []);

  const missingUrl = { connectors: {}, personas: [], triggers: {}, news: { enabled: true, sources: [{ type: "google-news", name: "gn" }] } };
  assert.ok(validateConfig(missingUrl).errors.some((e) => e.includes(".url がありません")));

  const badArticleFetch = { connectors: {}, personas: [], triggers: {}, news: { enabled: true, sources: [{ type: "rss", name: "r", url: "https://example.com/rss", articleFetch: "always" }] } };
  assert.ok(validateConfig(badArticleFetch).errors.some((e) => e.includes('articleFetch "always"')));

  const badAllowedHosts = { connectors: {}, personas: [], triggers: {}, news: { enabled: true, sources: [{ type: "rss", name: "r", url: "https://example.com/rss", allowedHosts: "example.com" }] } };
  assert.ok(validateConfig(badAllowedHosts).errors.some((e) => e.includes("allowedHosts は文字列の配列")));

  const badLicense = { connectors: {}, personas: [], triggers: {}, news: { enabled: true, sources: [{ type: "rss", name: "r", url: "https://example.com/rss", license: { attributionRequired: true } }] } };
  assert.ok(validateConfig(badLicense).errors.some((e) => e.includes("license.name がありません")));
});

test("validateConfig (issue #193) validates the optional news.schedule slots, and accepts configs that omit it entirely", () => {
  const base = { connectors: { main: { provider: "mock" } }, personas: [{ id: "p", name: "P", connector: "main" }], triggers: {}, news: { enabled: true, sources: [{ type: "mock", name: "m" }] } };

  assert.deepEqual(validateConfig(base).errors, [], "news.schedule is fully optional");

  const valid = { ...base, news: { ...base.news, schedule: { enabled: true, slots: [{ id: "morning", minute: 540, mode: "topic", daysOfWeek: [1, 2, 3, 4, 5] }], cooldownMinutes: 30, maxRunsPerHour: 4 } } };
  assert.deepEqual(validateConfig(valid).errors, []);

  const notObject = { ...base, news: { ...base.news, schedule: "daily" } };
  assert.ok(validateConfig(notObject).errors.some((e) => e.includes("news.schedule はオブジェクト")));

  const missingId = { ...base, news: { ...base.news, schedule: { slots: [{ minute: 540 }] } } };
  assert.ok(validateConfig(missingId).errors.some((e) => e.includes(".id がありません")));

  const badMinute = { ...base, news: { ...base.news, schedule: { slots: [{ id: "x", minute: 1500 }] } } };
  assert.ok(validateConfig(badMinute).errors.some((e) => e.includes(".minute は0以上1440未満")));

  const badMode = { ...base, news: { ...base.news, schedule: { slots: [{ id: "x", minute: 0, mode: "bogus" }] } } };
  assert.ok(validateConfig(badMode).errors.some((e) => e.includes('.mode "bogus"')));

  const badDaysOfWeek = { ...base, news: { ...base.news, schedule: { slots: [{ id: "x", minute: 0, daysOfWeek: [7] }] } } };
  assert.ok(validateConfig(badDaysOfWeek).errors.some((e) => e.includes("daysOfWeek は0(日)〜6(土)")));

  const badCooldown = { ...base, news: { ...base.news, schedule: { slots: [], cooldownMinutes: -1 } } };
  assert.ok(validateConfig(badCooldown).errors.some((e) => e.includes("cooldownMinutes は0以上")));

  const badMaxRuns = { ...base, news: { ...base.news, schedule: { slots: [], maxRunsPerHour: -1 } } };
  assert.ok(validateConfig(badMaxRuns).errors.some((e) => e.includes("maxRunsPerHour は0以上")));
});

test("validateConfig accepts comment reader engine-specific voice boundaries", () => {
  const config = {
    connectors: { mock: { provider: "mock" } },
    personas: [{ id: "p", name: "P", connector: "mock" }],
    triggers: {},
    commentReader: {
      enabled: false,
      webspeech: { name: "Kyoko", rate: 0.5, pitch: 2 },
      voicevox: { speaker: 0, speed: 2, pitch: -0.15, intonation: 0, volume: 0 },
      bouyomi: { voice: 0, speed: -1, tone: 200, volume: 100 },
    },
  };
  assert.deepEqual(validateConfig(config).errors, []);
});

test("validateConfig accepts commentReader.intervalSeconds within 0-3600 and rejects out-of-range values", () => {
  const base = {
    connectors: { mock: { provider: "mock" } },
    personas: [{ id: "p", name: "P", connector: "mock" }],
    triggers: {},
  };
  for (const intervalSeconds of [0, 5, 3600]) {
    const config = { ...base, commentReader: { enabled: false, intervalSeconds } };
    assert.deepEqual(validateConfig(config).errors, [], String(intervalSeconds));
  }
  for (const intervalSeconds of [-1, 3601, "not-a-number"]) {
    const config = { ...base, commentReader: { enabled: false, intervalSeconds } };
    assert.ok(validateConfig(config).errors.some((error) => error.includes("commentReader.intervalSeconds")), String(intervalSeconds));
  }
});

test("validateConfig rejects malformed or out-of-range comment reader voice settings even while disabled", () => {
  const base = {
    connectors: { mock: { provider: "mock" } },
    personas: [{ id: "p", name: "P", connector: "mock" }],
    triggers: {},
  };
  const invalid = [
    { webspeech: "Kyoko" },
    { webspeech: null },
    { webspeech: [] },
    { voicevox: [] },
    { bouyomi: [] },
    { collapseConsecutiveEmoji: "yes" },
    { webspeech: { name: 3, rate: 0.49, pitch: 2.01 } },
    { voicevox: { speaker: 1.5, speed: 2.01, pitch: 0.16, intonation: -0.01, volume: 2.01 } },
    { bouyomi: { voice: -1, speed: 49, tone: 100.5, volume: 101 } },
  ];
  for (const commentReader of invalid) {
    const raw = { ...base, commentReader: { enabled: false, ...commentReader } };
    assert.ok(validateConfig(raw).errors.length > 0, `direct: ${JSON.stringify(commentReader)}`);
    const processed = processConfig(raw);
    assert.equal(processed.ok, true);
    assert.ok(validateConfig(processed.config).errors.length > 0, `pipeline: ${JSON.stringify(commentReader)}`);
  }
});

test("legacy flat comment reader settings remain valid through the real config pipeline for every engine", () => {
  const base = { connectors: { mock: { provider: "mock" } }, personas: [{ id: "p", name: "P", connector: "mock" }], triggers: {} };
  const cases = [
    { enabled: true, engine: "webspeech", name: "Kyoko", rate: 0.8, pitch: 1.4 },
    { enabled: true, engine: "voicevox", speaker: 7, rate: 1.2, pitch: -0.05, intonation: 0, volume: 0 },
    { enabled: true, engine: "bouyomi", voice: 4, speed: 140, tone: 90, volume: 80 },
    { enabled: false, engine: "webspeech", rate: 1, pitch: 1 },
  ];
  for (const commentReader of cases) {
    const processed = processConfig({ ...base, commentReader });
    assert.equal(processed.ok, true);
    assert.deepEqual(validateConfig(processed.config).errors, [], JSON.stringify(commentReader));
  }
});
