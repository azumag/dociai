import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { PublicIpcError } from "../../../shared/errors";
import { OVERLAY_ASSET_LIMITS, OVERLAY_ASSET_SCHEMA_VERSION, type OverlayAssetRecord } from "../../../shared/overlay-asset-contract";
import type { AppPaths } from "../../paths";

type Registry = { schemaVersion: 1; assets: OverlayAssetRecord[] };
type ReadResult = { state: "missing" | "invalid" } | { state: "valid"; registry: Registry; serialized: string };
type FsApi = typeof fs;
const emptyRegistry = (): Registry => ({ schemaVersion: OVERLAY_ASSET_SCHEMA_VERSION, assets: [] });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FORMAT = Object.freeze({
  "image/png": { kind: "image", extensions: ["png"] }, "image/jpeg": { kind: "image", extensions: ["jpg"] }, "image/webp": { kind: "image", extensions: ["webp"] }, "image/gif": { kind: "image", extensions: ["gif"] },
  "audio/wav": { kind: "audio", extensions: ["wav"] }, "audio/mpeg": { kind: "audio", extensions: ["mp3"] }, "audio/ogg": { kind: "audio", extensions: ["ogg"] },
} as const);

function isErrno(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code); }
function validTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { const keys = Object.keys(value); return keys.length === allowed.length && keys.every((key) => allowed.includes(key)); }
function validRecord(value: unknown): value is OverlayAssetRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>; const format = typeof r.mimeType === "string" ? FORMAT[r.mimeType as keyof typeof FORMAT] : undefined;
  const expectedKeys = ["schemaVersion", "id", "kind", "displayName", "storedFileName", "mimeType", "byteLength", "sha256", "createdAt", "updatedAt", r.kind === "image" ? "image" : "audio"];
  if (!exactKeys(r, expectedKeys)) return false;
  if (r.schemaVersion !== 1 || typeof r.id !== "string" || !UUID.test(r.id) || !format || r.kind !== format.kind) return false;
  if (typeof r.displayName !== "string" || !r.displayName || r.displayName.length > OVERLAY_ASSET_LIMITS.maxDisplayNameChars || /[\u0000-\u001f\u007f]/.test(r.displayName)) return false;
  if (typeof r.storedFileName !== "string" || !format.extensions.some((extension) => r.storedFileName === `${r.id}.${extension}`)) return false;
  if (!Number.isSafeInteger(r.byteLength) || (r.byteLength as number) < 0 || typeof r.sha256 !== "string" || !SHA256.test(r.sha256) || !validTimestamp(r.createdAt) || !validTimestamp(r.updatedAt)) return false;
  if (r.kind === "image") { const image = r.image as Record<string, unknown> | undefined; if (!image || !exactKeys(image, ["width", "height", "animated"]) || !Number.isInteger(image.width) || !Number.isInteger(image.height) || (image.width as number) < 1 || (image.height as number) < 1 || (image.width as number) > OVERLAY_ASSET_LIMITS.maxDimension || (image.height as number) > OVERLAY_ASSET_LIMITS.maxDimension || typeof image.animated !== "boolean") return false; }
  if (r.kind === "audio") { if (!r.audio || typeof r.audio !== "object" || Array.isArray(r.audio)) return false; const audio = r.audio as Record<string, unknown>; if (!exactKeys(audio, audio.durationMs === undefined ? [] : ["durationMs"])) return false; const duration = audio.durationMs; if (duration !== undefined && (!Number.isSafeInteger(duration) || (duration as number) < 0)) return false; }
  return true;
}
function validRegistry(value: unknown): value is Registry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false; const registry = value as { schemaVersion?: unknown; assets?: unknown };
  if (!exactKeys(value as Record<string, unknown>, ["schemaVersion", "assets"])) return false;
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.assets) || registry.assets.length > OVERLAY_ASSET_LIMITS.maxRecords || !registry.assets.every(validRecord)) return false;
  const ids = new Set<string>(); const hashes = new Set<string>();
  return registry.assets.every((record) => { const key = `${record.kind}:${record.sha256}`; if (ids.has(record.id) || hashes.has(key)) return false; ids.add(record.id); hashes.add(key); return true; });
}

