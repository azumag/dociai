import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION, issue } from "../../src/config/config-contract.js";
import { CONFIG_REGISTRY, registryIds } from "../../src/config/config-registry.js";
import { CURRENT_CONFIG_SCHEMA } from "../../src/config/config-schema.js";
import { CONFIG_UI_METADATA } from "../../src/config/config-ui-metadata.js";
import { validateConfigStructure } from "../../src/config/config-validation.js";
import { commentReaderDefaults } from "../../src/config/config-defaults.js";

test("current example validates with the shared pure schema", async () => {
  const config = JSON.parse(await fs.readFile(new URL("../../config.local.example.json", import.meta.url), "utf8"));
  const result = validateConfigStructure(config);
  assert.equal(result.ok, true);
  assert.equal(config.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(CURRENT_CONFIG_SCHEMA.version, CURRENT_SCHEMA_VERSION);
});

test("structured issues carry path, code, severity, source, and immutable metadata", () => {
  const value = issue(["connectors", "main", "provider"], "enum", "bad", { meta: { options: ["mock"] } });
  assert.deepEqual(value.path, ["connectors", "main", "provider"]);
  assert.equal(value.severity, "error"); assert.equal(value.source, "schema");
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.meta));
});

test("registry, schema enums, UI options, and security unknown policy stay aligned", () => {
  const invalid = validateConfigStructure({ schemaVersion: 1, connectors: { x: { provider: "bad" } }, personas: [], triggers: {}, apiSecretBackup: "x", harmless: true });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((entry) => entry.code === "enum" && entry.path.join(".") === "connectors.x.provider"));
  assert.ok(invalid.issues.some((entry) => entry.code === "unknown.security-sensitive" && entry.severity === "error"));
  assert.ok(invalid.issues.some((entry) => entry.code === "unknown" && entry.severity === "warning"));
  assert.deepEqual(CONFIG_UI_METADATA["connectors.*.provider"].options.map((entry) => entry.value), registryIds("providers"));
  assert.ok(CONFIG_REGISTRY.topicSourceTypes[0].secretFields.includes("token"));
});

test("legacy commentReader voice fields migrate only into their selected engine settings", () => {
  const migrated = commentReaderDefaults({ enabled: true, engine: "voicevox", name: "Kyoko", rate: 1.2, pitch: 0.1, speaker: 7, speed: 125, voice: 3, tone: 90, volume: 0.8 });
  assert.deepEqual(migrated.webspeech, { name: "default", rate: 1, pitch: 1 });
  assert.deepEqual(migrated.voicevox, { speaker: 7, speed: 1.2, pitch: 0.1, intonation: 1, volume: 0.8 });
  assert.deepEqual(migrated.bouyomi, {});
  assert.equal("rate" in migrated, false);
  assert.equal("pitch" in migrated, false);

  const nested = commentReaderDefaults({ rate: 1.2, webspeech: { rate: 0.8 }, voicevox: { pitch: -0.05 }, bouyomi: { speed: 150 } });
  assert.equal(nested.webspeech.rate, 0.8);
  assert.equal(nested.voicevox.pitch, -0.05);
  assert.equal(nested.bouyomi.speed, 150);

  const defaults = commentReaderDefaults({ enabled: true, engine: "bouyomi" });
  assert.deepEqual(defaults.bouyomi, {}, "未指定の棒読みちゃん値は共通bouyomi設定へフォールバックさせる");
  assert.equal("speaker" in defaults.voicevox, false, "未指定speakerはvoicevox.defaultSpeakerへフォールバックさせる");
});
