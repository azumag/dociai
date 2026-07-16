import assert from "node:assert/strict";
import test from "node:test";
import { splitConnectorSecrets, collectConfiguredSecretRefs } from "../../src/config/config-secrets-split.js";

test("splitConnectorSecrets moves connectors.*.apiKey and topics.sources[].token out, without mutating input", () => {
  const input = {
    connectors: { mock: { provider: "mock", apiKey: "sk-secret" }, empty: { provider: "ollama" } },
    topics: { sources: [{ type: "todoist", token: "todo-secret", projectId: "1" }, { type: "todoist", projectId: "2" }] },
  };
  const before = structuredClone(input);
  const result = splitConnectorSecrets(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.invalidIds, []);
  assert.deepEqual(result.secretEntries, [
    { key: "connectors.mock.apiKey", value: "sk-secret" },
    { key: "topics.sources.0.token", value: "todo-secret" },
  ]);
  assert.equal(result.publicConfig.connectors.mock.apiKey, undefined);
  assert.equal(result.publicConfig.connectors.mock.apiKeyConfigured, true);
  assert.equal(result.publicConfig.connectors.mock.apiKeySecretRef, "connectors.mock.apiKey");
  assert.equal(result.publicConfig.connectors.empty.apiKeyConfigured, undefined);
  assert.equal(result.publicConfig.topics.sources[0].token, undefined);
  assert.equal(result.publicConfig.topics.sources[0].tokenConfigured, true);
  assert.equal(result.publicConfig.topics.sources[0].tokenSecretRef, "topics.sources.0.token");
  assert.equal(result.publicConfig.topics.sources[1].tokenConfigured, undefined);
});

test("splitConnectorSecrets leaves an already-masked connector untouched", () => {
  const input = { connectors: { mock: { provider: "mock", apiKeyConfigured: true, apiKeySecretRef: "connectors.mock.apiKey" } } };
  const result = splitConnectorSecrets(input);
  assert.deepEqual(result.secretEntries, []);
  assert.deepEqual(result.publicConfig.connectors.mock, input.connectors.mock);
});

test("splitConnectorSecrets flags connector ids outside the secret-key charset without dropping the value", () => {
  const input = { connectors: { "my connector/id": { provider: "mock", apiKey: "sk-secret" } } };
  const result = splitConnectorSecrets(input);
  assert.deepEqual(result.invalidIds, [{ path: "connectors.my connector/id", reason: "invalid-secret-key-id" }]);
  assert.equal(result.secretEntries.length, 1);
  assert.equal(result.secretEntries[0].key, "connectors.my connector/id.apiKey");
});

test("splitConnectorSecrets does not add a topics key to configs that never had one", () => {
  const input = { connectors: {} };
  const result = splitConnectorSecrets(input);
  assert.equal("topics" in result.publicConfig, false);
});

test("splitConnectorSecrets also strips legacy news.sources[].token (pre-v1-to-v2-migration Todoist entries)", () => {
  const input = { connectors: {}, news: { enabled: true, sources: [{ type: "todoist", token: "news-secret", projectId: "1" }] } };
  const result = splitConnectorSecrets(input);
  assert.deepEqual(result.secretEntries, [{ key: "news.sources.0.token", value: "news-secret" }]);
  assert.equal(result.publicConfig.news.sources[0].token, undefined);
  assert.equal(result.publicConfig.news.sources[0].tokenConfigured, true);
  assert.equal(result.publicConfig.news.sources[0].tokenSecretRef, "news.sources.0.token");
});

test("splitConnectorSecrets flags a key that exceeds Main's parseSecretKey 128-char cap even when the bare id looks safe", () => {
  const longId = "a".repeat(120);
  const input = { connectors: { [longId]: { provider: "mock", apiKey: "sk-secret" } } };
  const result = splitConnectorSecrets(input);
  assert.deepEqual(result.invalidIds, [{ path: `connectors.${longId}`, reason: "invalid-secret-key-id" }]);
});

test("splitConnectorSecrets trims accidental whitespace/newlines pasted around apiKey/token values", () => {
  const input = {
    connectors: { mock: { provider: "mock", apiKey: "  sk-secret\n" } },
    topics: { sources: [{ type: "todoist", token: "\ttodo-secret \n", projectId: "1" }] },
  };
  const result = splitConnectorSecrets(input);
  assert.deepEqual(result.secretEntries, [
    { key: "connectors.mock.apiKey", value: "sk-secret" },
    { key: "topics.sources.0.token", value: "todo-secret" },
  ]);
});

test("splitConnectorSecrets treats a whitespace-only token as unset rather than a configured secret", () => {
  const input = { connectors: {}, topics: { sources: [{ type: "todoist", token: "   ", projectId: "1" }] } };
  const result = splitConnectorSecrets(input);
  assert.deepEqual(result.secretEntries, []);
  assert.equal(result.publicConfig.topics.sources[0].tokenConfigured, undefined);
});

test("collectConfiguredSecretRefs finds every secret ref marked configured and clear() flips only that flag in place", () => {
  const config = {
    connectors: { mock: { provider: "mock", apiKeyConfigured: true, apiKeySecretRef: "connectors.mock.apiKey" }, bare: { provider: "ollama" } },
    topics: { sources: [{ name: "配信ネタ", tokenConfigured: true, tokenSecretRef: "topics.sources.0.token" }, { name: "no-token" }] },
    news: { sources: [{ name: "news src", tokenConfigured: true, tokenSecretRef: "news.sources.0.token" }] },
  };
  const refs = collectConfiguredSecretRefs(config);
  assert.deepEqual(refs.map((r) => r.key).sort(), ["connectors.mock.apiKey", "news.sources.0.token", "topics.sources.0.token"].sort());
  const topicRef = refs.find((r) => r.key === "topics.sources.0.token");
  topicRef.clear();
  assert.equal(config.topics.sources[0].tokenConfigured, false);
  assert.equal(config.connectors.mock.apiKeyConfigured, true, "clearing one ref does not touch unrelated refs");
});

test("collectConfiguredSecretRefs ignores entries without both the configured flag and the secret ref", () => {
  const config = { connectors: { half: { provider: "mock", apiKeyConfigured: true } }, topics: { sources: [{ tokenSecretRef: "topics.sources.0.token" }] } };
  assert.deepEqual(collectConfiguredSecretRefs(config), []);
});
