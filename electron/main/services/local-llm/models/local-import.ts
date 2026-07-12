// Local `.gguf` import flow (#75).
//
// Opaque import token flow: the renderer never hands Main an arbitrary filesystem path (a
// compromised/buggy renderer requesting arbitrary local files is exactly what this defends
// against). Instead:
//   1. beginImport() runs Electron's native file dialog IN MAIN and validates the chosen path
//      (exists, regular file, .gguf extension, sane size) and returns an opaque token bound to
//      that source path server-side. No path ever crosses the IPC boundary.
//   2. commitImport(token) copies the file into a staging area, validates magic bytes + hash
//      there, and only after validation passes moves (atomic rename, same filesystem) it into the
//      real models directory and commits the registry entry.
//
// Quarantine policy: a file that fully copied but then failed GGUF/hash validation is moved to a
// quarantine directory for later inspection rather than deleted, since it may be useful for
// diagnosing a bad download. A file that failed mid-*copy* (disk full, source vanished, aborted
// I/O) is instead deleted outright — it is an incomplete blob with nothing to inspect, not a
// "file that failed validation".
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ServiceError } from "../../service-error";
import { MODEL_DIR_NAMES, modelsSubdir, resolveWithinModelsDir, sanitizeIdSegment } from "./model-paths";
import { computeSha256, readGgufHeader } from "./gguf-metadata-reader";
import type { InstalledRegistry } from "./installed-registry";
import type { ImportBeginResult, ImportCommitResult, InstalledModelEntry } from "../../../../shared/local-llm/model-contract";

const SERVICE_ID = "local-llm:import";
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_IMPORT_BYTES = 64 * 1024 * 1024 * 1024; // 64 GiB guard rail against a pathological selection

type StatLike = { size: number; isFile(): boolean };

type PendingImport = { sourcePath: string; fileName: string; sizeBytes: number; createdAt: number };

export type LocalImportDeps = {
  now?: () => number;
  randomToken?: () => string;
  tokenTtlMs?: number;
  copyFile?: (source: string, destination: string) => Promise<void>;
  statFile?: (filePath: string) => Promise<StatLike>;
};

export class LocalImportService {
  #pending = new Map<string, PendingImport>();
  #now: () => number;
  #randomToken: () => string;
  #tokenTtlMs: number;
  #copyFile: (source: string, destination: string) => Promise<void>;
  #statFile: (filePath: string) => Promise<StatLike>;

  constructor(
    private readonly modelsDir: string,
    private readonly registry: InstalledRegistry,
    private readonly chooseFile: () => Promise<string | null>,
    deps: LocalImportDeps = {},
  ) {
    this.#now = deps.now ?? (() => Date.now());
    this.#randomToken = deps.randomToken ?? (() => crypto.randomUUID());
    this.#tokenTtlMs = deps.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.#copyFile = deps.copyFile ?? ((source, destination) => fs.copyFile(source, destination));
    this.#statFile = deps.statFile ?? (async (filePath) => fs.stat(filePath));
  }

  #evictExpired(): void {
    const now = this.#now();
    for (const [token, entry] of this.#pending) {
      if (now - entry.createdAt > this.#tokenTtlMs) this.#pending.delete(token);
    }
  }

  async beginImport(): Promise<ImportBeginResult> {
    this.#evictExpired();
    const sourcePath = await this.chooseFile();
    if (!sourcePath) return { cancelled: true };
    if (!sourcePath.toLowerCase().endsWith(".gguf")) {
      throw new ServiceError("BAD_REQUEST", "selected file is not a .gguf file", { serviceId: SERVICE_ID, retryable: false });
    }
    let stat: StatLike;
    try {
      stat = await this.#statFile(sourcePath);
    } catch {
      throw new ServiceError("BAD_REQUEST", "selected file could not be read", { serviceId: SERVICE_ID, retryable: false });
    }
    if (!stat.isFile()) throw new ServiceError("BAD_REQUEST", "selected path is not a regular file", { serviceId: SERVICE_ID, retryable: false });
    if (stat.size <= 0 || stat.size > MAX_IMPORT_BYTES) throw new ServiceError("BAD_REQUEST", "selected file size is out of range", { serviceId: SERVICE_ID, retryable: false });

    const token = this.#randomToken();
    const fileName = path.basename(sourcePath);
    this.#pending.set(token, { sourcePath, fileName, sizeBytes: stat.size, createdAt: this.#now() });
    return { token, fileName, sizeBytes: stat.size };
  }

