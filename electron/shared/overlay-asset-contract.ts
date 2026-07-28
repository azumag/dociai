export const OVERLAY_ASSET_SCHEMA_VERSION = 1 as const;
export const OVERLAY_ASSET_KINDS = ["image", "audio"] as const;
export type OverlayAssetKind = typeof OVERLAY_ASSET_KINDS[number];

export const OVERLAY_ASSET_LIMITS = Object.freeze({
  imageBytes: 20 * 1024 * 1024,
  audioBytes: 50 * 1024 * 1024,
  maxDimension: 8192,
  maxRecords: 500,
  maxDisplayNameChars: 200,
  warningTotalBytes: 1024 * 1024 * 1024,
  hardTotalBytes: 2 * 1024 * 1024 * 1024,
  tmpTtlMs: 24 * 60 * 60 * 1000,
});

export type OverlayAssetRecord = {
  schemaVersion: typeof OVERLAY_ASSET_SCHEMA_VERSION;
  id: string;
  kind: OverlayAssetKind;
  displayName: string;
  storedFileName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  image?: { width: number; height: number; animated: boolean };
  audio?: { durationMs?: number };
};

export type OverlayAssetPublic = Omit<OverlayAssetRecord, "storedFileName"> & { missing?: boolean };
export type OverlayAssetRepairCandidate = { type: "missing-file" | "orphan-file"; assetId?: string };
export type OverlayAssetListResult = { assets: OverlayAssetPublic[]; warnings: string[]; repairCandidates: OverlayAssetRepairCandidate[]; totalBytes: number };

export type OverlayAssetImportResult = { cancelled?: true; asset?: OverlayAssetPublic; deduplicated?: boolean };
export type OverlayAssetPlaybackHandle = { handle: string; mimeType: string };

export interface OverlayAssetsApi {
  list(): Promise<import("./ipc-contract").Result<OverlayAssetListResult>>;
  import(kind?: OverlayAssetKind): Promise<import("./ipc-contract").Result<OverlayAssetImportResult>>;
  remove(input: { assetId: string }): Promise<import("./ipc-contract").Result<{ removed: boolean }>>;
  inspect(input: { assetId: string }): Promise<import("./ipc-contract").Result<{ asset: OverlayAssetPublic }>>;
  getPlaybackHandle(input: { assetId: string }): Promise<import("./ipc-contract").Result<OverlayAssetPlaybackHandle>>;
}
