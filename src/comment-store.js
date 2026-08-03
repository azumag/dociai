// コメント履歴 (issue #5)
// 3層文脈のうち「生ログ (リングバッファ)」と「長期要約 streamSummary」を持つ。
// プロンプト投入用の直近N件は recent(n) で取り出す。

let seq = 0;

export class CommentStore {
  constructor({ limit = 80 } = {}) {
    this.limit = limit;
    this.comments = [];
    this.streamSummary = "";
    this.listeners = new Set();
  }

  add({ author = "名無し", text, source = "manual", timestamp = new Date(), emotes = null, bits = null }) {
    // `bits` (issue #177): present on a real cheer's own chat PRIVMSG line — src/trigger-engine.js's
    // handleComment() relies on this surviving normalization here to skip keyword/random dispatch
    // for a cheer, since the SAME cheer also fires through the EventSub/StreamEvent trigger path;
    // dropping it here would silently re-enable a double AI response for every cheer with chat text
    // matching a keyword trigger.
    const comment = { id: `c${++seq}`, author, text: String(text), source, timestamp, emotes, bits };
    this.comments.push(comment);
    if (this.comments.length > this.limit) {
      this.comments.splice(0, this.comments.length - this.limit);
    }
    this.#notify();
    return comment;
  }

  recent(n) {
    return this.comments.slice(-n);
  }

  // 翻訳結果はコメント確定後、非同期に (CommentSpeechPipelineでの翻訳完了時に) 届く。issue #257
  // 要件により元コメント自体は書き換えない (履歴・OBS通知・AIペルソナ入力は原文のまま) ため、
  // 既存フィールドは一切変更せず追加のtranslatedTextフィールドだけを載せる — 表示側 (コメント欄)
  // だけが任意にこれを使う。該当コメントが既にlimitで追い出されていた場合は静かに無視する。
  setTranslation(id, translatedText) {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) return;
    comment.translatedText = translatedText;
    this.#notify();
  }

  all() {
    return [...this.comments];
  }

  get size() {
    return this.comments.length;
  }

  setStreamSummary(text) {
    this.streamSummary = String(text ?? "");
    this.#notify();
  }

  setLimit(limit) {
    this.limit = limit;
    if (this.comments.length > limit) this.comments.splice(0, this.comments.length - limit);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #notify() {
    for (const fn of this.listeners) fn(this);
  }
}
