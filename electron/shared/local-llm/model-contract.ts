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

export type LocalImportSource = {
  kind: "local-import";
  originalFileName: string;
  /** Set when the imported file's hash matched a bundled catalog entry. */
  catalogModelId?: string;
  catalogSchemaVersionAtImport?: number;
};

/** A model that landed in installed/ via the download service (#76) rather than a local file
 * picker. `url` is the resolved source URL actually fetched (post redirect-resolution start
 * point, not necessarily the final redirect target) — kept for provenance/debugging only. */
export type DownloadedModelSource = {
  kind: "download";
  url: string;
  catalogModelId?: string;
  huggingFace?: { repo: string; revision: string; filename: string };
};

export type InstalledModelSource = LocalImportSource | DownloadedModelSource;

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

// ---------------------------------------------------------------------------------------------
// Download jobs (#76): remote GGUF acquisition with progress/cancel/retry/resume, gated on
// size+hash+GGUF-metadata verification before a job is ever allowed to commit to the installed
// registry above. See electron/main/services/local-llm/models/model-download-service.ts.
// ---------------------------------------------------------------------------------------------

export const DOWNLOAD_JOB_SCHEMA_VERSION = 1;
export const SUPPORTED_DOWNLOAD_JOB_SCHEMA_VERSIONS: readonly number[] = [1];

/** queued: created, not yet connected. downloading: streaming bytes to the partial file.
 * verifying: stream complete, computing sha256 / reading the GGUF header. installing: verified,
 * performing the atomic rename + registry commit. completed: installed, terminal. paused:
 * cancelled-but-kept-partial or recovered-at-restart, resumable via retry(). failed: terminal
 * unless the caller calls retry() to start a fresh attempt. cancelled: partial discarded, terminal. */
export type DownloadJobState = "queued" | "downloading" | "verifying" | "installing" | "completed" | "paused" | "failed" | "cancelled";

export type DownloadJobSource =
  | { kind: "huggingface"; repo: string; revision: string; filename: string }
  | { kind: "url"; url: string };

export type DownloadResumeValidator = { etag?: string; lastModified?: string };

export type DownloadJobError = { code: string; message: string; retryable: boolean };

export type DownloadJobRecord = {
  id: string;
  /** Set when the job was started from a bundled catalog entry. */
  catalogModelId?: string;
  displayName: string;
  fileName: string;
  source: DownloadJobSource;
  /** Snapshotted at job-start time so a later catalog update never retroactively changes an
   * in-flight job's size/hash expectations. */
  expectedSizeBytes: number;
  expectedSha256?: string;
  license: ModelLicense;
  licenseAcceptedAt: string;
  state: DownloadJobState;
  bytesDownloaded: number;
  /** Path relative to the models base directory of the in-progress/partial file, when one
   * exists. Same shape rule as InstalledModelEntry.relativePath: never absolute. */
  partialRelativePath?: string;
  resumeValidator?: DownloadResumeValidator;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  error?: DownloadJobError;
  installedModelId?: string;
};

export type DownloadJobFile = { schemaVersion: number; updatedAt: string; jobs: DownloadJobRecord[] };

export type DownloadProgressEvent = {
  jobId: string;
  state: DownloadJobState;
  bytesDownloaded: number;
  totalBytes?: number;
  bytesPerSecond: number;
  etaSeconds?: number;
  percent?: number;
  at: string;
};

export type DownloadStartInput =
  | { kind: "catalog"; catalogModelId: string; licenseAccepted: boolean }
  | { kind: "huggingface"; repo: string; revision: string; filename: string; displayName: string; expectedSizeBytes: number; expectedSha256?: string; license: ModelLicense; licenseAccepted: boolean };
