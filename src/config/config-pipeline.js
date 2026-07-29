import { CURRENT_SCHEMA_VERSION, failureResult, issue } from "./config-contract.js";
import { applyConfigDefaults } from "./config-defaults.js";
import { canonicalConfigHash, canonicalizeConfig, isSecretConfigKey } from "./config-canonicalize.js";
import { normalizeConfig } from "./config-normalize.js";
import { migrationFrom } from "./migrations/index.js";

const collectSecrets = (value, path = [], output = []) => { if (!value || typeof value !== "object") return output; for (const [key, entry] of Object.entries(value)) { const next = [...path, key]; if (isSecretConfigKey(key) && entry) output.push(Object.freeze({ path: Object.freeze(next), kind: key })); else collectSecrets(entry, next, output); } return output; };
const validatePersonaSelectionFields = (config) => {
  const issues = [];
  for (const sectionName of ["news", "topics"]) {
    const section = config?.[sectionName];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    if (section.randomPersona !== undefined && typeof section.randomPersona !== "boolean") {
      issues.push(issue([sectionName, "randomPersona"], "type.boolean", `${sectionName}.randomPersona must be a boolean`));
    }
    if (section.personas !== undefined && !Array.isArray(section.personas)) {
      issues.push(issue([sectionName, "personas"], "type.array", `${sectionName}.personas must be an array`));
    }
  }
  return issues;
};
export function detectConfigVersion(config) { return config?.schemaVersion == null ? 0 : Number(config.schemaVersion); }
export function processConfig(input) {
  const original = structuredClone(input);
  let config = structuredClone(input);
  let version = detectConfigVersion(config);
  if (!Number.isInteger(version) || version < 0) return failureResult("version-detection", [issue(["schemaVersion"], "version.invalid", "Invalid schemaVersion", { source: "migration" })], original);
  if (version > CURRENT_SCHEMA_VERSION) return failureResult("version-detection", [issue(["schemaVersion"], "version.future", `Future schemaVersion ${version} is not supported`, { source: "migration" })], original);
  const migrations = [], notes = [];
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = migrationFrom(version);
    if (!migration) return failureResult("migration", [issue(["schemaVersion"], "migration.missing", `Missing migration from v${version}`, { source: "migration", meta: { version } })], original);
    try { const result = migration.migrate(config); config = result.config; notes.push(...result.notes); migrations.push(migration.id); version = migration.to; }
    catch (error) { return failureResult("migration", [issue(error.path ?? ["schemaVersion"], "migration.failed", error.message, { source: "migration", meta: { step: migration.id } })], original); }
  }
  const personaSelectionIssues = validatePersonaSelectionFields(config);
  if (personaSelectionIssues.length) return failureResult("structural-validation", personaSelectionIssues, original);
  const secretCandidates = collectSecrets(config);
  config = normalizeConfig(applyConfigDefaults(config));
  return Object.freeze({ ok: true, stage: "complete", config, migrations: Object.freeze(migrations), notes: Object.freeze(notes), secretCandidates: Object.freeze(secretCandidates), canonical: canonicalizeConfig(config), hash: canonicalConfigHash(config) });
}
