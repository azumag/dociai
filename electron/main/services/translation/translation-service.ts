// コメント読み上げのローカル翻訳サービス (issue #257 Phase 2, #261)。
// AiService.chat() (electron/main/services/ai/ai-service.ts) と同じ ServiceRuntime +
// RequestRegistry + ServiceError の骨格を再利用する — これがこのリポジトリで実際にIPC経由まで
// 通っている唯一の「requestId/timeout/AbortSignal付きのMain処理」パターンであるため
// (LocalLlmServiceのGenerationQueueはIPCへ配線されたことが一度も無い、別系統の未使用パターン)。
//
// 翻訳はRenderer側のCommentSpeechPipeline (src/comment-speech-pipeline.js) が1件ずつ順番に
// 呼び出す設計のため、Main側に別途FIFO admission queueは設けていない — 同時に複数の翻訳要求が
// 飛んでくることは無い前提。将来複数window/複数呼び出し元が増えた場合はGenerationQueue相当の
// admission制御を追加する余地がある。
import type { TranslateInput, TranslateResult, TranslationStatus } from "../../../shared/services/translation-contract";
import { MAX_TRANSLATE_INPUT_CHARS } from "../../../shared/services/translation-contract";
import { ServiceRuntime } from "../service-runtime";
import { ServiceError, normalizeServiceError } from "../service-error";
import { TranslationRuntimeClient, probeTranslationWorker, resolveTranslationWorkerPath } from "./translation-runtime-client";
import type { TranslationModelRepository } from "./translation-model-repository";

// モデルの初回ロードには約22秒かかる (issue #259実測、macOS arm64)。commentReader.translation.
// timeoutMsの既定値(25000ms、issue #257 PRレビュー指摘で3000msから引き上げ済み)に近い/超える
// こともあるため、Main側はより寛容な上限を独自に持ち、初回ロード中の要求をタイムアウトで
// 打ち切ってしまわないようにする。Renderer側のtimeoutMsは「翻訳1件あたりの待ち上限」であり、
// Main側のこの値は「モデルロード+翻訳1件」の絶対上限という別の意味を持つ。
const SERVICE_TIMEOUT_MS = 30_000;

function assertInput(input: TranslateInput): void {
  if (typeof input.text !== "string" || !input.text.trim()) {
    throw new ServiceError("BAD_REQUEST", "text is required", { serviceId: "translation", retryable: false });
  }
  if (input.text.length > MAX_TRANSLATE_INPUT_CHARS) {
    throw new ServiceError("BAD_REQUEST", "text is too long", { serviceId: "translation", retryable: false });
  }
  if (input.sourceLanguage !== "en" && input.sourceLanguage !== "fr") {
    throw new ServiceError("BAD_REQUEST", "unsupported sourceLanguage", { serviceId: "translation", retryable: false });
  }
  if (input.targetLanguage !== "ja") {
    throw new ServiceError("BAD_REQUEST", "unsupported targetLanguage", { serviceId: "translation", retryable: false });
  }
}

export class TranslationService {
  readonly runtime = new ServiceRuntime("translation");
  readonly #modelRuntime: TranslationRuntimeClient;
  readonly #modelRepository: TranslationModelRepository | null;
  readonly #timeoutMs: number;
  readonly #cacheDir: string;
  readonly #workerPath: string | null;

  constructor(deps: { cacheDir: string; modelRuntime?: TranslationRuntimeClient; modelRepository?: TranslationModelRepository | null; timeoutMs?: number; workerPath?: string }) {
    this.#cacheDir = deps.cacheDir;
    this.#workerPath = deps.workerPath ?? null;
    // issue #257 Phase 3 (#262): modelRepositoryが無い場合はテスト用途のフォールバック
    // (モデル導入状態の確認をスキップし、モデル自体があるかどうかだけで判断する既存挙動)。
    this.#modelRepository = deps.modelRepository ?? null;
    this.#modelRuntime = deps.modelRuntime ?? new TranslationRuntimeClient({ cacheDir: deps.cacheDir, ...(deps.workerPath ? { workerPath: deps.workerPath } : {}) });
    this.#timeoutMs = deps.timeoutMs ?? SERVICE_TIMEOUT_MS;
  }