export class OverlayAssetRepository {
  constructor(readonly paths: AppPaths, private readonly io: FsApi = fs) {}

  async load(): Promise<{ registry: Registry; recovered: boolean }> {
    const primary = await this.#read(this.paths.overlayAssetRegistryFile);
    if (primary.state === "valid") return { registry: primary.registry, recovered: false };
    const backup = await this.#read(this.paths.overlayAssetRegistryBackupFile);
    if (backup.state === "valid") return { registry: backup.registry, recovered: true };
    if (primary.state === "missing" && backup.state === "missing") return { registry: emptyRegistry(), recovered: false };
    throw new PublicIpcError("REGISTRY_CORRUPT", "アセットregistryが破損しています。backupからも復旧できません");
  }

  async save(assets: OverlayAssetRecord[]): Promise<{ committed: true; warnings: string[] }> {
    const registry: Registry = { schemaVersion: 1, assets };
    if (!validRegistry(registry)) throw new PublicIpcError(assets.length > OVERLAY_ASSET_LIMITS.maxRecords ? "REGISTRY_LIMIT" : "REGISTRY_CORRUPT", "保存するアセットregistryが不正です");
    const data = `${JSON.stringify(registry, null, 2)}\n`; const directory = path.dirname(this.paths.overlayAssetRegistryFile);
    await this.#assertSafeTarget(this.paths.overlayAssetRegistryFile); await this.#assertSafeTarget(this.paths.overlayAssetRegistryBackupFile);
    const primaryBefore = await this.#read(this.paths.overlayAssetRegistryFile); const backupBefore = await this.#read(this.paths.overlayAssetRegistryBackupFile);
    if (primaryBefore.state === "valid") await this.#atomicWrite(this.paths.overlayAssetRegistryBackupFile, primaryBefore.serialized);
    const temporary = `${this.paths.overlayAssetRegistryFile}.tmp-${process.pid}-${Date.now()}`;
    await this.#atomicWrite(this.paths.overlayAssetRegistryFile, data, temporary);
    await this.#syncDirectory(directory);
    const warnings: string[] = [];
    if (primaryBefore.state !== "valid" && backupBefore.state !== "valid") {
      try { await this.#atomicWrite(this.paths.overlayAssetRegistryBackupFile, data); } catch { warnings.push("registry backupを更新できませんでした"); }
    }
    return { committed: true, warnings };
  }

  async #read(file: string): Promise<ReadResult> {
    await this.#assertSafeTarget(file);
    let handle: Awaited<ReturnType<FsApi["open"]>> | null = null;
    try {
      handle = await this.io.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new PublicIpcError("FORBIDDEN", "registry fileが安全ではありません");
      const serialized = await handle.readFile("utf8"); const value: unknown = JSON.parse(serialized); return validRegistry(value) ? { state: "valid", registry: value, serialized } : { state: "invalid" };
    } catch (error) { if (isErrno(error, "ENOENT")) return { state: "missing" }; if (isErrno(error, "ELOOP")) throw new PublicIpcError("FORBIDDEN", "registry fileが安全ではありません"); if (error instanceof SyntaxError) return { state: "invalid" }; if (error instanceof PublicIpcError) throw error; throw new PublicIpcError("UNAVAILABLE", "アセットregistryを読み取れません"); }
    finally { await handle?.close().catch(() => {}); }
  }

  async #assertSafeTarget(file: string): Promise<void> {
    try { const stat = await this.io.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new PublicIpcError("FORBIDDEN", "registry fileが安全ではありません"); }
    catch (error) { if (isErrno(error, "ENOENT")) return; throw error; }
  }

  async #atomicWrite(target: string, data: string, explicitTemporary?: string): Promise<void> {
    const temporary = explicitTemporary ?? `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`; let handle: Awaited<ReturnType<FsApi["open"]>> | null = null;
    try { handle = await this.io.open(temporary, "wx", 0o600); await handle.writeFile(data, "utf8"); await handle.sync(); await handle.close(); handle = null; await this.io.rename(temporary, target); }
    finally { await handle?.close().catch(() => {}); await this.io.rm(temporary, { force: true }).catch(() => {}); }
  }

  async #syncDirectory(directory: string): Promise<void> { try { const handle = await this.io.open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } } catch { /* not supported on every filesystem */ } }
}
