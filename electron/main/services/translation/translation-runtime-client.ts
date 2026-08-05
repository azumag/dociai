// TranslationRuntimeをworker_threadで実行するMainプロセス側ファサード。
// 背景: onnxruntime-nodeのInferenceSession生成・run()は同期ネイティブ呼び出しのため、モデル
// ロード (~22秒) や翻訳1件 (~960ms) をElectron Main processのメインスレッドで実行するとアプリ
// 全体が固まる (translation-worker.tsのヘッダコメント参照)。translation-worker.tsを
// worker_threadで起動し、このクラスはメッセージ往復・状態反映・disposeだけを担う。
// 公開API (state/modelId/lastError/warmUp/translate/dispose) は旧TranslationRuntimeと同一に
// 保ち、TranslationServiceやそのテストへの影響を最小にする。
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { TranslationRuntimeState } from "../../../shared/services/translation-contract";

// translation-runtime.ts側の既定値と常に一致させる (workerData経由で必ず同じ値を渡すため、
// 実質の単一情報源はこのファイル)。変更時はtranslation-runtime.tsも併せて更新すること。
export const DEFAULT_MODEL_ID = "Xenova/m2m100_418M";
export const DEFAULT_LOAD_TIMEOUT_MS = 120_000;

// workerDataはstructured-clone可能なものだけ: cacheDir/modelId/loadTimeoutMs (およびテスト用の
// importModulePath)。resourcesPathはonnxruntime-node-shim.cjsがworker_thread内で
// process.resourcesPathを当てにできないpackaged build対策として、Mainプロセスから明示的に渡す。
type WorkerLaunchData = {
  cacheDir: string;
  modelId?: string;
  loadTimeoutMs?: number;
  resourcesPath?: string;
  importModulePath?: string;
};

type WorkerResponse = {
  type: string;
  requestId?: string;
  text?: string;
  state?: TranslationRuntimeState;
  modelId?: string;
  lastError?: { message: string } | undefined;
  message?: string;
};

// テスト用にworkerの最小インターフェースへ絞る (Electron mainのworker_threads.WorkerはNodeの
// EventEmitterで、postMessage/terminate/onを持つ)。
export type TranslationWorkerLike = {
  postMessage(message: unknown): void;
  terminate(): Promise<number> | void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
};

// packaged buildではworker fileがasar外 (extraResources: <resources>/translation-worker.cjs) に
// 配置されるため、process.resourcesPathから解決する — `new Worker()`はasar内のpathを読めない
// (Electron 43で実測確認済み: "Cannot find module ...app.asar/...")。dev/unpacked実行では
// main.cjsの隣 (dist/electron/translation-worker.cjs) に実在する。onnxruntime-node-shim.cjsの
// "manifest.jsonの有無でpackagedを判定" と同じ精神で、ここはファイル実在を直接確認する。
export function resolveTranslationWorkerPath(): string {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "translation-worker.cjs");
    if (fs.existsSync(packaged)) return packaged;
  }
  if (typeof __dirname !== "undefined") return path.join(__dirname, "translation-worker.cjs");
  throw new Error("translation worker path could not be resolved");
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// モデルをロードせずにworkerが起動して応答するかだけを検証するprobe (issue #267の
// native-runtime-probe.tsに相当するworker版)。packaged buildで「worker fileの解決 → bundleの
// ロード → worker_threadの起動」が通ることをCI (smoke-packaged.mjs) が確認するための専用パス
// であり、通常の翻訳フローは使わない。pingだけではtransformers.jsのモジュール初期化
// (= onnxruntime-node-shim評価) は走らない点に注意 — shim評価込みの実翻訳経路はdev向けの
// test:electron:translationが担う。毎回一時的なworkerを起動して終了させる。
export async function probeTranslationWorker(options: {
  cacheDir: string;
  workerPath?: string;
  workerFactory?: () => TranslationWorkerLike;
  timeoutMs?: number;
}): Promise<{ ok: true; state: TranslationRuntimeState; modelId: string } | { ok: false; reason: string }> {
  let worker: TranslationWorkerLike | null = null;
  try {
    worker = options.workerFactory
      ? options.workerFactory()
      : new Worker(options.workerPath ?? resolveTranslationWorkerPath(), {
          workerData: { cacheDir: options.cacheDir, ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {}) },
        });
    const response = await withTimeout(
      new Promise<WorkerResponse>((resolve, reject) => {
        worker!.on("message", (message) => {
          const msg = message as WorkerResponse;
          if (msg.type === "pong") resolve(msg);
        });
        // pongを返さずにworkerが先に終了した場合は、15秒のtimeoutを待たず即失敗させる
        // (packaged CIの失敗を速く・診断しやすくする)。
        worker!.on("exit", (code) => reject(new Error(`translation worker exited (code ${code}) before responding to the probe`)));
        worker!.on("error", reject);
        worker!.postMessage({ type: "ping", requestId: "probe" });
      }),
      options.timeoutMs ?? 15_000,
      "translation worker did not respond to the probe",
    );
    return { ok: true, state: response.state ?? "idle", modelId: response.modelId ?? DEFAULT_MODEL_ID };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (worker) {
      try { worker.terminate(); } catch { /* already exited */ }
    }
  }
}

