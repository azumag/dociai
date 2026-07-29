import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { PublicIpcError } from "../../../shared/errors";
import { OVERLAY_ASSET_LIMITS, OVERLAY_ASSET_SCHEMA_VERSION, type OverlayAssetKind, type OverlayAssetListResult, type OverlayAssetPublic, type OverlayAssetRecord } from "../../../shared/overlay-asset-contract";
import type { AppPaths } from "../../paths";
import { OverlayAssetRepository } from "./overlay-asset-repository";
import { sanitizeOverlayAssetDisplayName, validateOverlayAssetBytes } from "./overlay-asset-validator";

export type OverlayAssetServiceOptions = {
  paths: AppPaths;
  chooseFile: (kind?: OverlayAssetKind) => Promise<string | null>;
  findReferences: (assetId: string) => Promise<string[]>;
  clock?: () => Date;
  randomId?: () => string;
  decodeImage?: (bytes: Buffer) => { width: number; height: number } | null;
  decodeAudio?: (bytes: Buffer) => Promise<{ durationMs: number } | null>;
  withReferenceLock?: <T>(task: () => Promise<T>) => Promise<T>;
};

function publicAsset(record: OverlayAssetRecord, missing = false): OverlayAssetPublic {
  return Object.freeze({ schemaVersion: record.schemaVersion, id: record.id, kind: record.kind, displayName: record.displayName, mimeType: record.mimeType, byteLength: record.byteLength, sha256: record.sha256, createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.image ? { image: { width: record.image.width, height: record.image.height, animated: record.image.animated } } : {}), ...(record.audio ? { audio: record.audio.durationMs === undefined ? {} : { durationMs: record.audio.durationMs } } : {}), ...(missing ? { missing: true } : {}) });
}

function validAssetId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new PublicIpcError("INVALID_INPUT", "assetIdが不正です");
  return value;
}

function isErrno(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code); }
function mapStorageError(error: unknown): never {
  if (error instanceof PublicIpcError) throw error;
  if (isErrno(error, "ENOSPC") || isErrno(error, "EDQUOT")) throw new PublicIpcError("STORAGE_LIMIT", "アセット保存領域の空き容量が不足しています");
  if (isErrno(error, "EACCES") || isErrno(error, "EPERM") || isErrno(error, "EROFS")) throw new PublicIpcError("UNAVAILABLE", "アセット保存領域へアクセスできません");
  throw error;
}

export class OverlayAssetService {
  readonly repository: OverlayAssetRepository;
  readonly #options: OverlayAssetServiceOptions;
  #writeQueue: Promise<unknown> = Promise.resolve();
  #warnings = new Set<string>();

