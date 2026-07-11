// 音声読み上げキュー。順序・保持はSpeechScheduler、再生resourceは各SpeechBackendが所有する。
import { BackendRegistry } from "./speech/backends/backend-registry.js";
import { SpeechScheduler } from "./speech/speech-scheduler.js";

export class SpeechQueue {
  constructor({ onUpdate = () => {}, log = () => {}, voicevox = null, bouyomi = null, policy = {}, strictOrdering = false, onHealth = () => {}, webSpeech = {} } = {}) {
    this.scheduler = new SpeechScheduler(policy);
    this.onUpdate = onUpdate;
    this.log = log;
    this.paused = false;
    this.executionSequence = 0;
    this.activeExecution = null;
    this.cancelMode = null;
    this.voicevox = voicevox;
    this.bouyomi = bouyomi;
    this.backends = new BackendRegistry({
      voicevox,
      bouyomi,
      strictOrdering,
      webSpeech,
      onWarning: (message) => this.log(message),
      onHealth,
    });
  }

  get current() { return this.scheduler.current; }
  get items() { return [...this.scheduler.history.items, ...this.scheduler.pending, ...(this.current ? [this.current] : [])]; }
  snapshot() { return this.scheduler.snapshot(); }
  waitingCount() { return this.scheduler.pending.length; }

  enqueue({ personaId, personaName, text, voice = {}, source, priority, deadlineAt }) {
    const engines = [...this.scheduler.pending, ...(this.current ? [this.current] : [])].map((item) => item.voice?.engine ?? this.#defaultEngine());
    this.backends.validateMix([...engines, voice?.engine ?? this.#defaultEngine()]);
    const item = this.scheduler.enqueue({ personaId, personaName, text, voice, source, priority, deadlineAt });
    this.#notify(item);
    this.#pump();
    return item;
  }

  stop() {
    if (this.paused) return;
    this.paused = true;
    this.scheduler.held = true;
    this.cancelMode = "hold";
    this.#cancelActive();
    this.log("読み上げを停止しました (キュー保留)");
    this.onUpdate(this.items, this);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.scheduler.held = false;
    this.log("読み上げを再開しました");
    this.onUpdate(this.items, this);
    this.#pump();
  }

  skip() {
    if (!this.current) return;
    this.cancelMode = "skipped";
    this.#cancelActive();
  }

  clear() {
    for (const item of [...this.scheduler.pending]) this.scheduler.removePending(item, "skipped");
    if (this.current) {
      this.cancelMode = "skipped";
      this.#cancelActive();
    }
    this.backends.clear().catch((error) => this.log(`棒読みちゃんのキュー消去に失敗: ${error.message}`));
    this.log("音声キューを全消去しました");
    this.onUpdate(this.items, this);
  }

  dispose() {
    this.cancelMode = "cancelled";
    this.#cancelActive();
    this.backends.dispose();
  }

  #defaultEngine() { return this.voicevox ? "voicevox" : "webspeech"; }

  #cancelActive() {
    if (!this.activeExecution) return false;
    this.activeExecution.controller.abort();
    this.backends.cancel(this.activeExecution.id);
    return true;
  }

  #pump() {
    if (this.current || this.paused) return;
    const item = this.scheduler.take();
    if (!item) return;
    if (item.voice?.enabled === false) {
      this.scheduler.complete(item, "done", { error: "音声OFFのペルソナのため読み上げなし" });
      this.#notify(item);
      this.#pump();
      return;
    }
    const engine = item.voice?.engine ?? this.#defaultEngine();
    const backend = this.backends.resolve(engine);
    const execution = { id: `speech-${++this.executionSequence}`, controller: new AbortController(), item, backend };
    this.activeExecution = execution;
    this.#notify(item);
    backend.play(item, { executionId: execution.id, signal: execution.controller.signal }).then(
      (result) => this.#finish(execution, result),
      (error) => this.#finish(execution, { state: "failed", error: error.message }),
    );
  }

  #finish(execution, result) {
    if (this.activeExecution !== execution || this.current !== execution.item) return;
    this.activeExecution = null;
    let state = result.state;
    if (this.cancelMode === "hold") {
      this.scheduler.requeueCurrent();
      state = "waiting";
    } else {
      if (this.cancelMode === "skipped") state = "skipped";
      else if (this.cancelMode === "cancelled") state = "cancelled";
      this.scheduler.complete(execution.item, state, { error: result.error });
    }
    this.cancelMode = null;
    if (result.warning) this.log(result.warning);
    this.#notify(execution.item, state);
    setTimeout(() => this.#pump(), 250);
  }

  #notify(item, state = item.state) {
    const label = { waiting: "待機中", speaking: "読み上げ中", done: "完了", submitted: "送信済み", skipped: "スキップ", cancelled: "キャンセル", dropped: "破棄", failed: "失敗" }[state] ?? state;
    this.log(`音声[${item.personaName}] ${label}${item.error ? ` (${item.error})` : ""}: ${item.text.slice(0, 40)}`);
    this.onUpdate(this.items, this);
  }
}
