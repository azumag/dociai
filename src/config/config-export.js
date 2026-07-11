import { CANONICAL_FORMAT_VERSION, canonicalConfigHash, canonicalizeConfig } from "./config-canonicalize.js";
export const CONFIG_EXPORT_FORMAT = "dociai-config-export";
export const CONFIG_EXPORT_FORMAT_VERSION = 1;
export function createConfigExport(config) {
  const sanitized = JSON.parse(canonicalizeConfig(config));
  return Object.freeze({ format: CONFIG_EXPORT_FORMAT, formatVersion: CONFIG_EXPORT_FORMAT_VERSION, canonicalFormatVersion: CANONICAL_FORMAT_VERSION, revision: canonicalConfigHash(config), exportedAt: new Date().toISOString(), config: sanitized });
}
export function serializeConfigExport(config) { return `${JSON.stringify(createConfigExport(config), null, 2)}\n`; }
