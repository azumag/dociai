import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION, issue } from "../../src/config/config-contract.js";
import { CONFIG_REGISTRY, registryIds } from "../../src/config/config-registry.js";
import { CURRENT_CONFIG_SCHEMA } from "../../src/config/config-schema.js";
import { CONFIG_UI_METADATA } from "../../src/config/config-ui-metadata.js";
import { validateConfigStructure } from "../../src/config/config-validation.js";

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
