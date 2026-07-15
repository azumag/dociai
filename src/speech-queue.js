// 音声読み上げキュー。順序・保持はSpeechScheduler、再生resourceは各SpeechBackendが所有する。
import { BackendRegistry } from "./speech/backends/backend-registry.js";
import { SpeechControls } from "./speech/speech-controls.js";
import { SpeechExecution } from "./speech/speech-execution.js";
import { SpeechScheduler } from "./speech/speech-scheduler.js";

export class SpeechQueue {
  constructor({ onUpdate = () => {}, log = () => {}, voicevox = null, bouyomi = null, policy = {}, strictOrdering = false, onHealth = () => {}, webSpeech = {}, bouyomiCharsPerSecond, resolveVoice = null } = {}) {
    this.scheduler = new SpeechScheduler(policy);
    this.onUpdate = onUpdate;
    this.log = log;
    this.executionSequence = 0;
    this.activeExecution = null;
    this.cancelMode = null;
    this.voicevox = voicevox;
    this.bouyomi = bouyomi;
    this.resolveVoice = resolveVoice;
    this.backends = new BackendRegistry({
      voicevox,
      bouyomi,
      strictOrdering,
      webSpeech,
      onWarning: (message) => this.log(message),
      onHealth,
      bouyomiCharsPerSecond,
    });
    this.controls = new SpeechControls({
      onFirstHold: () => {
        this.scheduler.held = true;
        if (this.activeExecution || this.current) {
          this.cancelMode = "hold";
          this.#cancelActive();
        }
      },
      onAllReleased: () => {
        this.scheduler.held = false;
        this.#pump();
      },
      onChange: () => this.onUpdate(this.items, this),
    });
    this.remoteClear = { status: "idle", error: null };
    this.runtimeTransfer = null;
  }

  get current() { return this.scheduler.current; }
  get paused() { return this.controls.held; }
  get holdReasons() { return this.controls.snapshot(); }
  get items() { return [...this.scheduler.history.items, ...this.scheduler.pending, ...(this.scheduler.resumeNext ? [this.scheduler.resumeNext] : []), ...(this.current ? [this.current] : [])]; }
  snapshot() {
    return Object.freeze({ ...this.scheduler.snapshot(), holdReasons: this.holdReasons, activeExecution: this.activeExecution?.snapshot() ?? null, backendWarnings: Object.freeze([...this.backends.warnings]), remoteClear: Object.freeze({ ...this.remoteClear }) });
  }
  waitingCount() { return this.scheduler.pending.length; }

  // Config reloads replace the runtime bundle, but must not discard speech that the
  // user has already queued. The active item is restored as the first pending item
  // because its backend belongs to the old bundle and cannot continue across reload.
  exportForRuntimeReload() {
    const currentWasExplicitlyCancelled = this.cancelMode === "skipped" || this.cancelMode === "cancelled";
    this.controls.hold("runtime-reload");
    const { current, pending } = this.scheduler.snapshot();
    const keep = (item, isCurrent) => {
      if (!item || (!isCurrent && item.state !== "waiting")) return null;
      const { state: _state, ...rest } = item;
      return isCurrent ? { ...rest, createdAt: Date.now(), deadlineAt: null, runtimeReloadCurrent: true } : rest;
    };
    const transferableCurrent = currentWasExplicitlyCancelled ? null : current;
    const transfer = { items: [keep(transferableCurrent, true), ...pending.map((item) => keep(item, false))].filter(Boolean), holdReasons: this.holdReasons.filter((reason) => !["runtime", "runtime-restore", "runtime-reload", "mic"].includes(reason)) };
    this.runtimeTransfer = transfer;
    return transfer;
  }

  restoreAfterRuntimeReload(transfer = []) {
    const items = Array.isArray(transfer) ? transfer : transfer.items ?? [];
    const holdReasons = Array.isArray(transfer) ? [] : transfer.holdReasons ?? [];
    this.controls.hold("runtime-restore");
    const resolved = items.map((item) => ({ ...item, createdAt: item.runtimeReloadCurrent ? Date.now() : item.createdAt, deadlineAt: item.runtimeReloadCurrent ? null : item.deadlineAt, voice: this.resolveVoice?.(item.personaId, item.voice) ?? item.voice }));
    this.backends.validateMix([...this.scheduler.pending, ...(this.scheduler.resumeNext ? [this.scheduler.resumeNext] : [])].map((item) => item.voice?.engine ?? this.#defaultEngine()).concat(resolved.map((item) => item.voice?.engine ?? this.#defaultEngine())));
    const restored = this.scheduler.restorePending(resolved);
    for (const reason of holdReasons) this.controls.hold(reason);
    this.controls.release("runtime-restore");
    this.runtimeTransfer = null;
    this.onUpdate(this.items, this);
    return restored;
  }

  prepareForRuntimeRestore(transfer = null) { this.runtimeTransfer = transfer; this.controls.hold("runtime-restore"); }

  mergeIntoRuntimeTransfer() {
    if (!this.runtimeTransfer) return 0;
    const known = new Set(this.runtimeTransfer.items.map((item) => item.id));
    const candidates = [this.scheduler.resumeNext, this.current, ...this.scheduler.pending].filter(Boolean);
    let added = 0;
    for (const item of candidates) {
      if (known.has(item.id) || ["skipped", "cancelled", "done", "failed", "dropped", "submitted"].includes(item.state)) continue;
      const { state: _state, ...transferable } = item;
      this.runtimeTransfer.items.push(transferable);
      known.add(item.id);
      added++;
    }
    return added;
  }

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
    this.#removeTransferCurrent();
    if (!this.current) return this.scheduler.removeResumeNext("skipped");
    this.cancelMode = "skipped";
    this.#cancelActive();
  }

  cancelItem(itemId) {
    this.#removeTransferItem(itemId);
    if (this.current?.id === itemId) { this.cancelMode = "cancelled"; return this.#cancelActive(); }
    if (this.scheduler.resumeNext?.id === itemId) {
      const removed = this.scheduler.removeResumeNext("cancelled");
      this.onUpdate(this.items, this);
      return removed;
    }
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
    if (this.runtimeTransfer) this.runtimeTransfer.items = this.runtimeTransfer.items.filter((item) => item.runtimeReloadCurrent);
    for (const item of [...this.scheduler.pending]) this.scheduler.removePending(item, "skipped");
    this.scheduler.removeResumeNext("skipped");
    this.onUpdate(this.items, this);
  }

  clearAll() {
    if (this.runtimeTransfer) { this.runtimeTransfer.items = []; this.runtimeTransfer.holdReasons = []; }
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

  #removeTransferCurrent() {
    if (this.runtimeTransfer) this.runtimeTransfer.items = this.runtimeTransfer.items.filter((item) => !item.runtimeReloadCurrent);
  }

  #removeTransferItem(itemId) {
    if (this.runtimeTransfer) this.runtimeTransfer.items = this.runtimeTransfer.items.filter((item) => item.id !== itemId);
  }

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
