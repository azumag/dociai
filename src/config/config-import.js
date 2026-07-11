import { canonicalConfigHash, CANONICAL_FORMAT_VERSION } from "./config-canonicalize.js";
import { failureResult, issue } from "./config-contract.js";
import { CONFIG_EXPORT_FORMAT, CONFIG_EXPORT_FORMAT_VERSION } from "./config-export.js";
import { processConfig } from "./config-pipeline.js";
export function importConfig(input) {
  const parsed = typeof input === "string" ? JSON.parse(input) : structuredClone(input);
  const isPackage = parsed?.format === CONFIG_EXPORT_FORMAT;
  if (isPackage && parsed.formatVersion !== CONFIG_EXPORT_FORMAT_VERSION) return Object.freeze({ ...failureResult("import-package", [issue(["formatVersion"], "package.version", `Unsupported export package version: ${parsed.formatVersion}`, { source: "import" })], parsed), importFormat: "package" });
  if (isPackage && parsed.canonicalFormatVersion !== CANONICAL_FORMAT_VERSION) return Object.freeze({ ...failureResult("import-package", [issue(["canonicalFormatVersion"], "canonical.version", `Unsupported canonical format version: ${parsed.canonicalFormatVersion}`, { source: "import" })], parsed), importFormat: "package" });
  const config = isPackage ? parsed.config : parsed;
  const result = processConfig(config);
  if (isPackage && result.ok && parsed.revision !== canonicalConfigHash(result.config)) return Object.freeze({ ...failureResult("import-package", [issue(["revision"], "package.revision", "Export package revision does not match its config", { source: "import" })], parsed), importFormat: "package" });
  return Object.freeze({ ...result, importFormat: isPackage ? "package" : "plain" });
}
