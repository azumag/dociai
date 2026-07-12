// Persists the installed-model registry as JSON with atomic write + backup, mirroring
// ConfigRepository's proven pattern (electron/main/config/config-repository.ts): write to a temp
// file in the same directory, fsync, rename over the real file, and keep the previous version as
// a `.bak` before overwriting. On load, a corrupt primary falls back to `.bak` and reports a
// repair-needed state instead of throwing (#75).
import fs from "node:fs/promises";
import path from "node:path";
import {
  INSTALLED_REGISTRY_SCHEMA_VERSION,
  SUPPORTED_REGISTRY_SCHEMA_VERSIONS,
} from "../../../../shared/local-llm/model-contract";
import type { InstalledModelEntry, InstalledRegistryFile } from "../../../../shared/local-llm/model-contract";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

function emptyRegistry(): InstalledRegistryFile {
  return { schemaVersion: INSTALLED_REGISTRY_SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), models: [] };
}

function isInstalledEntry(value: unknown): value is InstalledModelEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return false;
  if (typeof entry.displayName !== "string") return false;
  if (typeof entry.relativePath !== "string" || entry.relativePath.length === 0) return false;
  if (typeof entry.sizeBytes !== "number" || !Number.isFinite(entry.sizeBytes) || entry.sizeBytes < 0) return false;
  if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) return false;
  if (typeof entry.importedAt !== "string") return false;
  if (!entry.source || typeof entry.source !== "object") return false;
  const sourceKind = (entry.source as Record<string, unknown>).kind;
  if (sourceKind !== "local-import" && sourceKind !== "download") return false;
  return true;
}

function parseRegistry(raw: string): InstalledRegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("registry file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("registry root is not an object");
  const value = parsed as Record<string, unknown>;
  if (typeof value.schemaVersion !== "number" || !SUPPORTED_REGISTRY_SCHEMA_VERSIONS.includes(value.schemaVersion)) {
    throw new Error(`registry schemaVersion is missing or unsupported: ${String(value.schemaVersion)}`);
  }
  if (!Array.isArray(value.models) || !value.models.every(isInstalledEntry)) throw new Error("registry models array is invalid");
  return {
    schemaVersion: value.schemaVersion,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    models: value.models as InstalledModelEntry[],
  };
}

export type LoadedRegistry = { registry: InstalledRegistryFile; repairNeeded: boolean; recovered: boolean; warnings: string[] };

export type InstalledRegistryPaths = { registryFile: string; registryBackupFile: string };

export class InstalledRegistry {
  #writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly paths: InstalledRegistryPaths) {}

  async #locked<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#writeQueue;
    let release!: () => void;
    this.#writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  async #readRaw(): Promise<LoadedRegistry> {
    try {
      const raw = await fs.readFile(this.paths.registryFile, "utf8");
      return { registry: parseRegistry(raw), repairNeeded: false, recovered: false, warnings: [] };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { registry: emptyRegistry(), repairNeeded: false, recovered: false, warnings: [] };
      try {
        const backupRaw = await fs.readFile(this.paths.registryBackupFile, "utf8");
        const registry = parseRegistry(backupRaw);
        await fs.mkdir(path.dirname(this.paths.registryFile), { recursive: true });
        await fs.copyFile(this.paths.registryBackupFile, this.paths.registryFile);
        return { registry, repairNeeded: false, recovered: true, warnings: ["registry.json was corrupted; recovered from registry.json.bak"] };
      } catch {
        return {
          registry: emptyRegistry(),
          repairNeeded: true,
          recovered: false,
          warnings: ["registry.json and registry.json.bak are both unreadable; starting from an empty registry (repair needed)"],
        };
      }
    }
  }

  async #writeRaw(registry: InstalledRegistryFile): Promise<void> {
    const payload: InstalledRegistryFile = { ...registry, schemaVersion: INSTALLED_REGISTRY_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    await fs.mkdir(path.dirname(this.paths.registryFile), { recursive: true });
    try {
      await fs.copyFile(this.paths.registryFile, this.paths.registryBackupFile);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const temporary = `${this.paths.registryFile}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync().catch(() => { /* fsync is best-effort: not every filesystem/CI sandbox supports it. */ });
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, this.paths.registryFile);
  }

  /** Read-only load. Safe without the write lock: `rename` is atomic on POSIX, so a concurrent
   * writer never leaves a reader observing a partially-written file. */
  async load(): Promise<LoadedRegistry> {
    return this.#readRaw();
  }

  async save(registry: InstalledRegistryFile): Promise<void> {
    return this.#locked(() => this.#writeRaw(registry));
  }

  async list(): Promise<{ models: InstalledModelEntry[]; repairNeeded: boolean }> {
    const { registry, repairNeeded } = await this.load();
    return { models: registry.models, repairNeeded };
  }

  async get(modelId: string): Promise<InstalledModelEntry | null> {
    const { registry } = await this.load();
    return registry.models.find((model) => model.id === modelId) ?? null;
  }

  async findByHash(sha256: string): Promise<InstalledModelEntry | null> {
    const needle = sha256.toLowerCase();
    const { registry } = await this.load();
    return registry.models.find((model) => model.sha256.toLowerCase() === needle) ?? null;
  }

  /** Inserts or replaces (by id) a single entry, inside one lock acquisition so the read-modify-
   * write cycle can never interleave with a concurrent save/upsert. */
  async upsert(entry: InstalledModelEntry): Promise<InstalledRegistryFile> {
    return this.#locked(async () => {
      const current = await this.#readRaw();
      const models = [...current.registry.models.filter((model) => model.id !== entry.id), entry];
      const next: InstalledRegistryFile = { schemaVersion: INSTALLED_REGISTRY_SCHEMA_VERSION, updatedAt: new Date().toISOString(), models };
      await this.#writeRaw(next);
      return next;
    });
  }
}
