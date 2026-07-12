// Shared Main/IPC contract for the Local LLM model repository (#75).
// This module only manages model *files and metadata* (catalog, installed registry, local
// import). It never runs inference — that is #45's job, which will consume installed model IDs
// resolved by ModelRepository.resolveInstalledModelPath (Main-process only, never over IPC).

export const CATALOG_SCHEMA_VERSION = 1;
export const SUPPORTED_CATALOG_SCHEMA_VERSIONS: readonly number[] = [1];

export const INSTALLED_REGISTRY_SCHEMA_VERSION = 1;
export const SUPPORTED_REGISTRY_SCHEMA_VERSIONS: readonly number[] = [1];

export type ModelCapability = "chat" | "completion" | "embedding" | "vision" | "tool-use";

export type ModelLicense = { id: string; name: string; url?: string };

/** Catalog entries only ever describe a remote download source; a `local-import` source is an
 * installed-registry concept (the file already exists on disk), not a catalog concept. */
export type ModelCatalogSource = { kind: "download"; url: string };

export type ModelRecommendation = {
  minRamGb?: number;
  recommendedRamGb?: number;
  contextLength?: number;
  note?: string;
};

export type CatalogModelEntry = {
  id: string;
  name: string;
  architecture: string;
  quantization: string;
  parameterCount?: string;
  fileName: string;
  sizeBytes: number;
  /** Lowercase 64-char hex sha256, when the catalog publisher provides one. Used to auto-match a
   * locally-imported file against its catalog entry (see ModelRepository#enrichFromCatalog). */
  sha256?: string;
  license: ModelLicense;
  capabilities: ModelCapability[];
  recommendation?: ModelRecommendation;
  source: ModelCatalogSource;
  description?: string;
};

export type ModelCatalog = {
  schemaVersion: number;
  updatedAt: string;
  models: CatalogModelEntry[];
};

export type InstalledModelSource = {
  kind: "local-import";
  originalFileName: string;
  /** Set when the imported file's hash matched a bundled catalog entry. */
  catalogModelId?: string;
  catalogSchemaVersionAtImport?: number;
};

export type InstalledModelEntry = {
  id: string;
  displayName: string;
  /** Path relative to the models base directory. NEVER an absolute path — see model-paths.ts. */
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  ggufVersion?: number;
  architecture?: string;
  source: InstalledModelSource;
  importedAt: string;
};

export type InstalledRegistryFile = {
  schemaVersion: number;
  updatedAt: string;
  models: InstalledModelEntry[];
};

export type CatalogListResult = { schemaVersion: number; updatedAt: string; models: CatalogModelEntry[]; warnings: string[] };
export type InstalledListResult = { models: InstalledModelEntry[]; repairNeeded: boolean };

export type ImportBeginResult = { token: string; fileName: string; sizeBytes: number } | { cancelled: true };
export type ImportCommitResult =
  | { status: "installed"; model: InstalledModelEntry }
  | { status: "duplicate"; existing: InstalledModelEntry }
  | { status: "failed"; reason: string };
