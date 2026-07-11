import assert from "node:assert/strict";
import test from "node:test";
import { canonicalConfigHash, canonicalizeConfig } from "../../src/config/config-canonicalize.js";
import { processConfig } from "../../src/config/config-pipeline.js";

const legacy = { connectors: { mock: { provider: "mock", apiKey: "secret" } }, personas: [{ id: " p ", name: "P", connector: "mock", triggers: ["b", "a", "a"] }], triggers: {}, news: { enabled: true, sources: [{ type: "todoist", token: "todo-secret", projectId: "1" }] }, commentSources: { twitch: { channel: "#MyChannel" } } };

test("v0 migrates stepwise to current without mutating input", () => {
  const before = structuredClone(legacy);
  const result = processConfig(legacy);
  assert.equal(result.ok, true); assert.deepEqual(result.migrations, ["v0-to-v1", "v1-to-v2"]);
  assert.equal(result.config.schemaVersion, 2); assert.deepEqual(result.config.personas[0].triggers, ["a", "b"]);
  assert.deepEqual(result.config.commentSources.twitch.channels, ["mychannel"]);
  assert.equal(result.config.topics.sources[0].type, "todoist"); assert.deepEqual(legacy, before);
  assert.ok(result.secretCandidates.some((entry) => entry.path.join(".") === "connectors.mock.apiKey"));
  assert.equal(result.canonical.includes("secret"), false);
});

test("future versions are rejected without downgrade", () => {
  const input = { schemaVersion: 99 };
  const result = processConfig(input);
  assert.equal(result.ok, false); assert.equal(result.stage, "version-detection");
  assert.equal(result.issues[0].code, "version.future"); assert.deepEqual(input, { schemaVersion: 99 });
});

test("canonical form and hash ignore key order and secret values", () => {
  const a = { schemaVersion: 2, b: 2, a: 1, apiKey: "one" };
  const b = { apiKey: "two", a: 1, b: 2, schemaVersion: 2 };
  assert.equal(canonicalizeConfig(a), canonicalizeConfig(b)); assert.equal(canonicalConfigHash(a), canonicalConfigHash(b));
  assert.equal(processConfig(processConfig(legacy).config).hash, processConfig(legacy).hash);
});
