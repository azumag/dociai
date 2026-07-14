// 音声読み上げキュー。順序・保持はSpeechScheduler、再生resourceは各SpeechBackendが所有する。
import { BackendRegistry } from "./speech/backends/backend-registry.js";
import { SpeechControls } from "./speech/speech-controls.js";
import { SpeechExecution } from "./speech/speech-execution.js";
import { SpeechScheduler } from "./speech/speech-scheduler.js";

export class SpeechQueue {
  constructor({ onUpdate = () => {}, log = () => {}, voicevox = null, bouyomi = null, policy = {}, strictOrdering = false, onHealth = () => {}, webSpeech = {} } = {}) {
    this.scheduler = new SpeechScheduler(policy);
    this.onUpdate = onUpdate;
    this.log = log;
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
    this.controls = new SpeechControls({
      onFirstHold: () => {
        this.scheduler.held = true;
        this.cancelMode = "hold";
        this.#cancelActive();
      },
      onAllReleased: () => {
        this.scheduler.held = false;
        this.#pump();
      },
      onChange: () => this.onUpdate(this.items, this),
    });
    this.remoteClear = { status: "idle", error: null };
  }

  get current() { return this.scheduler.current; }
  get paused() { return this.controls.held; }
  get holdReasons() { return this.controls.snapshot(); }
  get items() { return [...this.scheduler.history.items, ...this.scheduler.pending, ...(this.current ? [this.current] : [])]; }
  snapshot() {
    return Object.freeze({ ...this.scheduler.snapshot(), holdReasons: this.holdReasons, activeExecution: this.activeExecution?.snapshot() ?? null, backendWarnings: Object.freeze([...this.backends.warnings]), remoteClear: Object.freeze({ ...this.remoteClear }) });
  }
  waitingCount() { return this.scheduler.pending.length; }

  enqueue({ personaId, personaName, text, voice = {}, source, priority, deadlineAt, commentId }) {
    const engines = [...this.scheduler.pending, ...(this.current ? [this.current] : [])].map((item) => item.voice?.engine ?? this.#defaultEngine());
    this.backends.validateMix([...engines, voice?.engine ?? this.#defaultEngine()]);
    const item = this.scheduler.enqueue({ personaId, personaName, text, voice, source, priority, deadlineAt, commentId });
    this.#notify(item);
    this.#pump();
    return item;
  }

  hold(reason = "manual") {
    this.controls.hold(reason);
    this.log("読み上げを停止しました (キュー保留)");
  }

  release(reason = "manual") {
    if (!this.controls.release(reason)) return;
    this.log("読み上げを再開しました");
  }

  stop() { this.hold("manual"); }
  resume() { this.release("manual"); }

  skip() {
    if (!this.current) return;
    this.cancelMode = "skipped";
    this.#cancelActive();
  }

  cancelItem(itemId) {
    if (this.current?.id === itemId) { this.cancelMode = "cancelled"; return this.#cancelActive(); }
    const item = this.scheduler.pending.find((entry) => entry.id === itemId);
    if (!item) return false;
    const removed = this.scheduler.removePending(item, "cancelled");
    this.onUpdate(this.items, this);
    return removed;
  }

  clear() {
    return this.clearAll();
  }

  clearPending() {
    for (const item of [...this.scheduler.pending]) this.scheduler.removePending(item, "skipped");
    this.onUpdate(this.items, this);
  }

  clearAll() {
    this.clearPending();
    if (this.current) {
      this.cancelMode = "skipped";
      this.#cancelActive();
    }
    this.remoteClear = { status: "pending", error: null };
    const remote = this.backends.clear().then(
      () => { this.remoteClear = { status: "success", error: null }; this.onUpdate(this.items, this); },
      (error) => { this.remoteClear = { status: "failed", error: error.message }; this.log(`棒読みちゃんのキュー消去に失敗: ${error.message}`); this.onUpdate(this.items, this); },
    );
    this.log("音声キューを全消去しました");
    return remote;
  }

  dispose() {
    this.cancelMode = "cancelled";
    this.#cancelActive();
    this.backends.dispose();
  }

  teardown() {
    for (const item of [...this.scheduler.pending]) this.scheduler.removePending(item, "cancelled");
    this.controls.hold("runtime");
    this.cancelMode = "cancelled";
    this.#cancelActive();
    this.backends.dispose();
    this.onUpdate(this.items, this);
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
    const execution = new SpeechExecution(`speech-${++this.executionSequence}`, item, backend);
    this.activeExecution = execution;
    this.#notify(item);
    backend.play(item, { executionId: execution.id, signal: execution.controller.signal }).then(
      (result) => this.#finish(execution, result),
      (error) => this.#finish(execution, { state: "failed", error: error.message }),
    );
  }

  #finish(execution, result) {
    if (!this.activeExecution?.matches(execution) || this.current !== execution.item || !execution.settle()) return;
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
