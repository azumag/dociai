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
  #queue = [];
  #draining = false;
  #disposed = false;

  constructor({ config, speechQueue, resolveVoice, isCurrent, translationAdapter = UNAVAILABLE_TRANSLATION_ADAPTER, log = () => {} }) {
    this.#config = config;
    this.#speechQueue = speechQueue;
    this.#resolveVoice = resolveVoice;
    this.#isCurrent = isCurrent;
    this.#translationAdapter = translationAdapter;
    this.#log = log;
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
    if (this.#queue.length >= maxPending) {
      this.#queue.shift();
      this.#log(`翻訳待ちコメントが上限(${maxPending}件)を超えたため、最も古い項目を読み上げずに破棄しました`, "warn");
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
    const timeoutMs = Math.max(500, Number(translation.timeoutMs) || 3000);
    const translatedText = await this.#translateWithTimeout(result.originalText, result.detectedLanguage, timeoutMs);
    // reload/config変更でgenerationが進んだ、またはdispose済みなら、古いgenerationの
    // speechQueueへ翻訳結果をenqueueしない (issue #257要件: stale generationの結果を混入させない)。
    if (this.#disposed || !this.#isCurrent()) return;

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
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await this.#translationAdapter.translate({
        text,
        sourceLanguage,
        targetLanguage: "ja",
        signal: controller.signal,
      });
      const translated = result?.text;
      if (typeof translated !== "string") return null;
      const trimmed = translated.trim();
      // 空・原文と実質同一・制御文字混入の出力は失敗扱いにする。
      if (!trimmed || trimmed === text.trim() || hasStrayControlChars(trimmed)) return null;
      return trimmed;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  #enqueue(comment, cr, bodies) {
    const voice = this.#resolveVoice();
    for (const body of bodies) {
      const text = cr.includeAuthor === false ? body : `${comment.author}: ${body}`;
      this.#speechQueue.enqueue({ personaId: COMMENT_READER_ID, personaName: "コメント読み上げ", text, voice, commentId: comment.id });
    }
  }

  dispose() {
    this.#disposed = true;
    this.#queue = [];
  }
}