  constructor(options: OverlayAssetServiceOptions) { this.#options = options; this.repository = new OverlayAssetRepository(options.paths); }

  async initialize(): Promise<void> {
    await this.#ensureManagedDirectories();
    const threshold = Date.now() - OVERLAY_ASSET_LIMITS.tmpTtlMs;
    for (const name of await fs.readdir(this.#options.paths.overlayAssetTmpDir).catch(() => [])) {
      const candidate = path.join(this.#options.paths.overlayAssetTmpDir, name);
      const stat = await fs.lstat(candidate).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < threshold) await fs.rm(candidate, { force: true }).catch(() => {});
    }
  }

  async list(): Promise<OverlayAssetListResult> {
    await this.#ensureManagedDirectories();
    const { registry, recovered } = await this.repository.load();
    const fileNames = new Set(await fs.readdir(this.#options.paths.overlayAssetFilesDir).catch(() => []));
    const registered = new Set(registry.assets.map((record) => record.storedFileName));
    const repairCandidates: OverlayAssetListResult["repairCandidates"] = [];
    const assets = await Promise.all(registry.assets.map(async (record) => {
      const missing = !fileNames.has(record.storedFileName) || !await this.#safeManagedRecord(record).catch(() => false);
      if (missing) repairCandidates.push({ type: "missing-file", assetId: record.id });
      return publicAsset(record, missing);
    }));
    for (const storedFileName of fileNames) if (!registered.has(storedFileName)) repairCandidates.push({ type: "orphan-file" });
    const totalBytes = await this.#physicalManagedBytes();
    const warnings = [...this.#warnings, ...(recovered ? ["registry.jsonが破損していたためbackupを読み取りました"] : []), ...(totalBytes >= OVERLAY_ASSET_LIMITS.warningTotalBytes ? ["managed assetの合計サイズが1 GiB以上です"] : [])];
    return { assets, warnings, repairCandidates, totalBytes };
  }

  async inspect(assetId: unknown): Promise<{ asset: OverlayAssetPublic }> {
    await this.#ensureManagedDirectories();
    const id = validAssetId(assetId); const { registry } = await this.repository.load();
    const record = registry.assets.find((entry) => entry.id === id);
    if (!record) throw new PublicIpcError("NOT_FOUND", "アセットが見つかりません");
    const missing = !await this.#safeManagedFile(record).catch(() => false);
    return { asset: publicAsset(record, missing) };
  }

  async import(kind?: OverlayAssetKind): Promise<{ cancelled?: true; asset?: OverlayAssetPublic; deduplicated?: boolean }> {
    if (kind !== undefined && kind !== "image" && kind !== "audio") throw new PublicIpcError("INVALID_INPUT", "asset kindが不正です");
    const selected = await this.#options.chooseFile(kind);
    if (!selected) return { cancelled: true };
    return this.#locked(async () => {
      await this.#ensureManagedDirectories();
      const hardMax = kind === "audio" ? OVERLAY_ASSET_LIMITS.audioBytes : kind === "image" ? OVERLAY_ASSET_LIMITS.imageBytes : Math.max(OVERLAY_ASSET_LIMITS.imageBytes, OVERLAY_ASSET_LIMITS.audioBytes);
      const { bytes } = await this.#readSelectedFile(selected, hardMax);
      const validated = validateOverlayAssetBytes(bytes, kind);
      const sourceExtension = path.extname(selected).toLowerCase();
      const allowedSourceExtensions = validated.extension === "jpg" ? [".jpg", ".jpeg"] : [`.${validated.extension}`];
      if (!allowedSourceExtensions.includes(sourceExtension)) throw new PublicIpcError("MIME_MISMATCH", "ファイル拡張子と内容が一致しません");
      if (validated.image && this.#options.decodeImage) {
        let decoded: { width: number; height: number } | null = null;
        try { decoded = this.#options.decodeImage(bytes); } catch {}
        if (!decoded || decoded.width !== validated.image.width || decoded.height !== validated.image.height) throw new PublicIpcError("DECODE_FAILED", "Chromiumで画像をdecodeできません");
      }
      let audioMetadata = validated.audio;
      if (validated.audio && this.#options.decodeAudio) {
        let decoded: { durationMs: number } | null = null;
        try { decoded = await this.#options.decodeAudio(bytes); } catch {}
        if (!decoded || !Number.isSafeInteger(decoded.durationMs) || decoded.durationMs < 0) throw new PublicIpcError("DECODE_FAILED", "Chromiumで音声をdecodeできません");
        audioMetadata = { durationMs: decoded.durationMs };
      }
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const { registry } = await this.repository.load();
      const duplicate = registry.assets.find((record) => record.sha256 === sha256 && record.kind === validated.kind);
      if (duplicate) {
        if (!await this.#safeManagedFile(duplicate).then(() => true).catch(() => false)) {
          if (await this.#physicalManagedBytes() + bytes.byteLength > OVERLAY_ASSET_LIMITS.hardTotalBytes) throw new PublicIpcError("STORAGE_LIMIT", "managed assetの合計容量上限を超えます");
          const temporary = path.join(this.#options.paths.overlayAssetTmpDir, `${duplicate.id}.repair`);
          const destination = path.join(this.#options.paths.overlayAssetFilesDir, duplicate.storedFileName);
          try { await this.#writeTemporary(temporary, bytes); await this.#ensureManagedDirectories(); await fs.rename(temporary, destination); await this.#ensureManagedDirectories(); }
          finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
        }
        return { asset: publicAsset(duplicate), deduplicated: true };
      }
      if (registry.assets.length >= OVERLAY_ASSET_LIMITS.maxRecords) throw new PublicIpcError("REGISTRY_LIMIT", "アセット登録件数が上限です");
      if (await this.#physicalManagedBytes() + bytes.byteLength > OVERLAY_ASSET_LIMITS.hardTotalBytes) throw new PublicIpcError("STORAGE_LIMIT", "managed assetの合計容量上限を超えます");
      const id = this.#options.randomId?.() ?? crypto.randomUUID();
      const storedFileName = `${id}.${validated.extension}`;
      const temporary = path.join(this.#options.paths.overlayAssetTmpDir, `${id}.import`);
      const destination = path.join(this.#options.paths.overlayAssetFilesDir, storedFileName);
      const timestamp = (this.#options.clock?.() ?? new Date()).toISOString();
      const record: OverlayAssetRecord = { schemaVersion: OVERLAY_ASSET_SCHEMA_VERSION, id, kind: validated.kind, displayName: sanitizeOverlayAssetDisplayName(path.basename(selected)), storedFileName, mimeType: validated.mimeType, byteLength: bytes.byteLength, sha256, createdAt: timestamp, updatedAt: timestamp, ...(validated.image ? { image: validated.image } : {}), ...(audioMetadata ? { audio: audioMetadata } : {}) };
      try {
        await this.#writeTemporary(temporary, bytes);
        await this.#ensureManagedDirectories(); await fs.rename(temporary, destination); await this.#ensureManagedDirectories();
        try { const saved = await this.repository.save([...registry.assets, record]); saved.warnings.forEach((warning) => this.#warnings.add(warning)); }
        catch (error) { await fs.rm(destination, { force: true }).catch(() => {}); throw error; }
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return { asset: publicAsset(record), deduplicated: false };
    }).catch(mapStorageError);
  }

  async remove(assetId: unknown): Promise<{ removed: boolean }> {
    const id = validAssetId(assetId);
    return this.#locked(() => (this.#options.withReferenceLock ?? (async (task) => task()))(async () => {
      await this.#ensureManagedDirectories();
      const references = await this.#options.findReferences(id);
      if (references.length) throw new PublicIpcError("ASSET_REFERENCED", `参照中のアセットは削除できません: ${references.slice(0, 5).join(", ")}`);
      const { registry } = await this.repository.load(); const record = registry.assets.find((entry) => entry.id === id);
      if (!record) return { removed: false };
      const saved = await this.repository.save(registry.assets.filter((entry) => entry.id !== id)); saved.warnings.forEach((warning) => this.#warnings.add(warning));
      const file = path.join(this.#options.paths.overlayAssetFilesDir, record.storedFileName);
      await this.#ensureManagedDirectories(); await fs.rm(file, { force: true }); await this.#ensureManagedDirectories();
      return { removed: true };
    })).catch(mapStorageError);
  }

  async openPlayback(assetId: unknown): Promise<{ record: OverlayAssetRecord; handle: Awaited<ReturnType<typeof fs.open>>; size: number }> {
    const id = validAssetId(assetId); await this.#ensureManagedDirectories(); const { registry } = await this.repository.load(); const record = registry.assets.find((entry) => entry.id === id);
    if (!record) throw new PublicIpcError("NOT_FOUND", "アセットが見つかりません");
    const candidate = path.join(this.#options.paths.overlayAssetFilesDir, record.storedFileName); let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); const stat = await handle.stat(); const current = await fs.lstat(candidate);
      if (!stat.isFile() || stat.nlink !== 1 || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw new PublicIpcError("FORBIDDEN", "managed assetが安全ではありません");
      await this.#assertManagedDirectory(this.#options.paths.overlayAssetFilesDir, path.join(await fs.realpath(this.#options.paths.overlayAssetsDir), "files"));
      return { record, handle, size: stat.size };
    } catch (error) { await handle?.close().catch(() => {}); throw error; }
  }

  async #safeManagedFile(record: OverlayAssetRecord): Promise<string> {
    await this.#safeManagedRecord(record); return path.join(this.#options.paths.overlayAssetFilesDir, record.storedFileName);
  }

  async #safeManagedRecord(record: OverlayAssetRecord): Promise<void> {
    await this.#ensureManagedDirectories(); const candidate = path.join(this.#options.paths.overlayAssetFilesDir, record.storedFileName); let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try { handle = await fs.open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); const stat = await handle.stat(); const current = await fs.lstat(candidate); if (!stat.isFile() || stat.nlink !== 1 || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw new PublicIpcError("FORBIDDEN", "managed assetが安全ではありません"); await this.#ensureManagedDirectories(); }
    finally { await handle?.close().catch(() => {}); }
  }

  async #readSelectedFile(selected: string, hardMax: number): Promise<{ bytes: Buffer }> {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try { handle = await fs.open(selected, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1) throw new PublicIpcError("INVALID_INPUT", "通常ファイルを選択してください"); if (stat.size > hardMax) throw new PublicIpcError("ASSET_OVERSIZE", "アセットのファイルサイズが上限を超えています"); const bytes = Buffer.alloc(stat.size); let offset = 0; while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw new PublicIpcError("INVALID_INPUT", "選択ファイルを読み取れません"); offset += result.bytesRead; } const current = await fs.lstat(selected); if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) throw new PublicIpcError("INVALID_INPUT", "選択ファイルが変更されました"); return { bytes }; }
    catch (error) { if (isErrno(error, "ELOOP")) throw new PublicIpcError("INVALID_INPUT", "通常ファイルを選択してください"); throw error; }
    finally { await handle?.close().catch(() => {}); }
  }

  async #writeTemporary(file: string, bytes: Buffer): Promise<void> {
    await this.#ensureManagedDirectories(); let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try { handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); await this.#ensureManagedDirectories(); await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle?.close().catch(() => {}); }
  }

  async #ensureManagedDirectories(): Promise<void> {
    const userData = await fs.realpath(this.#options.paths.userDataDir);
    await this.#createSafeDirectory(this.#options.paths.overlayAssetsDir, userData);
    const root = await fs.realpath(this.#options.paths.overlayAssetsDir);
    await this.#createSafeDirectory(this.#options.paths.overlayAssetFilesDir, root);
    await this.#createSafeDirectory(this.#options.paths.overlayAssetTmpDir, root);
  }

  async #createSafeDirectory(directory: string, expectedParent: string): Promise<void> {
    try { await fs.mkdir(directory, { recursive: false, mode: 0o700 }); } catch (error) { if (!isErrno(error, "EEXIST")) throw error; }
    await this.#assertManagedDirectory(directory, path.join(expectedParent, path.basename(directory)));
  }

  async #assertManagedDirectory(directory: string, expectedRealPath: string): Promise<void> {
    const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PublicIpcError("FORBIDDEN", "managed asset directoryが安全ではありません");
    const real = await fs.realpath(directory); if (real !== expectedRealPath) throw new PublicIpcError("FORBIDDEN", "managed asset directoryがuser data外です");
  }

  async #physicalManagedBytes(): Promise<number> {
    let total = 0;
    for (const name of await fs.readdir(this.#options.paths.overlayAssetFilesDir).catch(() => [])) {
      const stat = await fs.lstat(path.join(this.#options.paths.overlayAssetFilesDir, name)).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) total += stat.size;
    }
    return total;
  }

  async #locked<T>(task: () => Promise<T>): Promise<T> { const previous = this.#writeQueue; let release!: () => void; this.#writeQueue = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await task(); } finally { release(); } }
}
