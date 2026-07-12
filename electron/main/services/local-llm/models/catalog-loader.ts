// Loads and validates the app-bundled model catalog (resources/catalog/local-models.json).
// Only the bundled file is handled here; merging in a remotely-fetched catalog update is out of
// scope for #75 (that needs the HF token wiring that #76 owns) — the schemaVersion returned here
// is what a future merge step would compare against.
import fs from "node:fs/promises";
import { ServiceError } from "../../service-error";
import {
  CATALOG_SCHEMA_VERSION,
  SUPPORTED_CATALOG_SCHEMA_VERSIONS,
} from "../../../../shared/local-llm/model-contract";
import type {
  CatalogModelEntry,
  ModelCapability,
  ModelCatalog,
  ModelCatalogSource,
  ModelLicense,
  ModelRecommendation,
} from "../../../../shared/local-llm/model-contract";

const SERVICE_ID = "local-llm:catalog";
const KNOWN_CAPABILITIES: readonly ModelCapability[] = ["chat", "completion", "embedding", "vision", "tool-use"];
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function invalid(message: string): ServiceError {
  return new ServiceError("BAD_REQUEST", `local model catalog is invalid: ${message}`, { serviceId: SERVICE_ID, retryable: false });
}

function assertCapabilities(value: unknown, context: string): ModelCapability[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid(`${context}.capabilities must be a non-empty array`);
  for (const capability of value) {
    if (!KNOWN_CAPABILITIES.includes(capability as ModelCapability)) throw invalid(`${context}.capabilities contains an unknown capability: ${String(capability)}`);
  }
  return value as ModelCapability[];
}

function assertLicense(value: unknown, context: string): ModelLicense {
  if (!value || typeof value !== "object") throw invalid(`${context}.license is required`);
  const license = value as Record<string, unknown>;
  if (typeof license.id !== "string" || !license.id) throw invalid(`${context}.license.id is required`);
  if (typeof license.name !== "string" || !license.name) throw invalid(`${context}.license.name is required`);
  if (license.url !== undefined && typeof license.url !== "string") throw invalid(`${context}.license.url must be a string`);
  return { id: license.id, name: license.name, ...(license.url ? { url: license.url as string } : {}) };
}

function assertSource(value: unknown, context: string): ModelCatalogSource {
  if (!value || typeof value !== "object") throw invalid(`${context}.source is required`);
  const source = value as Record<string, unknown>;
  if (source.kind !== "download") throw invalid(`${context}.source.kind must be "download"`);
  if (typeof source.url !== "string" || !/^https:\/\//.test(source.url)) throw invalid(`${context}.source.url must be an https URL`);
  return { kind: "download", url: source.url };
}

function numberField(record: Record<string, unknown>, key: string, context: string): number | undefined {
  if (record[key] === undefined) return undefined;
  if (typeof record[key] !== "number" || !Number.isFinite(record[key] as number)) throw invalid(`${context}.${key} must be a number`);
  return record[key] as number;
}

function assertRecommendation(value: unknown, context: string): ModelRecommendation {
  if (!value || typeof value !== "object") throw invalid(`${context}.recommendation must be an object`);
  const record = value as Record<string, unknown>;
  const minRamGb = numberField(record, "minRamGb", context);
  const recommendedRamGb = numberField(record, "recommendedRamGb", context);
  const contextLength = numberField(record, "contextLength", context);
  if (record.note !== undefined && typeof record.note !== "string") throw invalid(`${context}.recommendation.note must be a string`);
  return {
    ...(minRamGb !== undefined ? { minRamGb } : {}),
    ...(recommendedRamGb !== undefined ? { recommendedRamGb } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(typeof record.note === "string" ? { note: record.note } : {}),
  };
}

function assertModel(value: unknown, index: number, seenIds: Set<string>): CatalogModelEntry {
  const context = `models[${index}]`;
  if (!value || typeof value !== "object") throw invalid(`${context} must be an object`);
  const model = value as Record<string, unknown>;
  if (typeof model.id !== "string" || !model.id) throw invalid(`${context}.id is required`);
  if (seenIds.has(model.id)) throw invalid(`${context}.id "${model.id}" is duplicated`);
  seenIds.add(model.id);
  if (typeof model.name !== "string" || !model.name) throw invalid(`${context}.name is required`);
  if (typeof model.architecture !== "string" || !model.architecture) throw invalid(`${context}.architecture is required`);
  if (typeof model.quantization !== "string" || !model.quantization) throw invalid(`${context}.quantization is required`);
  if (typeof model.fileName !== "string" || !model.fileName || /[\\/]/.test(model.fileName)) throw invalid(`${context}.fileName must be a bare file name`);
  if (typeof model.sizeBytes !== "number" || !Number.isFinite(model.sizeBytes) || model.sizeBytes <= 0) throw invalid(`${context}.sizeBytes must be a positive number`);
  if (model.sha256 !== undefined && (typeof model.sha256 !== "string" || !SHA256_PATTERN.test(model.sha256))) throw invalid(`${context}.sha256 must be a 64-character hex string`);
  if (model.parameterCount !== undefined && typeof model.parameterCount !== "string") throw invalid(`${context}.parameterCount must be a string`);
  if (model.description !== undefined && typeof model.description !== "string") throw invalid(`${context}.description must be a string`);

  const capabilities = assertCapabilities(model.capabilities, context);
  const license = assertLicense(model.license, context);
  const source = assertSource(model.source, context);

  return {
    id: model.id,
    name: model.name,
    architecture: model.architecture,
    quantization: model.quantization,
    ...(typeof model.parameterCount === "string" ? { parameterCount: model.parameterCount } : {}),
    fileName: model.fileName,
    sizeBytes: model.sizeBytes,
    ...(typeof model.sha256 === "string" ? { sha256: model.sha256.toLowerCase() } : {}),
    license,
    capabilities,
    ...(model.recommendation !== undefined ? { recommendation: assertRecommendation(model.recommendation, context) } : {}),
    source,
    ...(typeof model.description === "string" ? { description: model.description } : {}),
  };
}

export function parseCatalog(raw: string): { catalog: ModelCatalog; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("root must be an object");
  const value = parsed as Record<string, unknown>;

  if (typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) throw invalid("schemaVersion must be an integer");
  if (!SUPPORTED_CATALOG_SCHEMA_VERSIONS.includes(value.schemaVersion)) {
    const relation = value.schemaVersion > CATALOG_SCHEMA_VERSION ? "newer than this app supports" : "older and no longer supported";
    throw invalid(`schemaVersion ${value.schemaVersion} is ${relation} (supported: ${SUPPORTED_CATALOG_SCHEMA_VERSIONS.join(", ")})`);
  }
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) throw invalid("updatedAt must be an ISO date string");
  if (!Array.isArray(value.models)) throw invalid("models must be an array");

  const seenIds = new Set<string>();
  const models = value.models.map((model, index) => assertModel(model, index, seenIds));
  return { catalog: { schemaVersion: value.schemaVersion, updatedAt: value.updatedAt, models }, warnings: [] };
}

export async function loadBundledCatalog(catalogFile: string): Promise<{ catalog: ModelCatalog; warnings: string[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(catalogFile, "utf8");
  } catch {
    throw new ServiceError("UNAVAILABLE", "bundled model catalog is missing", { serviceId: SERVICE_ID, retryable: false });
  }
  return parseCatalog(raw);
}
