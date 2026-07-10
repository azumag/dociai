import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PublicIpcError } from "../../shared/errors";
import type { AppPaths } from "../paths";
import { previewLegacyConfig, type LegacyImportPreview } from "./legacy-importer";

export type LoadedConfig = { config: Record<string, unknown>; revision: string; warnings: string[] };

const SECRET_KEYS = new Set(["apiKey", "token", "accessToken", "refreshToken", "clientSecret", "client_secret", "authorization"]);

function stableJson(value: Record<string, unknown>): string { return `${JSON.stringify(value, null, 2)}\n`; }
function revisionOf(serialized: string): string { return crypto.createHash("sha256").update(serialized).digest("hex"); }
function isErrno(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code); }

function assertNoSecrets(value: unknown, pathParts: string[] = []): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoSecrets(item, [...pathParts, String(index)])); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.has(key) && nested !== undefined && nested !== null && nested !== "") throw new PublicIpcError("INVALID_INPUT", `秘密値はsecret IPCへ分離してください: ${pathParts.concat(key).join(".")}`);
    assertNoSecrets(nested, [...pathParts, key]);
  }
}

export class ConfigRepository {
  #writeQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly paths: AppPaths, private readonly legacyFile?: string) {}

  async #locked<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#writeQueue;
    let release!: () => void;
    this.#writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await task(); } finally { release(); }
  }

  async load(): Promise<LoadedConfig> {
    try {
      const serialized = await fs.readFile(this.paths.configRepositoryFile, "utf8");
      const config = JSON.parse(serialized);
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("root is not object");
      return { config, revision: revisionOf(stableJson(config)), warnings: [] };
    } catch (error) {
      try {
        const backup = await fs.readFile(this.paths.configBackupFile, "utf8");
        const config = JSON.parse(backup);
        await fs.copyFile(this.paths.configBackupFile, this.paths.configRepositoryFile);
        return { config, revision: revisionOf(stableJson(config)), warnings: ["config.jsonが破損していたためbackupから復旧しました"] };
      } catch {
        if (isErrno(error, "ENOENT") && this.legacyFile) {
          const legacy = await previewLegacyConfig(this.legacyFile).catch(() => null);
          if (legacy) { const config = { schemaVersion: 1, ...legacy.config }; return { config, revision: revisionOf(stableJson(config)), warnings: ["legacy configを検出しました。secretを分離してimportしてください"] }; }
        }
        if (isErrno(error, "ENOENT")) return { config: { schemaVersion: 1, connectors: {}, personas: [] }, revision: revisionOf(stableJson({ schemaVersion: 1, connectors: {}, personas: [] })), warnings: [] };
        throw new PublicIpcError("INVALID_INPUT", "config.jsonを読み込めません");
      }
    }
  }

  async getPublic(): Promise<LoadedConfig> { return this.load(); }

  async save(config: Record<string, unknown>, expectedRevision?: string): Promise<{ saved: true; revision: string }> {
    return this.#locked(async () => {
      assertNoSecrets(config);
      const current = await this.load();
      if (expectedRevision && expectedRevision !== current.revision) throw new PublicIpcError("CONFIG_CONFLICT", "設定が別のwindowで更新されています");
      const normalized = { schemaVersion: config.schemaVersion ?? 1, ...config };
      const serialized = stableJson(normalized);
      await fs.mkdir(path.dirname(this.paths.configRepositoryFile), { recursive: true });
      try { await fs.copyFile(this.paths.configRepositoryFile, this.paths.configBackupFile); } catch (error) { if (!isErrno(error, "ENOENT")) throw error; }
      const temporary = `${this.paths.configRepositoryFile}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.paths.configRepositoryFile);
      return { saved: true, revision: revisionOf(serialized) };
    });
  }

  async restoreBackup(): Promise<LoadedConfig> {
    return this.#locked(async () => {
      await fs.copyFile(this.paths.configBackupFile, this.paths.configRepositoryFile);
      return this.load();
    });
  }

  async previewLegacy(): Promise<LegacyImportPreview> {
    if (!this.legacyFile) throw new PublicIpcError("NOT_FOUND", "legacy config pathが設定されていません");
    return previewLegacyConfig(this.legacyFile);
  }
}
