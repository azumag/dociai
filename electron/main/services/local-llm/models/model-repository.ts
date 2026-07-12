// Facade combining the catalog, installed registry, and local import flow (#75). This is the
// module IPC handlers and (eventually, #45) the inference runtime talk to; nothing outside this
// file constructs a models-directory path directly.
import path from "node:path";
import { ServiceError } from "../../service-error";
import { InstalledRegistry } from "./installed-registry";
import { LocalImportService } from "./local-import";
import type { LocalImportDeps } from "./local-import";
import { loadBundledCatalog } from "./catalog-loader";
import { assertRealPathWithinModelsDir, resolveWithinModelsDir } from "./model-paths";
import type {
  CatalogListResult,
  ImportBeginResult,
  ImportCommitResult,
  InstalledListResult,
  InstalledModelEntry,
} from "../../../../shared/local-llm/model-contract";

const SERVICE_ID = "local-llm";

export type ModelRepositoryOptions = { modelsDir: string; catalogFile: string; chooseFile: () => Promise<string | null> };

export class ModelRepository {
  readonly registry: InstalledRegistry;
  readonly localImport: LocalImportService;
  readonly #modelsDir: string;
  readonly #catalogFile: string;

  constructor(options: ModelRepositoryOptions, importDeps: LocalImportDeps = {}) {
    this.#modelsDir = options.modelsDir;
    this.#catalogFile = options.catalogFile;
    this.registry = new InstalledRegistry({
      registryFile: path.join(options.modelsDir, "registry.json"),
      registryBackupFile: path.join(options.modelsDir, "registry.json.bak"),
    });
    this.localImport = new LocalImportService(options.modelsDir, this.registry, options.chooseFile, importDeps);
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
   * Never fails the import itself — catalog metadata is a nice-to-have enrichment. */
  async #enrichFromCatalog(model: InstalledModelEntry): Promise<InstalledModelEntry> {
    try {
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
  }
}