  // モデルをロードせずにworkerが起動して応答するかを検証するprobe (issue #267の
  // native-runtime-probe.tsのworker版)。packaged buildで「worker file解決 → bundleロード →
  // worker_thread起動」が通ることをsmoke-packaged.mjsのCIが確認するための専用パス。
  probeWorker(): Promise<{ ok: true; state: string; modelId: string } | { ok: false; reason: string }> {
    return probeTranslationWorker({ cacheDir: this.#cacheDir, workerPath: this.#workerPath ?? resolveTranslationWorkerPath() });
  }

  cancel(requestId: string): boolean {
    return this.runtime.registry.cancel(requestId, "cancelled");
  }

  status(): TranslationStatus {
    const error = this.#modelRuntime.lastError;
    return { state: this.#modelRuntime.state, modelId: this.#modelRuntime.modelId, ...(error ? { lastError: { message: error.message } } : {}) };
  }

  // issue #257: 翻訳が有効化された時点でモデルロード(~22秒)を先に走らせておき、実際のコメントが
  // 届いた時点では既に常駐済みにする (renderer側のtimeoutMsがロード時間を賄えない問題への対策、
  // translation-runtime.tsのwarmUp()コメント参照)。失敗時はここで例外を投げず飲み込む —
  // #modelRuntime.lastError/status()に既に反映されるため、実際の翻訳要求が来た際に通常の
  // エラー経路 (ログ・設定画面) でユーザーへ可視化される。ここで投げてもfire-and-forgetの
  // 呼び出し元 (boot.js) には意味のある届け先が無い。
  async warmUp(): Promise<void> {
    try {
      if (this.#modelRepository && !(await this.#modelRepository.isInstalled())) return;
      await this.#modelRuntime.warmUp();
    } catch {
      // status()経由で可視化されるため、ここでは何もしない (上のコメント参照)。
    }
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    assertInput(input);
    // issue #257要件: モデル未導入のまま呼ばれた場合、無言で外部APIへ切り替えたりダウンロードを
    // 試みたりせず、明示的なエラーを返す (env.allowRemoteModels=falseがtransformers.js側の
    // フォールバックを防ぎ、ここはIPCの呼び出し元へ分かりやすいメッセージを返す役目)。
    if (this.#modelRepository && !(await this.#modelRepository.isInstalled())) {
      throw new ServiceError("UNAVAILABLE", "translation model is not installed", { serviceId: "translation", retryable: false });
    }
    const generation = input.generation ?? this.runtime.generation;
    if (generation !== this.runtime.generation) {
      throw new ServiceError("CANCELLED", "request generation is stale", { serviceId: "translation", retryable: false });
    }
    const handle = this.runtime.registry.create({ serviceId: "translation", generation, ownerId: input.ownerId ?? "console", requestId: input.requestId, timeoutMs: this.#timeoutMs });
    const startedAt = Date.now();
    try {
      const text = await this.#modelRuntime.translate(input.text, input.sourceLanguage, input.targetLanguage, handle.context.signal);
      if (handle.context.generation !== this.runtime.generation || handle.context.signal.aborted) {
        throw new ServiceError("CANCELLED", "request generation is stale", { serviceId: "translation", retryable: false });
      }
      if (!text.trim()) throw new ServiceError("UNKNOWN", "translation produced an empty result", { serviceId: "translation", retryable: false });
      const result: TranslateResult = {
        text: text.trim(),
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        requestId: handle.context.requestId,
        durationMs: Date.now() - startedAt,
        modelId: this.#modelRuntime.modelId,
      };
      handle.complete(result);
      this.runtime.health.report({ type: "completed", serviceId: "translation", requestId: handle.context.requestId, at: Date.now() });
      return result;
    } catch (error) {
      const normalized = normalizeServiceError(error, handle.context);
      handle.fail(normalized);
      this.runtime.health.report({ type: "failed", serviceId: "translation", requestId: handle.context.requestId, at: Date.now(), error: normalized.toJSON() });
      throw normalized;
    }
  }

  dispose(): void {
    this.runtime.dispose();
    this.#modelRuntime.dispose();
  }
}
