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

test("validateConfig errors on unknown topics.personas ids and warns when randomPersona has no candidates", () => {
  const base = { connectors: { mock: { provider: "mock" } }, personas: [{ id: "p", name: "P", connector: "mock" }], triggers: {} };

  const unknownId = { ...base, topics: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true }], personas: ["missing"] } };
  const { errors } = validateConfig(unknownId);
  assert.ok(errors.some((e) => e.includes(`topics.personas の "missing" が personas に存在しません`)));

  const emptyPool = { ...base, topics: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true }], randomPersona: true, personas: [] } };
  const { warnings } = validateConfig(emptyPool);
  assert.ok(warnings.some((w) => w.includes("topics.randomPersona が true ですが topics.personas が空です")));

  const valid = { ...base, topics: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true }], randomPersona: true, personas: ["p"] } };
  const { errors: validErrors, warnings: validWarnings } = validateConfig(valid);
  assert.deepEqual(validErrors, []);
  assert.ok(!validWarnings.some((w) => w.includes("topics.randomPersona")));
});

test("validateConfig errors on a missing legacy news.sources Todoist token unless tokenConfigured is set", () => {
  const withoutToken = { connectors: {}, personas: [], triggers: {}, news: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x" }] } };
  const { errors: withoutTokenErrors } = validateConfig(withoutToken);
  assert.ok(withoutTokenErrors.some((e) => e.includes("token がありません")));

  const configured = { connectors: {}, personas: [], triggers: {}, news: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true, tokenSecretRef: "news.sources.0.token" }] } };
  const { errors: configuredErrors } = validateConfig(configured);
  assert.ok(!configuredErrors.some((e) => e.includes("token がありません")));
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
