import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION, issue } from "../../src/config/config-contract.js";
import { CONFIG_REGISTRY, registryIds } from "../../src/config/config-registry.js";
import { CURRENT_CONFIG_SCHEMA } from "../../src/config/config-schema.js";
import { CONFIG_UI_METADATA } from "../../src/config/config-ui-metadata.js";
import { validateConfigStructure } from "../../src/config/config-validation.js";
import { applyConfigDefaults, commentReaderDefaults } from "../../src/config/config-defaults.js";
import { normalizeConfig } from "../../src/config/config-normalize.js";

test("current example validates with the shared pure schema", async () => {
  const config = JSON.parse(await fs.readFile(new URL("../../config.local.example.json", import.meta.url), "utf8"));
  const result = validateConfigStructure(config);
  assert.equal(result.ok, true);
  assert.equal(config.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(CURRENT_CONFIG_SCHEMA.version, CURRENT_SCHEMA_VERSION);
});

test("news random persona defaults preserve legacy behavior and candidate IDs normalize deterministically", () => {
  const defaulted = applyConfigDefaults({ personas: [], news: { persona: "fixed" } });
  assert.equal(defaulted.news.randomPersona, false);
  assert.deepEqual(defaulted.news.personas, []);
  assert.equal(defaulted.news.persona, "fixed");
  const normalized = normalizeConfig({ personas: [], news: { personas: [" b ", "a", "b", ""] } });
  assert.deepEqual(normalized.news.personas, ["a", "b"]);
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

test("Web research requires an existing connector and bounded result count when enabled", () => {
  const base = { schemaVersion: CURRENT_SCHEMA_VERSION, connectors: { minimax: { provider: "minimax", model: "MiniMax-M3" } }, personas: [], triggers: {} };
  assert.equal(validateConfigStructure({ ...base, research: { enabled: true, connector: "minimax", maxResults: 5 } }).ok, true);
  const invalid = validateConfigStructure({ ...base, research: { enabled: true, connector: "missing", maxResults: 11 } });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((entry) => entry.path.join(".") === "research.connector"));
  assert.ok(invalid.issues.some((entry) => entry.path.join(".") === "research.maxResults"));
  const unsupported = validateConfigStructure({ ...base, connectors: { openai: { provider: "openai", model: "gpt" } }, research: { enabled: true, connector: "openai", maxResults: 5 } });
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.issues.some((entry) => entry.code === "capability" && entry.path.join(".") === "research.connector"));
  const compatible = validateConfigStructure({ ...base, connectors: { minimax: { provider: "openai-compatible", model: "MiniMax-M3", baseUrl: "https://api.minimax.io/v1" } }, research: { enabled: true, connector: "minimax", maxResults: 5 } });
  assert.equal(compatible.ok, true);
  const mockOnOfficialHost = validateConfigStructure({ ...base, connectors: { minimax: { provider: "mock", model: "mock-1", baseUrl: "https://api.minimax.io/v1" } }, research: { enabled: true, connector: "minimax", maxResults: 5 } });
  assert.equal(mockOnOfficialHost.ok, false);
  assert.ok(mockOnOfficialHost.issues.some((entry) => entry.code === "capability" && entry.path.join(".") === "research.connector"));
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
  assert.equal(defaults.collapseConsecutiveEmoji, false);
  assert.equal(commentReaderDefaults({ collapseConsecutiveEmoji: true }).collapseConsecutiveEmoji, true);
  assert.equal(defaults.intervalSeconds, 0, "既定は間隔なし");
  assert.equal(commentReaderDefaults({ intervalSeconds: 5 }).intervalSeconds, 5);
});
