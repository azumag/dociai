// Facade combining the catalog, installed registry, local import, and download flows (#75, #76).
// This is the module IPC handlers and (eventually, #45) the inference runtime talk to; nothing
// outside this file constructs a models-directory path directly.
import path from "node:path";
import { ServiceError } from "../../service-error";
import { InstalledRegistry } from "./installed-registry";
import { LocalImportService } from "./local-import";
import type { LocalImportDeps } from "./local-import";
import { DownloadJobStore } from "./download-job-store";
import { ModelDownloadService } from "./model-download-service";
import type { ModelDownloadDeps } from "./model-download-service";
import { loadBundledCatalog } from "./catalog-loader";
import { assertRealPathWithinModelsDir, resolveWithinModelsDir } from "./model-paths";
import type { SecretStore } from "../../../../shared/secret-contract";
import type {
  CatalogListResult,
  DownloadJobRecord,
  DownloadProgressEvent,
  DownloadStartInput,
  ImportBeginResult,
  ImportCommitResult,
  InstalledListResult,
  InstalledModelEntry,
} from "../../../../shared/local-llm/model-contract";

const SERVICE_ID = "local-llm";

export type ModelRepositoryOptions = {
  modelsDir: string;
  catalogFile: string;
  chooseFile: () => Promise<string | null>;
  secretStore: SecretStore;
  emitDownloadProgress?: (event: DownloadProgressEvent) => void;
};

export class ModelRepository {
  readonly registry: InstalledRegistry;
  readonly localImport: LocalImportService;
  readonly downloads: ModelDownloadService;
  readonly #modelsDir: string;
  readonly #catalogFile: string;

  constructor(options: ModelRepositoryOptions, importDeps: LocalImportDeps = {}, downloadDeps: ModelDownloadDeps = {}) {
    this.#modelsDir = options.modelsDir;
    this.#catalogFile = options.catalogFile;
    this.registry = new InstalledRegistry({
      registryFile: path.join(options.modelsDir, "registry.json"),
      registryBackupFile: path.join(options.modelsDir, "registry.json.bak"),
    });
    this.localImport = new LocalImportService(options.modelsDir, this.registry, options.chooseFile, importDeps);
    const jobStore = new DownloadJobStore({
      jobsFile: path.join(options.modelsDir, "download-jobs.json"),
      jobsBackupFile: path.join(options.modelsDir, "download-jobs.json.bak"),
    });
    this.downloads = new ModelDownloadService(options.modelsDir, jobStore, this.registry, options.secretStore, options.emitDownloadProgress ?? (() => {}), downloadDeps);
  }

  /** Reclassifies any download job left mid-flight by an unclean shutdown into resumable/cleanup
   * candidates (#76). Callers (main/index.ts) must await this once at startup, before registering
   * IPC handlers, so no request can observe a stale "downloading" job that no longer has an
   * active controller behind it. */
  async initializeDownloads(): Promise<{ resumed: string[]; failed: string[]; reconciled: string[] }> {
    return this.downloads.recoverOnStartup();
  }

