// コメント読み上げの順序保証パイプライン (issue #257 Phase 1, #260)。
// runtime-factory.jsのaddCommentは、これまで同期のreadCommentAloud()を直接呼んでいたが、
// 翻訳が絡むと完了順が入れ替わり得るため、このFIFOパイプライン経由に置き換える。
//
// 「何も処理中でなければ即時enqueue」というfast pathを持つのが設計上のポイント:
// commentReader.translation.enabled: false の既定設定では、detect/translateの出番が一切なく
// processCommentForSpeech()は常に同期的に{kind:"speak"}を返すため、submit()自身の呼び出し
// スタック内でspeechQueue.enqueue()まで完了する — 旧readCommentAloud()と挙動もタイミングも
// 完全に同一になる。翻訳が必要なコメント、または既に他のコメントが処理中のときに届いた
// コメントだけが#queueに積まれ、#drain()が1件ずつ順番に確定させる。
import { processCommentForSpeech } from "./comment-speech-processor.js";

export const COMMENT_READER_ID = "__comment_reader__";

// Phase 2 (#261) が実IPC接続のTranslationServiceアダプタに差し替えるまでの既定アダプタ。
// 常にRUNTIME_UNAVAILABLEで失敗するので、翻訳結果の有無に関わらずonFailureポリシーだけが
// 効く (既定のreadOriginalなら原文がそのまま読み上げられる)。
const TRANSLATE_TIMED_OUT = Symbol("translate-timed-out");

export const UNAVAILABLE_TRANSLATION_ADAPTER = Object.freeze({
  async translate() {
    const error = new Error("translation runtime is not available yet");
    error.code = "RUNTIME_UNAVAILABLE";
    throw error;
  },
});

