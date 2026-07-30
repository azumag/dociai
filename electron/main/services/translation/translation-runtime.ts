// 翻訳runtime本体 (issue #257 Phase 2, #261)。transformers.js + ONNX (Xenova/m2m100_418M,
// issue #259でベンチマーク済み: 量子化ONNX一式で約650MB、macOS arm64実測で翻訳あたり平均960ms)
// をMain processで直接実行する。モデルは初回翻訳要求時に遅延ロードし、以降は常駐させて
// 再利用する (ロードには約22秒かかるため、毎回ロードし直すと実用にならない)。
//
// worker_threadは使わない: このリポジトリにworker_thread利用の前例が無く、既存の
// LocalLlmService (node-llama-cpp) も同種のCPU重い推論をMain process上で直接実行している
// (電子main process自体をブロックしない専用の仕組みは存在しない)。同じ前例に合わせ、
// 新しい並行処理プリミティブを導入するリスクを避ける。onnxruntime-nodeのInferenceSession.run()
// はネイティブ側で非同期実行されるため、Node側のイベントループを長時間占有はしない見込みだが、
// 実測はしていない — 将来Main processの応答性が問題になった場合はworker_thread化を検討する。
//
// signalによるキャンセルは「結果を待たない」ベストエフォートに限られる: onnxruntime-nodeの
// 推論呼び出し自体には外部からの中断機構が無く、一度開始した推論はネイティブ側で最後まで走る。
import { pipeline, env } from "@huggingface/transformers";
import type { TranslationRuntimeState } from "../../../shared/services/translation-contract";

const DEFAULT_MODEL_ID = "Xenova/m2m100_418M";
const DEFAULT_DTYPE = "q8";

type Translator = (
  text: string,
  options: { src_lang: string; tgt_lang: string },
) => Promise<Array<{ translation_text?: unknown }> | { translation_text?: unknown }>;

export class TranslationRuntime {
  #modelId: string;
  #translator: Translator | null = null;
  #loadPromise: Promise<Translator> | null = null;
  #state: TranslationRuntimeState = "idle";
  #lastError: Error | null = null;

  constructor(options: { cacheDir: string; modelId?: string }) {
    this.#modelId = options.modelId ?? DEFAULT_MODEL_ID;
    // アプリ起動時・翻訳時に外部へ利用状況やtelemetryを送信しない (issue #257要件)。
    // transformers.js自体はHTTPアクセス統計等を送らない実装のため、追加の抑止設定は不要。
    env.cacheDir = options.cacheDir;
  }

  get state(): TranslationRuntimeState { return this.#state; }
  get modelId(): string { return this.#modelId; }
  get lastError(): Error | null { return this.#lastError; }

  async #ensureLoaded(): Promise<Translator> {
    if (this.#translator) return this.#translator;
    if (!this.#loadPromise) {
      this.#state = "loading";
      this.#loadPromise = (pipeline("translation", this.#modelId, { dtype: DEFAULT_DTYPE } as never) as Promise<unknown>)
        .then((translator) => {
          this.#translator = translator as Translator;
          this.#state = "ready";
          this.#lastError = null;
          return this.#translator;
        })
        .catch((error: unknown) => {
          this.#state = "error";
          this.#lastError = error instanceof Error ? error : new Error(String(error));
          this.#loadPromise = null;
          throw error;
        });
    }
    return this.#loadPromise;
  }

  async translate(text: string, sourceLanguage: string, targetLanguage: string, signal?: AbortSignal): Promise<string> {
    const translator = await this.#ensureLoaded();
    if (signal?.aborted) throw new DOMException("translation was cancelled before it started", "AbortError");
    const output = await translator(text, { src_lang: sourceLanguage, tgt_lang: targetLanguage });
    const first = Array.isArray(output) ? output[0] : output;
    const translated = first && typeof first.translation_text === "string" ? first.translation_text : "";
    return translated;
  }

  dispose(): void {
    this.#translator = null;
    this.#loadPromise = null;
    this.#state = "idle";
  }
}
