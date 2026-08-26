// 音声読み上げキュー。順序・保持はSpeechScheduler、再生resourceは各SpeechBackendが所有する。
import { BackendRegistry } from "./speech/backends/backend-registry.js";
import { SpeechControls } from "./speech/speech-controls.js";
import { SpeechExecution } from "./speech/speech-execution.js";
import { SpeechScheduler } from "./speech/speech-scheduler.js";

export class SpeechQueue {
  constructor({ onUpdate = () => {}, log = () => {}, voicevox = null, bouyomi = null, policy = {}, strictOrdering = false, onHealth = () => {}, webSpeech = {}, bouyomiCharsPerSecond, resolveVoice = null, resolveFallbackVoice = null, commentReaderIntervalMs = 0, isCommentReaderItem = () => false } = {}) {
    this.scheduler = new SpeechScheduler(policy);
    this.onUpdate = onUpdate;
    this.log = log;
    this.executionSequence = 0;
    this.activeExecution = null;
    this.cancelMode = null;
    this.voicevox = voicevox;
    this.bouyomi = bouyomi;
    this.resolveVoice = resolveVoice;
    this.resolveFallbackVoice = resolveFallbackVoice;
    // コメント読み上げの間隔設定 (issue: コメント読み上げの間隔時間を設定したい)。次の
    // コメント読み上げアイテムをtake()する前に、前回コメントが読み終わってからこの
    // ミリ秒数が経過するまで待つ。AI応答など他ペルソナのアイテムには影響しない。
    this.commentReaderIntervalMs = Math.max(0, Number(commentReaderIntervalMs) || 0);
    this.isCommentReaderItem = isCommentReaderItem;
    this.lastCommentReaderFinishedAt = null;
    this.pumpRetryTimer = null;
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
      // "mic" (マイク発話によるバージイン) は、通常の読み上げ (コメント/AI応答) では
      // 現在の読み上げを止めずに最後まで再生させるが、話題/ニュースの長尺読み上げは
      // すぐに中断してキュー先頭へ戻す (issue: 話題の再生で割り込みが効かない)。いずれも
      // 保留状態そのものは維持するため、#pump() が次のアイテムを勝手に始めることはない
      // (発話が止んで release されるまで次の読み上げは始まらない)。
      // それ以外の理由 (manual/runtime系) は従来通り中断→キュー先頭へ戻し最初から読み直す。
      onFirstHold: (reason) => {
        this.scheduler.held = true;
        if (reason === "mic") {
          const source = this.current?.source ?? this.scheduler.current?.source ?? null;
          // 話題/ニュースは長尺で割り込みの体感が重要なため、マイクでも即時中断する。
          // コメント/AI応答などは従来通り最後まで再生してから次を保留する。
          // newstalk は createNewsDeliveryStage の既定 sourceLabel (runtime-factory では
          // "news" に上書きされるが、テスト/直接利用では既定が残るため両方を対象にする)。
          if (["topics", "news", "newstalk"].includes(source)) {
            this.#interruptCurrentForHold();
          }
          return;
        }
        this.#interruptCurrentForHold();
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

  // onDelivered (optional): fired synchronously once this item has actually reached the real
  // queue (never on drop). Callers such as a news/topic pipeline's onRead broadcast, or
  // GeneratedSpeechBuffer's own per-generation handler (src/readers/generated-speech-buffer.js),
  // rely on this firing at real-queue time.
  enqueue({ personaId, personaName, text, voice = {}, source, priority, deadlineAt, commentId, metadata, preserve, bypassMicHold, onDelivered }) {
    const engines = [...this.scheduler.pending, ...(this.current ? [this.current] : [])].map((item) => item.voice?.engine ?? this.#defaultEngine());
    this.backends.validateMix([...engines, voice?.engine ?? this.#defaultEngine()]);
    const item = this.scheduler.enqueue({ personaId, personaName, text, voice, source, priority, deadlineAt, commentId, metadata, preserve, bypassMicHold });
    // The item is already genuinely enqueued at this point — a throwing onDelivered (e.g. a
    // console/OBS broadcast handler bug) must never stall notify/pump behind it, nor propagate
    // out of enqueue() into a caller (like the news pipeline) that would otherwise treat it as a
    // failed delivery and schedule a duplicate-speaking retry for an item already in the queue.
    if (item.state !== "dropped") {
      try { onDelivered?.(); } catch (error) { this.log(`onDelivered通知の処理に失敗しました: ${error.message}`, "error"); }
    }
    this.#notify(item);
    this.#pump();
    return item;
  }

  hold(reason = "manual") {
    const wasHeld = this.controls.held;
    this.controls.hold(reason);
    // issue #286: マイク保留 (bypass項目が再生中) のあとに手動停止・runtime保留が追加された
    // 場合、onFirstHoldは最初の保留理由でしか呼ばれないため、ここで再生中の項目を中断して
    // キュー先頭へ戻す。mic以外の理由は「割り込み」として扱う (mic同士は従来通り)。
    if (wasHeld && reason !== "mic") {
      this.#interruptCurrentForHold();
    }
    this.log(reason === "mic" ? "マイクの発話を検知しました (次の読み上げを保留)" : "読み上げを停止しました (キュー保留)");
  }

  release(reason = "manual") {
    if (!this.controls.release(reason)) return;
    this.log(reason === "mic" ? "マイクの発話が止みました (読み上げを再開)" : "読み上げを再開しました");
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
    this.#clearPumpRetry();
    this.#pump();
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
    this.#clearPumpRetry();
    this.cancelMode = "cancelled";
    this.#cancelActive();
    this.backends.dispose();
  }

  teardown() {
    this.#clearPumpRetry();
    for (const item of [...this.scheduler.pending]) this.scheduler.removePending(item, "cancelled");
    this.controls.hold("runtime");
    this.cancelMode = "cancelled";
    this.#cancelActive();
    this.backends.dispose();
    this.onUpdate(this.items, this);
  }

  #defaultEngine() { return this.voicevox ? "voicevox" : "webspeech"; }

  #commentReaderWaitMs(item) {
    if (!this.commentReaderIntervalMs || this.lastCommentReaderFinishedAt == null || !this.isCommentReaderItem(item)) return 0;
    // 同じコメントの原文→翻訳という一続きの2件 (issue #257, outputMode: originalThenTranslated)
    // には、他コメントとの間隔と同じ待ち時間を挟まない。挟むと「原文 → intervalSeconds秒の
    // 無音 → 同じコメントの翻訳」になってしまう (PRレビュー指摘)。
    if (item.metadata?.skipCommentReaderInterval) return 0;
    return Math.max(0, this.commentReaderIntervalMs - (Date.now() - this.lastCommentReaderFinishedAt));
  }

  #scheduleRetry(waitMs) {
    if (this.pumpRetryTimer) return;
    this.pumpRetryTimer = setTimeout(() => { this.pumpRetryTimer = null; this.#pump(); }, waitMs);
  }

  #clearPumpRetry() {
    if (!this.pumpRetryTimer) return;
    clearTimeout(this.pumpRetryTimer);
    this.pumpRetryTimer = null;
  }

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

  // topics/news のマイク割り込みや manual 追加時の割り込みで使う。
  // activeExecution があれば通常の cancel 経路 (#finish で requeue)、
  // まだ execution が立つ前の race window (scheduler.current はあるが
  // activeExecution が null) では直接 requeue して即時中断する (H2)。
  #interruptCurrentForHold() {
    if (this.activeExecution) {
      this.cancelMode = "hold";
      this.#cancelActive();
      return true;
    }
    if (this.current) {
      const item = this.current;
      this.scheduler.requeueCurrent();
      this.#notify(item, "waiting");
      return true;
    }
    return false;
  }

  #pump() {
    if (this.current) return;
    // issue #286: 保留理由が"mic"だけのときは、bypassMicHold付き項目 (ごく短いコメント・
    // エモートのみコメント) だけ保留を無視して開始できる。手動停止やruntime保留は
    // 従来通りすべての項目を止める。
    const reasons = this.holdReasons;
    const micOnlyHold = this.paused && reasons.length === 1 && reasons[0] === "mic";
    if (this.paused && !micOnlyHold) return;
    const preferComment = (item) => this.isCommentReaderItem(item);
    const next = this.scheduler.peekNext(preferComment, { allowBypassMicHold: micOnlyHold });
    if (!next) return;
    if (micOnlyHold && !next.bypassMicHold) return;
    const waitMs = this.#commentReaderWaitMs(next);
    if (waitMs > 0) { this.#scheduleRetry(waitMs); return; }
    const item = this.scheduler.take(preferComment, { allowBypassMicHold: micOnlyHold });
    if (!item) return;
    if (item.voice?.enabled === false) {
      this.scheduler.complete(item, "done", { error: "音声OFFのペルソナのため読み上げなし" });
      this.#notify(item);
      this.#pump();
      return;
    }
    const engine = item.voice?.engine ?? this.#defaultEngine();
    const backend = this.backends.resolve(engine);
    const playbackItem = backend.id !== engine && this.resolveFallbackVoice
      ? { ...item, voice: this.resolveFallbackVoice(item.personaId, item.voice, backend.id) ?? item.voice }
      : item;
    const execution = new SpeechExecution(`speech-${++this.executionSequence}`, item, backend);
    this.activeExecution = execution;
    this.#notify(item);
    backend.play(playbackItem, { executionId: execution.id, signal: execution.controller.signal }).then(
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
      // "hold" (マイク以外の理由で中断→キュー先頭へ戻す) はまだ読み終わっていないため、
      // 間隔のカウントには含めない。
      if (this.isCommentReaderItem(execution.item)) this.lastCommentReaderFinishedAt = Date.now();
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
