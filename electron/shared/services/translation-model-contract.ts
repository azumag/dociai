// コメント読み上げ翻訳モデルのカタログ・導入状態の契約 (issue #257 Phase 3, #262)。
// チャットLLMのモデル管理 (electron/shared/local-llm/model-contract.ts) とは意図的に別の型体系に
// している — 翻訳モデルはGGUF単一ファイルではなく複数ファイル(ONNX重み+tokenizer+config)の
// bundleであり、常駐runtime・catalog・installed registryをチャットLLMと混在させないため。

export type TranslationModelLicense = { id: string; name: string; url?: string };

export type TranslationModelFile = { name: string; url: string; sizeBytes: number; sha256: string };

export type TranslationModelCatalogEntry = {
  id: string;
  displayName: string;
  revision: string;
  license: TranslationModelLicense;
  languages: { source: string[]; target: string[] };
  totalSizeBytes: number;
  files: TranslationModelFile[];
};

export type TranslationModelCatalogFile = {
  schemaVersion: number;
  updatedAt: string;
  models: TranslationModelCatalogEntry[];
};

export type InstalledTranslationModel = {
  id: string;
  displayName: string;
  license: TranslationModelLicense;
  installedAt: string;
  totalSizeBytes: number;
  files: { name: string; sizeBytes: number; sha256: string }[];
};

export type TranslationModelState = "not_installed" | "downloading" | "installed" | "error";

export type TranslationModelDownloadProgress = {
  modelId: string;
  fileName: string;
  fileIndex: number;
  fileCount: number;
  bytesDownloaded: number;
  totalBytes: number;
  bytesPerSecond: number;
  percent?: number;
  etaSeconds?: number;
  state: "downloading" | "verifying" | "installed" | "failed";
  at: string;
};

export type TranslationModelStatus = {
  state: TranslationModelState;
  catalogModel: TranslationModelCatalogEntry;
  installed: InstalledTranslationModel | null;
  lastError?: { message: string };
};
