// 音声読み上げキュー (issue #8)
// Web Speech APIで1件ずつ順番に読み上げ、同時発話を防ぐ。
// 状態: waiting -> speaking -> done | skipped | failed

let seq = 0;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class SpeechQueue {
  constructor({ onUpdate = () => {}, log = () => {} } = {}) {
    this.items = [];
    this.current = null;
    this.paused = false;
    this.cancelling = false;
    this.onUpdate = onUpdate;
    this.log = log;
    this.supported = typeof window !== "undefined" && "speechSynthesis" in window;
    if (this.supported) {
      // Chromeでは初回 getVoices() が空のことがあるため先読みしておく
      speechSynthesis.getVoices();
      speechSynthesis.addEventListener?.("voiceschanged", () => speechSynthesis.getVoices());
    }
  }

  enqueue({ personaId, personaName, text, voice = {} }) {
    const item = {
      id: `s${++seq}`,
      personaId,
      personaName,
      text: String(text),
      voice,
      state: "waiting",
      error: null,
    };
    this.items.push(item);
    if (this.items.length > 50) this.items.splice(0, this.items.length - 50);
    this.#setState(item, "waiting");
    this.#pump();
    return item;
  }

  // 停止: 現在の発話を中断し、キューを保留にする (再開まで次を読まない)
  stop() {
    this.paused = true;
    this.#cancelCurrent();
    this.log("読み上げを停止しました (キュー保留)");
    this.onUpdate(this.items, this);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.log("読み上げを再開しました");
    this.onUpdate(this.items, this);
    this.#pump();
  }

  // スキップ: 現在の発話だけ中断して次へ進む
  skip() {
    if (this.current) this.#cancelCurrent();
  }

  // 全消去: 待機中をすべて破棄し、現在の発話も中断する
  clear() {
    for (const item of this.items) {
      if (item.state === "waiting") this.#setState(item, "skipped");
    }
    this.#cancelCurrent();
    this.log("音声キューを全消去しました");
    this.onUpdate(this.items, this);
  }

  waitingCount() {
    return this.items.filter((i) => i.state === "waiting").length;
  }

  #cancelCurrent() {
    if (this.current && this.supported) {
      this.cancelling = true;
      speechSynthesis.cancel();
    }
  }

  #pump() {
    if (this.current || this.paused) return;
    const item = this.items.find((i) => i.state === "waiting");
    if (!item) return;

    if (!this.supported) {
      item.error = "このブラウザはWeb Speech APIに未対応です";
      this.#setState(item, "failed");
      this.#pump();
      return;
    }
    if (item.voice?.enabled === false) {
      item.error = "音声OFFのペルソナのため読み上げなし";
      this.#setState(item, "done");
      this.#pump();
      return;
    }

    this.current = item;
    this.#setState(item, "speaking");

    const u = new SpeechSynthesisUtterance(item.text);
    u.rate = clamp(item.voice?.rate ?? 1.0, 0.5, 2);
    u.pitch = clamp(item.voice?.pitch ?? 1.0, 0, 2);
    const voice = this.#pickVoice(item.voice?.name);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? "ja-JP";

    u.onend = () => this.#finish(item, "done");
    u.onerror = (e) => {
      if (this.cancelling || e.error === "canceled" || e.error === "interrupted") {
        this.#finish(item, "skipped");
      } else {
        item.error = `読み上げ失敗: ${e.error ?? "不明なエラー"}`;
        this.#finish(item, "failed");
      }
    };
    speechSynthesis.speak(u);
  }

  #finish(item, state) {
    if (this.current !== item) return;
    this.current = null;
    if (this.cancelling && state === "done") state = "skipped";
    this.cancelling = false;
    this.#setState(item, state);
    // Chromeはcancel直後のspeakを取りこぼすことがあるため少し置いて次へ
    setTimeout(() => this.#pump(), 250);
  }

  #pickVoice(name) {
    if (!this.supported) return null;
    const voices = speechSynthesis.getVoices();
    if (name && name !== "default") {
      const hit = voices.find((v) => v.name === name) ?? voices.find((v) => v.name.includes(name));
      if (hit) return hit;
      this.log(`音声 "${name}" が見つからないため日本語デフォルトを使います`);
    }
    return voices.find((v) => v.lang?.startsWith("ja")) ?? null;
  }

  #setState(item, state) {
    item.state = state;
    const label = { waiting: "待機中", speaking: "読み上げ中", done: "完了", skipped: "スキップ", failed: "失敗" }[state];
    this.log(`音声[${item.personaName}] ${label}${item.error ? ` (${item.error})` : ""}: ${item.text.slice(0, 40)}`);
    this.onUpdate(this.items, this);
  }
}