  async listCatalog(): Promise<CatalogListResult> {
    const { catalog, warnings } = await loadBundledCatalog(this.#catalogFile);
    return { schemaVersion: catalog.schemaVersion, updatedAt: catalog.updatedAt, models: catalog.models, warnings };
  }

  async listInstalled(): Promise<InstalledListResult> {
    return this.registry.list();
  }

  async getInstalled(modelId: string): Promise<InstalledModelEntry | null> {
    if (typeof modelId !== "string" || !modelId) throw new ServiceError("BAD_REQUEST", "modelId is required", { serviceId: SERVICE_ID, retryable: false });
    return this.registry.get(modelId);
  }

  beginImport(): Promise<ImportBeginResult> {
    return this.localImport.beginImport();
  }

  cancelImport(token: string): boolean {
    return this.localImport.cancelImport(token);
  }

  async commitImport(token: string): Promise<ImportCommitResult> {
    const result = await this.localImport.commitImport(token);
    if (result.status !== "installed") return result;
    return { status: "installed", model: await this.#enrichFromCatalog(result.model) };
  }

  /** Best-effort: if the freshly-imported file's hash matches a bundled catalog entry, tag the
   * registry entry with that catalog model id/display name so "registered via catalog" and
   * "registered via local import" both surface through the same installed-registry record.
   * Never fails the import itself — catalog metadata is a nice-to-have enrichment. Only ever
   * called right after a local-import commit, so `model.source.kind` is always "local-import"
   * here, but the check is still real (not just a type-narrowing formality): it keeps this
   * enrichment a no-op if it were ever reused for a download-sourced entry. */
  async #enrichFromCatalog(model: InstalledModelEntry): Promise<InstalledModelEntry> {
    try {
      if (model.source.kind !== "local-import") return model;
      const { catalog } = await loadBundledCatalog(this.#catalogFile);
      const match = catalog.models.find((candidate) => candidate.sha256 && candidate.sha256 === model.sha256);
      if (!match) return model;
      const enriched: InstalledModelEntry = {
        ...model,
        displayName: match.name,
        source: { ...model.source, catalogModelId: match.id, catalogSchemaVersionAtImport: catalog.schemaVersion },
      };
      await this.registry.upsert(enriched);
      return enriched;
    } catch {
      return model;
    }
  }

  /** Normalizes the IPC-facing DownloadStartInput union (catalog id vs. explicit HF source) into
   * the download service's concrete start shape, resolving a `kind: "catalog"` request against
   * the bundled catalog (the same file listCatalog() reads) so the service itself never needs to
   * know about the catalog at all. */
  async startDownload(input: DownloadStartInput): Promise<DownloadJobRecord> {
    if (!input.licenseAccepted) throw new ServiceError("BAD_REQUEST", "license must be accepted before starting a download", { serviceId: SERVICE_ID, retryable: false });
    if (input.kind === "catalog") {
      const { catalog } = await loadBundledCatalog(this.#catalogFile);
      const model = catalog.models.find((candidate) => candidate.id === input.catalogModelId);
      if (!model) throw new ServiceError("BAD_REQUEST", "catalog model was not found", { serviceId: SERVICE_ID, retryable: false });
      return this.downloads.start({
        source: { kind: "url", url: model.source.url },
        displayName: model.name,
        fileName: model.fileName,
        expectedSizeBytes: model.sizeBytes,
        ...(model.sha256 ? { expectedSha256: model.sha256 } : {}),
        license: model.license,
        catalogModelId: model.id,
      });
    }
    if (input.kind === "huggingface") {
      return this.downloads.start({
        source: { kind: "huggingface", repo: input.repo, revision: input.revision, filename: input.filename },
        displayName: input.displayName,
        fileName: input.filename,
        expectedSizeBytes: input.expectedSizeBytes,
        ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
        license: input.license,
      });
    }
    throw new ServiceError("BAD_REQUEST", "unknown download start kind", { serviceId: SERVICE_ID, retryable: false });
  }

  cancelDownload(jobId: string, deletePartial?: boolean): Promise<boolean> {
    return this.downloads.cancel(jobId, deletePartial === undefined ? {} : { deletePartial });
  }

  retryDownload(jobId: string): Promise<DownloadJobRecord> {
    return this.downloads.retry(jobId);
  }

  listDownloads(): Promise<DownloadJobRecord[]> {
    return this.downloads.list();
  }

  getDownload(jobId: string): Promise<DownloadJobRecord | null> {
    return this.downloads.status(jobId);
  }

  /** Resolves an installed model ID to an absolute, symlink-checked path. Main-process only,
   * intended for the future (#45) inference runtime — never exposed over IPC, since the public
   * contract only ever passes installed model IDs around (never absolute paths). */
  async resolveInstalledModelPath(modelId: string): Promise<string> {
    const model = await this.getInstalled(modelId);
    if (!model) throw new ServiceError("BAD_REQUEST", "installed model was not found", { serviceId: SERVICE_ID, retryable: false });
    const resolved = resolveWithinModelsDir(this.#modelsDir, model.relativePath);
    return assertRealPathWithinModelsDir(this.#modelsDir, resolved);
  }

  dispose(): void {
    this.localImport.dispose();
    this.downloads.dispose();
  }
}
