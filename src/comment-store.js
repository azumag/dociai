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

  add({ author = "名無し", text, source = "manual", timestamp = new Date(), emotes = null }) {
    const comment = { id: `c${++seq}`, author, text: String(text), source, timestamp, emotes };
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