type PendingRequest = {
  requestId: string;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

export class TranslationRuntimeClient {
  readonly #cacheDir: string;
  readonly #modelId: string;
  readonly #loadTimeoutMs: number;
  readonly #workerPath: string | null;
  readonly #workerFactory: (() => TranslationWorkerLike) | null;
  #worker: TranslationWorkerLike | null = null;
  // 初回の並行呼び出し (warmUp()とtranslate()の競合など) がworkerを二重生成しないための
  // in-flight spawn promise。engine側の#rawLoadPromise (二重モデルロード防止) と同趣旨。
  #spawnPromise: Promise<TranslationWorkerLike> | null = null;
  #state: TranslationRuntimeState = "idle";
  #lastError: Error | null = null;
  #disposed = false;
  #pending = new Map<string, PendingRequest>();
  #requestSeq = 0;

  constructor(options: {
    cacheDir: string;
    modelId?: string;
    loadTimeoutMs?: number;
    workerPath?: string;
    workerFactory?: () => TranslationWorkerLike;
  }) {
    this.#cacheDir = options.cacheDir;
    this.#modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.#loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    this.#workerPath = options.workerPath ?? null;
    this.#workerFactory = options.workerFactory ?? null;
  }

  get state(): TranslationRuntimeState { return this.#state; }
  get modelId(): string { return this.#modelId; }
  get lastError(): Error | null { return this.#lastError; }

  async warmUp(): Promise<void> {
    this.#assertUsable();
    if (this.#state === "ready") return;
    const worker = await this.#ensureWorker();
    // 応答が返るまで"loading"を楽観反映する (旧engineが要求開始と同時にloadingへ遷移していた
    // 挙動を踏襲 — 応答が遅い間のstatus()がidleのままにならないように)。
    this.#state = "loading";
    const request = this.#send(worker, "warmup", {});
    const timer = setTimeout(() => {
      if (!request.settled) {
        request.settled = true;
        this.#pending.delete(request.requestId);
        request.reject(new Error("translation model failed to load within the timeout"));
      }
    }, this.#loadTimeoutMs);
    try {
      await request.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  async translate(text: string, sourceLanguage: string, targetLanguage: string, signal?: AbortSignal): Promise<string> {
    this.#assertUsable();
    const worker = await this.#ensureWorker();
    if (this.#state !== "ready") this.#state = "loading";
    const request = this.#send(worker, "translate", { text, sourceLanguage, targetLanguage });
    const onAbort = () => this.#abort(request);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return (await request.promise) as string;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#failAllPending(new Error("translation runtime was disposed"));
    const worker = this.#worker;
    this.#worker = null;
    this.#state = "idle";
    this.#lastError = null;
    // terminate()はworkerが同期native呼び出し中だと完了が遅れる可能性があるためawaitしない —
    // before-quit → dispose()の呼び出しがquitを遅らせないようにする (fire-and-forget)。
    if (worker) {
      try { worker.terminate(); } catch { /* already exited */ }
    }
  }

  async #ensureWorker(): Promise<TranslationWorkerLike> {
    if (this.#worker) return this.#worker;
    if (!this.#spawnPromise) this.#spawnPromise = this.#spawn();
    try {
      const worker = await this.#spawnPromise;
      // dispose()がspawn中に走った場合 (before-quit等)、生まれたばかりのworkerを即終了して
      // 使わない — dispose後に#workerを設定してしまうと誰もterminateできずに残るのを防ぐ。
      if (this.#disposed) {
        try { worker.terminate(); } catch { /* already exited */ }
        throw new Error("translation runtime is disposed");
      }
      this.#worker = worker;
      return worker;
    } finally {
      this.#spawnPromise = null;
    }
  }

  #spawn(): Promise<TranslationWorkerLike> {
    let worker: TranslationWorkerLike;
    try {
      worker = this.#workerFactory
        ? this.#workerFactory()
        : new Worker(this.#workerPath ?? resolveTranslationWorkerPath(), {
            workerData: { cacheDir: this.#cacheDir, modelId: this.#modelId, loadTimeoutMs: this.#loadTimeoutMs, ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {}) } satisfies WorkerLaunchData,
          });
    } catch (error) {
      // #workerは未設定 (null) のままなので、emittingWorker=nullでteardownは素直に通る。
      this.#teardownWorker(null, error instanceof Error ? error : new Error(String(error)));
      return Promise.reject(error);
    }
    this.#wire(worker);
    return Promise.resolve(worker);
  }

  #wire(worker: TranslationWorkerLike): void {
    // workerをハンドラへ閉じ込めて identity guard に使う — 古いworker (crash後に遅れて届く
    // exit/error) のイベントが、その後spawnされた新しいworkerを誤ってteardownしないように。
    worker.on("message", (message) => this.#onMessage(worker, message as WorkerResponse));
    worker.on("error", (error) => this.#onWorkerError(worker, error));
    worker.on("exit", (code) => this.#onWorkerExit(worker, code));
  }

  #onMessage(worker: TranslationWorkerLike, message: WorkerResponse): void {
    if (this.#disposed) return;
    if (worker !== this.#worker) return; // 旧workerからの遅延メッセージは無視
    // 応答の有無に関わらず状態だけは常にworkerの実状へ揃える — クライアント側timeoutやabortで
    // 要求を捨てた後も、裏で続くロード完了時の状態反映が漏れないようにする。
    this.#reconcile(message);
    const requestId = message.requestId;
    if (requestId == null) return;
    const request = this.#pending.get(requestId);
    if (!request) return;
    this.#pending.delete(requestId);
    if (request.settled) return;
    request.settled = true;
    if (message.type === "warmup:ok" || message.type === "translate:ok") {
      request.resolve(message.type === "translate:ok" ? message.text ?? "" : undefined);
    } else {
      request.reject(new Error(message.message ?? "translation request failed"));
    }
  }

  #reconcile(message: WorkerResponse): void {
    if (typeof message.state === "string") this.#state = message.state;
    if (message.lastError && typeof message.lastError.message === "string") {
      this.#lastError = new Error(message.lastError.message);
    } else if (message.state === "ready") {
      this.#lastError = null;
    }
  }

  #send(worker: TranslationWorkerLike, kind: "warmup" | "translate", payload: Record<string, string>): PendingRequest {
    const requestId = `${kind}:${++this.#requestSeq}`;
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    const request: PendingRequest = { requestId, promise, resolve, reject, settled: false };
    this.#pending.set(requestId, request);
    try {
      worker.postMessage({ type: kind, requestId, ...payload });
    } catch (error) {
      // postMessage失敗 (workerが直前に死んだ等) でpendingを放置しない — 即rejectして呼び出し側の
      // awaitにそのまま伝播させる。
      this.#pending.delete(requestId);
      request.settled = true;
      request.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return request;
  }

  #abort(request: PendingRequest): void {
    if (request.settled) return;
    request.settled = true;
    this.#pending.delete(request.requestId);
    request.reject(new DOMException("translation was cancelled before it started", "AbortError"));
  }

  #onWorkerError(worker: TranslationWorkerLike, error: Error): void {
    if (this.#disposed) return;
    this.#teardownWorker(worker, new Error(`translation worker crashed: ${error instanceof Error ? error.message : String(error)}`));
  }

  #onWorkerExit(worker: TranslationWorkerLike, code: number): void {
    if (this.#disposed) return;
    this.#teardownWorker(worker, new Error(`translation worker exited unexpectedly (code ${code})`));
  }

  #teardownWorker(emittingWorker: TranslationWorkerLike | null, error: Error): void {
    if (this.#disposed) return;
    // identity guard: 既にteardown済みの旧workerから遅れて届いたexit/errorで、新しいworkerを
    // 誤って殺さない。emittingWorkerが現在の#workerと一致するときだけteardownする。
    if (emittingWorker !== this.#worker) return;
    this.#worker = null;
    this.#failAllPending(error);
    this.#state = "error";
    this.#lastError = error;
    if (emittingWorker) {
      try { emittingWorker.terminate(); } catch { /* already exited */ }
    }
  }

  #failAllPending(error: Error): void {
    for (const [requestId, request] of this.#pending) {
      this.#pending.delete(requestId);
      if (request.settled) continue;
      request.settled = true;
      request.reject(error);
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("translation runtime is disposed");
  }
}
