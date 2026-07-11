import fs from "node:fs/promises";
import path from "node:path";
import { PublicIpcError } from "../../shared/errors";
import type { AppPaths } from "../paths";
import { previewLegacyConfig, type LegacyImportPreview } from "./legacy-importer";
import { mainConfigRevision, processMainConfig } from "./config-schema-adapter";
// @ts-expect-error JavaScript config core intentionally has no separate declaration build.
import { isSecretConfigKey } from "../../../src/config/config-canonicalize.js";

export type LoadedConfig = { config: Record<string, unknown>; revision: string; warnings: string[] };

function stableJson(value: Record<string, unknown>): string { return `${JSON.stringify(value, null, 2)}\n`; }
function isErrno(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code); }

function assertNoSecrets(value: unknown, pathParts: string[] = []): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoSecrets(item, [...pathParts, String(index)])); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (isSecretConfigKey(key) && nested !== undefined && nested !== null && nested !== "") throw new PublicIpcError("INVALID_INPUT", `秘密値はsecret IPCへ分離してください: ${pathParts.concat(key).join(".")}`);
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
      const processed = processMainConfig(JSON.parse(serialized));
      const config = processed.config;
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("root is not object");
      return { config, revision: mainConfigRevision(config), warnings: processed.warnings };
    } catch (error) {
      try {
        const backup = await fs.readFile(this.paths.configBackupFile, "utf8");
        const processed = processMainConfig(JSON.parse(backup)); const config = processed.config;
        await fs.copyFile(this.paths.configBackupFile, this.paths.configRepositoryFile);
        return { config, revision: mainConfigRevision(config), warnings: [...processed.warnings, "config.jsonが破損していたためbackupから復旧しました"] };
      } catch {
        if (isErrno(error, "ENOENT") && this.legacyFile) {
          const legacy = await previewLegacyConfig(this.legacyFile).catch(() => null);
          if (legacy) { const processed = processMainConfig(legacy.config); return { config: processed.config, revision: mainConfigRevision(processed.config), warnings: [...processed.warnings, "legacy configを検出しました。secretを分離してimportしてください"] }; }
        }
        if (isErrno(error, "ENOENT")) { const processed = processMainConfig({ connectors: {}, personas: [], triggers: {} }); return { config: processed.config, revision: mainConfigRevision(processed.config), warnings: processed.warnings }; }
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
      const normalized = processMainConfig(config).config;
      const serialized = stableJson(normalized);
      await fs.mkdir(path.dirname(this.paths.configRepositoryFile), { recursive: true });
      try { await fs.copyFile(this.paths.configRepositoryFile, this.paths.configBackupFile); } catch (error) { if (!isErrno(error, "ENOENT")) throw error; }
      const temporary = `${this.paths.configRepositoryFile}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.paths.configRepositoryFile);
      return { saved: true, revision: mainConfigRevision(normalized) };
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
