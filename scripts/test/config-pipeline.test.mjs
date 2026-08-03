import assert from "node:assert/strict";
import test from "node:test";
import { canonicalConfigHash, canonicalizeConfig } from "../../src/config/config-canonicalize.js";
import { processConfig } from "../../src/config/config-pipeline.js";
import { processConfigText } from "../../src/config/config-adapters.js";
import { serializeConfigExport } from "../../src/config/config-export.js";
import { importConfig } from "../../src/config/config-import.js";

const legacy = { connectors: { mock: { provider: "mock", apiKey: "secret" } }, personas: [{ id: " p ", name: "P", connector: "mock", triggers: ["b", "a", "a"] }], triggers: {}, news: { enabled: true, sources: [{ type: "todoist", token: "todo-secret", projectId: "1" }] }, commentSources: { twitch: { channel: "#MyChannel" } } };

test("v0 migrates stepwise to current without mutating input", () => {
  const before = structuredClone(legacy);
  const result = processConfig(legacy);
  assert.equal(result.ok, true); assert.deepEqual(result.migrations, ["v0-to-v1", "v1-to-v2", "v2-to-v3"]);
  assert.equal(result.config.schemaVersion, 3); assert.deepEqual(result.config.personas[0].triggers, ["a", "b"]);
  assert.deepEqual(result.config.commentSources.twitch.channels, ["mychannel"]);
  assert.equal(result.config.topics.sources[0].type, "todoist"); assert.deepEqual(legacy, before);
  assert.ok(result.secretCandidates.some((entry) => entry.path.join(".") === "connectors.mock.apiKey"));
  assert.equal(result.canonical.includes("secret"), false);
});

// issue #257 (PR #269 review指摘): commentReader.translation.timeoutMsの旧既定値3000msが、
// 翻訳を有効化したことがあるユーザーの設定へ明示的に永続化されてしまっていた問題への migration。
test("v2-to-v3 bumps a persisted timeoutMs that exactly matches the OLD default (3000) to the new default, but leaves a genuinely customized value alone", () => {
  const withOldDefault = { schemaVersion: 2, commentReader: { translation: { enabled: true, timeoutMs: 3000 } } };
  const migrated = processConfig(withOldDefault);
  assert.equal(migrated.ok, true);
  assert.deepEqual(migrated.migrations, ["v2-to-v3"]);
  assert.equal(migrated.config.commentReader.translation.timeoutMs, 25000);

  const withCustomValue = { schemaVersion: 2, commentReader: { translation: { enabled: true, timeoutMs: 8000 } } };
  const untouched = processConfig(withCustomValue);
  assert.equal(untouched.ok, true);
  assert.equal(untouched.config.commentReader.translation.timeoutMs, 8000, "a value the user actually chose must survive the migration unchanged");

  const withoutTranslation = { schemaVersion: 2, commentReader: { enabled: true } };
  const noop = processConfig(withoutTranslation);
  assert.equal(noop.ok, true);
  assert.equal(noop.config.schemaVersion, 3, "schemaVersion still advances even when there's nothing to bump");
});

test("future versions are rejected without downgrade", () => {
  const input = { schemaVersion: 99 };
  const result = processConfig(input);
  assert.equal(result.ok, false); assert.equal(result.stage, "version-detection");
  assert.equal(result.issues[0].code, "version.future"); assert.deepEqual(input, { schemaVersion: 99 });
});

test("invalid persona candidate settings fail structurally without throwing", () => {
  for (const personas of ["fixed", {}, 3]) {
    const input = { ...legacy, news: { ...legacy.news, personas } };
    const direct = processConfig(input);
    assert.equal(direct.ok, false);
    assert.equal(direct.stage, "structural-validation");
    assert.deepEqual(direct.issues[0].path, ["news", "personas"]);
    assert.equal(direct.issues[0].code, "type.array");

    const fromText = processConfigText(JSON.stringify(input), "browser-file");
    assert.equal(fromText.ok, false);
    assert.equal(fromText.stage, "structural-validation");
    assert.deepEqual(fromText.issues[0].path, ["news", "personas"]);
  }

  const invalidToggle = processConfig({ ...legacy, news: { ...legacy.news, randomPersona: "yes" } });
  assert.equal(invalidToggle.ok, false);
  assert.equal(invalidToggle.issues[0].code, "type.boolean");
});

test("canonical form and hash ignore key order and secret values", () => {
  const a = { schemaVersion: 2, b: 2, a: 1, apiKey: "one" };
  const b = { apiKey: "two", a: 1, b: 2, schemaVersion: 2 };
  assert.equal(canonicalizeConfig(a), canonicalizeConfig(b)); assert.equal(canonicalConfigHash(a), canonicalConfigHash(b));
  assert.equal(processConfig(processConfig(legacy).config).hash, processConfig(legacy).hash);
});

test("plain and export package imports share the pipeline and never export secrets", () => {
  const withAuthorization = { ...legacy, connectors: { ...legacy.connectors, mock: { ...legacy.connectors.mock, authorization: "Bearer secret" } } };
  const plain = processConfigText(JSON.stringify(withAuthorization), "browser-file");
  const exported = serializeConfigExport(plain.config);
  assert.equal(exported.includes("secret"), false);
  const imported = importConfig(exported);
  assert.equal(imported.importFormat, "package");
  assert.equal(imported.hash, plain.hash);
});

test("tampered export package revision is rejected", () => {
  const exported = JSON.parse(serializeConfigExport(processConfig(legacy).config));
  exported.config.router.cooldownSeconds = 99;
  const imported = importConfig(exported);
  assert.equal(imported.ok, false);
  assert.equal(imported.stage, "import-package");
  assert.equal(imported.issues[0].code, "package.revision");
});
