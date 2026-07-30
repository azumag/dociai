// 翻訳モデルのcatalog・導入状態管理 (issue #257 Phase 3, #262)。
// ダウンロード自体はtranslation-model-downloader.tsに委譲する。ここでは disk容量preflight・
// staging→atomic rename・installed registry(JSON)・進捗イベント発火をまとめる。
//
// modelIdは "Xenova/m2m100_418M" のような org/name 形式で、そのままディレクトリの2階層
// (`{modelsDir}/Xenova/m2m100_418M/...`) として使う — transformers.jsのenv.cacheDirが
// 同じ `{cacheDir}/{modelId}/...` 形式でモデルを探すため、意図的にこの形を保つ
// (electron/main/services/local-llm/models/model-paths.tsのsanitizeIdSegmentは1segmentへ
// 平坦化してしまうためここでは使わない)。modelIdは自前のcatalog.json由来の固定値であり、
// Rendererからの入力を一切受け付けないため、pathトラバーサルの脅威モデルはそもそも存在しない。
import fs from "node:fs/promises";
import path from "node:path";
import { ServiceError } from "../service-error";
import { getDiskSpace, hasSufficientSpace } from "../local-llm/models/disk-space";
import { ProgressTracker, createThrottledEmitter } from "../local-llm/models/download-progress";
import { downloadVerifiedFile } from "./translation-model-downloader";
import type {
  TranslationModelCatalogEntry,
  TranslationModelCatalogFile,
  TranslationModelDownloadProgress,
  TranslationModelState,
  TranslationModelStatus,
  InstalledTranslationModel,
} from "../../../shared/services/translation-model-contract";

const SERVICE_ID = "translation:models";
const REGISTRY_FILE_NAME = "installed.json";
const STAGING_DIR_NAME = ".staging";

export class TranslationModelRepository {
  readonly #modelsDir: string;
  readonly #catalogFile: string;
  readonly #emitDownloadProgress: (event: TranslationModelDownloadProgress) => void;
  readonly #getDiskSpace: typeof getDiskSpace;
  readonly #downloadFile: typeof downloadVerifiedFile;
  #catalog: TranslationModelCatalogEntry | null = null;
  #installAbort: AbortController | null = null;
  #lastError: Error | null = null;

  constructor(deps: { modelsDir: string; catalogFile: string; emitDownloadProgress?: (event: TranslationModelDownloadProgress) => void; getDiskSpace?: typeof getDiskSpace; downloadFile?: typeof downloadVerifiedFile }) {
    this.#modelsDir = deps.modelsDir;
    this.#catalogFile = deps.catalogFile;
    this.#emitDownloadProgress = deps.emitDownloadProgress ?? (() => {});
    this.#getDiskSpace = deps.getDiskSpace ?? getDiskSpace;
    this.#downloadFile = deps.downloadFile ?? downloadVerifiedFile;
  }