// タブ/改行/CR以外のC0制御文字が混入していないか判定する (issue #257要件の最低限の出力検査)。
// 正規表現のunicodeエスケープはソースファイルへ書き出す経路でリテラル制御バイトへ化けることが
// 確認できたため、charCodeAtでの数値比較にしている。
function hasStrayControlChars(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

export class CommentSpeechPipeline {
  #config;
  #speechQueue;
  #resolveVoice;
  #isCurrent;
  #translationAdapter;
  #log;
  #onTranslated;
  #queue = [];
  #draining = false;
  #disposed = false;

  constructor({ config, speechQueue, resolveVoice, isCurrent, translationAdapter = UNAVAILABLE_TRANSLATION_ADAPTER, log = () => {}, onTranslated = () => {} }) {
    this.#config = config;
    this.#speechQueue = speechQueue;
    this.#resolveVoice = resolveVoice;
    this.#isCurrent = isCurrent;
    this.#translationAdapter = translationAdapter;
    this.#log = log;
    this.#onTranslated = onTranslated;
  }

  submit(comment) {
    if (this.#disposed) return;
    const cr = this.#config.commentReader ?? {};
    const result = processCommentForSpeech(comment, cr);
    if (result.kind === "skip") return;

    // Fast path: 何も処理中でなければ、翻訳不要な結果はこの場でそのままenqueueする。
    if (result.kind === "speak" && this.#queue.length === 0 && !this.#draining) {
      this.#enqueue(comment, cr, [result.originalText]);
      return;
    }

    const maxPending = Math.max(1, Number(cr.translation?.maxPendingComments) || 20);
    // issue #277: コメントは絶対に自動破棄しない。上限は警告の閾値としてのみ使う
    // (翻訳エンジンが遅くても FIFO で順番に処理され、読み上げは失われない)。
    if (this.#queue.length >= maxPending) {
      this.#log(`翻訳待ちコメントが上限(${maxPending}件)を超えましたが、破棄せず順番を待たせます (合計${this.#queue.length + 1}件)`, "warn");
    }
    this.#queue.push({ comment, cr, result });
    void this.#drain();
  }

  async #drain() {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0 && !this.#disposed) {
        const { comment, cr, result } = this.#queue.shift();
        await this.#processQueued(comment, cr, result);
      }
    } finally {
      this.#draining = false;
    }
  }

  async #processQueued(comment, cr, result) {
    if (result.kind === "speak") {
      if (!this.#disposed) this.#enqueue(comment, cr, [result.originalText]);
      return;
    }

    const translation = cr.translation ?? {};
    // 3000msのままだと、config-defaults.jsの既定値(25000ms)がここまで正しく渡ってこなかった
    // 場合に、モデルのコールドロード(~22秒)より短いtimeoutへ静かに戻ってしまう — まさに
    // issue #257で踏んだ不具合と同じ壊れ方になる (PRレビュー指摘: このfallbackだけ更新漏れ)。
    const timeoutMs = Math.max(500, Number(translation.timeoutMs) || 25000);
    const translatedText = await this.#translateWithTimeout(result.originalText, result.detectedLanguage, timeoutMs);
    if (this.#disposed) return;

    // コメント欄表示用 (issue #257要件外の追加要望): 読み上げキューとは独立に、翻訳結果を
    // 呼び出し元 (CommentStore) へ伝える。CommentStoreはgenerationをまたいで生存する
    // (speechQueueのようにgenerationごとに作り直されない) ため、下のisCurrent()チェックより
    // 前で呼び、stale generationでも取りこぼさない (PRレビュー指摘)。#logと同じ「呼び出し元の
    // 例外で読み上げ処理全体を止めない」流儀に合わせ、失敗はここで握りつぶしログするだけに
    // する — DOM描画などの失敗が#drain()のFIFOループごと止まる事態を避ける (PRレビュー指摘)。
    if (translatedText != null) {
      try {
        this.#onTranslated(comment, translatedText);
      } catch (error) {
        this.#log(`onTranslatedコールバックが失敗しました: ${error instanceof Error ? error.message : String(error)}`, "warn");
      }
    }

    // reload/config変更でgenerationが進んでいたら、古いgenerationのspeechQueueへ翻訳結果を
    // enqueueしない (issue #257要件: stale generationの結果を混入させない)。
    if (!this.#isCurrent()) return;

    if (translatedText == null) {
      if (translation.onFailure === "skip") return;
      this.#enqueue(comment, cr, [result.originalText]);
      return;
    }

    const bodies = translation.outputMode === "originalThenTranslated"
      ? [result.originalText, translatedText]
      : [translatedText];
    this.#enqueue(comment, cr, bodies);
  }

  async #translateWithTimeout(text, sourceLanguage, timeoutMs) {
    const controller = new AbortController();
    let timer;
    // timeoutMsが実際にパイプラインの待ち時間を上限するよう、アダプタのpromiseとタイマーを
    // race()する。signal.abortだけをアダプタに送って結果を待ち続けると、abortを無視する
    // (または反応が遅い) アダプタ実装ではtimeoutMsが無意味になり、#drain()のFIFOが
    // ブロックされ続ける (PRレビューで繰り返し指摘された実バグ)。timeout側が先に解決した
    // 場合、取り残されたアダプタのpromiseは後続の.catchで静かに処理させ、ここでは待たない。
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(TRANSLATE_TIMED_OUT); }, timeoutMs);
    });
    const translated = this.#translationAdapter
      .translate({ text, sourceLanguage, targetLanguage: "ja", signal: controller.signal })
      .catch((error) => {
        this.#log(`翻訳に失敗したため原文のまま読み上げます: ${error?.message ?? String(error)}`, "warn");
        return null;
      });
    const outcome = await Promise.race([translated, timedOut]);
    clearTimeout(timer);
    if (outcome === TRANSLATE_TIMED_OUT) return null;
    const translatedText = outcome?.text;
    if (typeof translatedText !== "string") return null;
    const trimmed = translatedText.trim();
    // 空・原文と実質同一・制御文字混入の出力は失敗扱いにする。
    if (!trimmed || trimmed === text.trim() || hasStrayControlChars(trimmed)) return null;
    return trimmed;
  }

  #enqueue(comment, cr, bodies) {
    const voice = this.#resolveVoice();
    bodies.forEach((body, index) => {
      const text = cr.includeAuthor === false ? body : `${comment.author}: ${body}`;
      // bodies.length > 1 は outputMode: originalThenTranslated の [原文, 翻訳] のみ — その
      // 2件目 (翻訳) は同じコメントの続きであり、SpeechQueue側のコメント間隔待ち
      // (commentReaderIntervalMs) を挟むと「原文 → 無音N秒 → 同じコメントの翻訳」になって
      // しまう (PRレビュー指摘)。1件目 (index===0) は他コメントとの間隔を通常どおり尊重する。
      const metadata = index > 0 ? { skipCommentReaderInterval: true } : undefined;
      // preserve: コメントは待機時間・キュー上限で自動破棄されない (issue #277)。
      this.#speechQueue.enqueue({ personaId: COMMENT_READER_ID, personaName: "コメント読み上げ", text, voice, commentId: comment.id, metadata, preserve: true });
    });
  }

  dispose() {
    this.#disposed = true;
    this.#queue = [];
  }
}
