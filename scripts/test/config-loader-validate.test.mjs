import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../../src/config-loader.js";

test("validateConfig warns about a missing apiKey unless apiKeyConfigured is set", () => {
  const withoutKey = { connectors: { main: { provider: "openai", model: "gpt-4" } }, personas: [], triggers: {} };
  const { warnings: withoutKeyWarnings } = validateConfig(withoutKey);
  assert.ok(withoutKeyWarnings.some((w) => w.includes("connectors.main にapiKeyがありません")));

  const configured = { connectors: { main: { provider: "openai", model: "gpt-4", apiKeyConfigured: true, apiKeySecretRef: "connectors.main.apiKey" } }, personas: [], triggers: {} };
  const { warnings: configuredWarnings } = validateConfig(configured);
  assert.ok(!configuredWarnings.some((w) => w.includes("apiKeyがありません")));
});

test("validateConfig errors on a missing Todoist topics.sources token unless tokenConfigured is set", () => {
  const withoutToken = { connectors: {}, personas: [], triggers: {}, topics: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x" }] } };
  const { errors: withoutTokenErrors } = validateConfig(withoutToken);
  assert.ok(withoutTokenErrors.some((e) => e.includes("token がありません")));

  const configured = { connectors: {}, personas: [], triggers: {}, topics: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true, tokenSecretRef: "topics.sources.0.token" }] } };
  const { errors: configuredErrors } = validateConfig(configured);
  assert.ok(!configuredErrors.some((e) => e.includes("token がありません")));
});

test("validateConfig errors on a missing legacy news.sources Todoist token unless tokenConfigured is set", () => {
  const withoutToken = { connectors: {}, personas: [], triggers: {}, news: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x" }] } };
  const { errors: withoutTokenErrors } = validateConfig(withoutToken);
  assert.ok(withoutTokenErrors.some((e) => e.includes("token がありません")));

  const configured = { connectors: {}, personas: [], triggers: {}, news: { enabled: true, sources: [{ type: "todoist", projectId: "1", name: "x", tokenConfigured: true, tokenSecretRef: "news.sources.0.token" }] } };
  const { errors: configuredErrors } = validateConfig(configured);
  assert.ok(!configuredErrors.some((e) => e.includes("token がありません")));
});