  async #loadCatalog(): Promise<TranslationModelCatalogEntry> {
    if (this.#catalog) return this.#catalog;
    let parsed: TranslationModelCatalogFile;
    try {
      parsed = JSON.parse(await fs.readFile(this.#catalogFile, "utf8"));
    } catch (error) {
      throw new ServiceError("UNKNOWN", `failed to read translation model catalog: ${error instanceof Error ? error.message : String(error)}`, { serviceId: SERVICE_ID, retryable: false });
    }
    const entry = parsed.models[0];
    if (!entry) throw new ServiceError("UNKNOWN", "translation model catalog is empty", { serviceId: SERVICE_ID, retryable: false });
    this.#catalog = entry;
    return entry;
  }

  #modelDir(model: TranslationModelCatalogEntry): string {
    return path.join(this.#modelsDir, ...model.id.split("/"));
  }

  #registryFile(): string {
    return path.join(this.#modelsDir, REGISTRY_FILE_NAME);
  }

  async #readRegistry(): Promise<InstalledTranslationModel | null> {
    try {
      return JSON.parse(await fs.readFile(this.#registryFile(), "utf8")) as InstalledTranslationModel;
    } catch {
      return null;
    }
  }

  async #writeRegistry(entry: InstalledTranslationModel): Promise<void> {
    await fs.mkdir(this.#modelsDir, { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify(entry, null, 2)}\n`;
    const temporary = `${this.#registryFile()}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporary, serialized, "utf8");
    await fs.rename(temporary, this.#registryFile());
  }

  // installed.json単体を信用せず、実際のモデルディレクトリの存在も確認する。out-of-band削除や
  // delete()自体の`fs.rm(registryFile)`失敗(178行目、意図的に無視している)でレジストリと実体が
  // 食い違うと、registryだけを見た場合「利用可能」と誤表示したままtranslate()がload失敗で落ちる
  // (PRレビュー指摘: 状態表示が実体を反映しない)。
  async #verifiedInstalledEntry(model: TranslationModelCatalogEntry): Promise<InstalledTranslationModel | null> {
    const installed = await this.#readRegistry();
    if (!installed) return null;
    const dirExists = await fs.access(this.#modelDir(model)).then(() => true).catch(() => false);
    return dirExists ? installed : null;
  }

  async status(): Promise<TranslationModelStatus> {
    const model = await this.#loadCatalog();
    const installed = await this.#verifiedInstalledEntry(model);
    const state: TranslationModelState = this.#installAbort ? "downloading" : installed ? "installed" : this.#lastError ? "error" : "not_installed";
    return { state, catalogModel: model, installed, ...(this.#lastError ? { lastError: { message: this.#lastError.message } } : {}) };
  }

  async isInstalled(): Promise<boolean> {
    return (await this.#verifiedInstalledEntry(await this.#loadCatalog())) !== null;
  }

  async modelDirectory(): Promise<string> {
    return this.#modelDir(await this.#loadCatalog());
  }

  cancelInstall(): boolean {
    if (!this.#installAbort) return false;
    this.#installAbort.abort();
    return true;
  }

  async install(): Promise<InstalledTranslationModel> {
    if (this.#installAbort) throw new ServiceError("CONFLICT", "a translation model install is already in progress", { serviceId: SERVICE_ID, retryable: false });
    // ガード直後、他のいかなるawaitより前に同期でinstallAbortを立てる。以前は#loadCatalog()の
    // awaitより後に代入していたため、初回呼び出し (catalogがまだキャッシュされていない=実ファイル
    // I/Oが挟まる) 中に2回目のinstall()が同じガードを通過でき、同じstagingDirを2つのinstall()が
    // 共有して書き込み合う実レースになっていた (PRレビュー指摘)。
    const controller = new AbortController();
    this.#installAbort = controller;
    this.#lastError = null;
    let model: TranslationModelCatalogEntry | undefined;
    try {
      model = await this.#loadCatalog();
      const catalogModel = model; // a plain const so TS can narrow it inside the closure below
      const stagingDir = path.join(this.#modelsDir, STAGING_DIR_NAME, ...model.id.split("/"));
      // fs.statfs (inside getDiskSpace) requires the target path to already exist — on a genuinely
      // fresh install (no prior translation model directory at all), modelsDir itself may not
      // exist yet, so it must be created before the disk-space preflight, not just before staging.
      await fs.mkdir(this.#modelsDir, { recursive: true, mode: 0o700 });
      const diskSpace = await this.#getDiskSpace(this.#modelsDir);
      if (!hasSufficientSpace(diskSpace.freeBytes, model.totalSizeBytes)) {
        throw new ServiceError("BAD_REQUEST", `insufficient disk space for the translation model (need ~${Math.ceil(model.totalSizeBytes / (1024 * 1024))} MB plus headroom)`, { serviceId: SERVICE_ID, retryable: false });
      }

      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });

      for (const [index, file] of model.files.entries()) {
        const tracker = new ProgressTracker();
        const emitThrottled = createThrottledEmitter<TranslationModelDownloadProgress>(500, this.#emitDownloadProgress);
        const destinationPath = path.join(stagingDir, ...file.name.split("/"));
        await this.#downloadFile({
          url: new URL(file.url),
          destinationPath,
          expectedSizeBytes: file.sizeBytes,
          expectedSha256: file.sha256,
          signal: controller.signal,
          onProgress: (bytesDownloaded, totalBytes) => {
            const snapshot = tracker.snapshot(bytesDownloaded, totalBytes);
            emitThrottled({ modelId: catalogModel.id, fileName: file.name, fileIndex: index, fileCount: catalogModel.files.length, bytesDownloaded, totalBytes, bytesPerSecond: snapshot.bytesPerSecond, percent: snapshot.percent, etaSeconds: snapshot.etaSeconds, state: "downloading", at: new Date().toISOString() });
          },
        });
      }

      // ダウンロードループ自体はファイル単位でsignalを見るが、最後のバイトが届いた直後~rename
      // までの間に届いたcancelは今までここで見落とされていた — cancelInstall()は既に{cancelled:
      // true}を返しているのに、install()側はそのままverify/renameを完了させてしまい、
      // 「キャンセルしたはずのモデルがディスクに導入済みとして残る」不整合になっていた
      // (PRレビュー指摘)。全ファイルダウンロード後、rename/registry書き込みへ進む直前に
      // 明示的に再チェックする。
      if (controller.signal.aborted) throw new ServiceError("CANCELLED", "download cancelled", { serviceId: SERVICE_ID, retryable: false });

      // 全ファイルの検証が完了してからatomic renameする — 一部だけ検証済みのファイルが
      // 「導入済み」として見える中間状態を絶対に作らない。
      this.#emitDownloadProgress({ modelId: model.id, fileName: "", fileIndex: model.files.length, fileCount: model.files.length, bytesDownloaded: model.totalSizeBytes, totalBytes: model.totalSizeBytes, bytesPerSecond: 0, percent: 100, state: "verifying", at: new Date().toISOString() });
      const finalDir = this.#modelDir(model);
      await fs.rm(finalDir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(finalDir), { recursive: true, mode: 0o700 });
      await fs.rename(stagingDir, finalDir);

      const entry: InstalledTranslationModel = {
        id: model.id,
        displayName: model.displayName,
        license: model.license,
        installedAt: new Date().toISOString(),
        totalSizeBytes: model.totalSizeBytes,
        files: model.files.map((file) => ({ name: file.name, sizeBytes: file.sizeBytes, sha256: file.sha256 })),
      };
      await this.#writeRegistry(entry);
      // 進捗イベントをRenderer側が受け取ってすぐstatus()を取り直すことがある
      // (settings-ui.jsの購読) — #installAbortをemitより前にクリアしておかないと、その
      // 即座のstatus()呼び出しがまだ#installAbort!==nullのタイミングを踏んで
      // state:"downloading"を返してしまい、以降どの進捗イベントも来ないため画面が
      // 「downloading」に固定されたまま戻らなくなる (PRレビュー指摘の続報として実機ライブ
      // 検証で再現・特定したrace)。
      this.#installAbort = null;
      this.#emitDownloadProgress({ modelId: model.id, fileName: "", fileIndex: model.files.length, fileCount: model.files.length, bytesDownloaded: model.totalSizeBytes, totalBytes: model.totalSizeBytes, bytesPerSecond: 0, percent: 100, state: "installed", at: new Date().toISOString() });
      return entry;
    } catch (error) {
      const normalized = error instanceof ServiceError ? error : new ServiceError("UNKNOWN", error instanceof Error ? error.message : String(error), { serviceId: SERVICE_ID, retryable: true });
      // ユーザーによる意図的なキャンセル (cancelInstall() -> AbortSignal -> CANCELLED) は
      // 「失敗」ではない。#lastErrorを立てたりstate:"failed"を出したりすると、キャンセル直後に
      // 設定UIが「エラー」チップと再試行ボタンを表示してしまう (PRレビュー指摘)。
      const cancelled = normalized.code === "CANCELLED";
      if (!cancelled) this.#lastError = normalized;
      // 上のinstalled分岐と同じ理由でemitより前にクリアする。
      this.#installAbort = null;
      // modelはロード自体 (#loadCatalog()) が失敗した場合はまだ未代入 — その場合は進捗を
      // 報告すべき対象のモデルIDすら分からないため、progressイベントは出さない。
      if (model) {
        this.#emitDownloadProgress({ modelId: model.id, fileName: "", fileIndex: 0, fileCount: model.files.length, bytesDownloaded: 0, totalBytes: model.totalSizeBytes, bytesPerSecond: 0, state: cancelled ? "cancelled" : "failed", at: new Date().toISOString() });
      }
      // 失敗・キャンセルいずれでも、中途半端なstagingを次回install()の実行まで放置しない。
      // catalogは常に単一モデルなので、leaf dirだけでなく.staging全体を消してよい
      // (空の親ディレクトリを残さない)。
      await fs.rm(path.join(this.#modelsDir, STAGING_DIR_NAME), { recursive: true, force: true }).catch(() => {});
      throw normalized;
    }
  }

  async delete(): Promise<{ deleted: boolean }> {
    // install()中のdeleteを許すと、delete()が消した直後にinstall()側のstaging→finalDirの
    // atomic renameが完了してしまい、「削除したはずなのに導入済みのまま」という状態に戻る
    // (PRレビュー指摘の実レース)。install()自身のCONFLICTガードと対称的に扱う。
    if (this.#installAbort) throw new ServiceError("CONFLICT", "cannot delete while a translation model install is in progress", { serviceId: SERVICE_ID, retryable: false });
    const model = await this.#loadCatalog();
    const finalDir = this.#modelDir(model);
    const existed = await fs.access(finalDir).then(() => true).catch(() => false);
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.rm(this.#registryFile(), { force: true }).catch(() => {});
    this.#lastError = null;
    return { deleted: existed };
  }

  dispose(): void {
    this.cancelInstall();
  }
}