  /** Releases a pending token without importing anything (e.g. the renderer's own "cancel"). */
  cancelImport(token: string): boolean {
    return this.#pending.delete(token);
  }

  async commitImport(token: string): Promise<ImportCommitResult> {
    this.#evictExpired();
    const pending = this.#pending.get(token);
    if (!pending) throw new ServiceError("BAD_REQUEST", "import token is invalid or expired", { serviceId: SERVICE_ID, retryable: false });
    this.#pending.delete(token); // tokens are single-use even if the rest of commit fails

    const stagingDir = modelsSubdir(this.modelsDir, MODEL_DIR_NAMES.staging);
    const quarantineDir = modelsSubdir(this.modelsDir, MODEL_DIR_NAMES.quarantine);
    await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const safeFileName = `${sanitizeIdSegment(pending.fileName.replace(/\.gguf$/i, "") || "model")}.gguf`;
    const stagingPath = path.join(stagingDir, `${token}-${safeFileName}`);

    try {
      await this.#copyFile(pending.sourcePath, stagingPath);
    } catch (error) {
      // Mid-copy failure: nothing usable to quarantine, so clean up the partial blob.
      await fs.rm(stagingPath, { force: true }).catch(() => {});
      return { status: "failed", reason: `failed to copy the selected file: ${error instanceof Error ? error.message : String(error)}` };
    }

    const header = await readGgufHeader(stagingPath).catch((error) => ({ valid: false as const, reason: error instanceof Error ? error.message : String(error) }));
    if (!header.valid) {
      await this.#quarantine(stagingPath, quarantineDir, token, safeFileName);
      return { status: "failed", reason: `not a valid GGUF file: ${header.reason}` };
    }

    let sha256: string;
    try {
      sha256 = await computeSha256(stagingPath);
    } catch (error) {
      await this.#quarantine(stagingPath, quarantineDir, token, safeFileName);
      return { status: "failed", reason: `failed to hash the imported file: ${error instanceof Error ? error.message : String(error)}` };
    }

    const existing = await this.registry.findByHash(sha256);
    if (existing) {
      // An exact duplicate of an already-installed file: nothing to inspect, just clean it up and
      // point the caller at the existing installed model.
      await fs.rm(stagingPath, { force: true }).catch(() => {});
      return { status: "duplicate", existing };
    }

    const finalStat = await fs.stat(stagingPath);
    const modelId = `local-${sha256.slice(0, 16)}`;
    const relativePath = path.posix.join(MODEL_DIR_NAMES.installed, sanitizeIdSegment(modelId), safeFileName);
    const finalPath = resolveWithinModelsDir(this.modelsDir, relativePath);

    try {
      await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
      await fs.rename(stagingPath, finalPath);
    } catch (error) {
      await this.#quarantine(stagingPath, quarantineDir, token, safeFileName);
      return { status: "failed", reason: `failed to move imported file into place: ${error instanceof Error ? error.message : String(error)}` };
    }

    const entry: InstalledModelEntry = {
      id: modelId,
      displayName: pending.fileName,
      relativePath,
      sizeBytes: finalStat.size,
      sha256,
      ...(header.architecture ? { architecture: header.architecture } : {}),
      ...(typeof header.version === "number" ? { ggufVersion: header.version } : {}),
      source: { kind: "local-import", originalFileName: pending.fileName },
      importedAt: new Date(this.#now()).toISOString(),
    };

    try {
      await this.registry.upsert(entry);
    } catch (error) {
      // The file already landed in installed/ but the registry commit failed: quarantine it so it
      // is never reported as installed (metadata/hash validation is not "complete" until the
      // registry says so) rather than leaving an unregistered file silently in place.
      await this.#quarantine(finalPath, quarantineDir, token, safeFileName).catch(() => {});
      return { status: "failed", reason: `failed to commit the registry: ${error instanceof Error ? error.message : String(error)}` };
    }

    return { status: "installed", model: entry };
  }

  async #quarantine(filePath: string, quarantineDir: string, token: string, safeFileName: string): Promise<void> {
    try {
      await fs.mkdir(quarantineDir, { recursive: true, mode: 0o700 });
      await fs.rename(filePath, path.join(quarantineDir, `${token}-${safeFileName}`));
    } catch {
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
  }

  dispose(): void {
    this.#pending.clear();
  }
}
