import { createSpeechItem, TERMINAL_SPEECH_STATES } from "./speech-item.js";
import { transitionSpeechItem } from "./speech-state-machine.js";
import { normalizeSpeechPolicy } from "./speech-policy.js";
import { SpeechHistory } from "./speech-history.js";
import { SpeechMetrics } from "./speech-metrics.js";

export class SpeechScheduler {
  constructor(policy = {}, { now = () => Date.now() } = {}) {
    this.policy = normalizeSpeechPolicy(policy);
    this.now = now;
    this.current = null;
    this.resumeNext = null;
    this.pending = [];
    this.history = new SpeechHistory(this.policy.maxHistory);
    this.metrics = new SpeechMetrics();
    this.held = false;
  }

  enqueue(input) {
    const now = this.now();
    this.expire(now);
    const item = createSpeechItem(input, now);
    if (item.deadlineAt != null && item.deadlineAt <= now) return this.#drop(item, "deadline-expired");
    const sourceItems = () => this.pending.filter((entry) => entry.source === item.source);
    if (sourceItems().length >= this.policy.maxPendingPerSource && !this.#makeRoom(item, sourceItems(), "source-overflow")) return item;
    if (this.pending.length >= this.policy.maxPending && !this.#makeRoom(item, this.pending, "global-overflow")) return item;
    this.pending.push(item);
    this.pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    this.metrics.enqueued++;
    return item;
  }

  take() {
    if (this.current || this.held) return null;
    this.expire();
    const item = this.resumeNext ?? this.pending.shift() ?? null;
    if (!item) return null;
    this.resumeNext = null;
    item.resumeNext = false;
    this.current = item;
    transitionSpeechItem(item, "speaking", { now: this.now() });
    this.metrics.started++;
    return item;
  }

  // 次に take() されるはずのアイテムを、キューから取り除かずに覗き見る。
  // SpeechQueue が「このアイテムを今始めてよいか (例: コメント読み上げの間隔)」を
  // 判断してから実際に take() するために使う。
  peekNext() {
    return this.resumeNext ?? this.pending[0] ?? null;
  }

  complete(item, state, details = {}) {
    if (this.current !== item) return false;
    transitionSpeechItem(item, state, { now: this.now(), ...details });
    this.current = null;
    this.history.add(item);
    this.metrics.terminal++;
    return true;
  }

  removePending(item, state = "skipped", details = {}) {
    const index = this.pending.indexOf(item);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    transitionSpeechItem(item, state, { now: this.now(), ...details });
    this.history.add(item);
    this.metrics.terminal++;
    return true;
  }

  removeResumeNext(state = "skipped", details = {}) {
    const item = this.resumeNext;
    if (!item) return false;
    this.resumeNext = null;
    transitionSpeechItem(item, state, { now: this.now(), ...details });
    this.history.add(item);
    this.metrics.terminal++;
    return true;
  }

  requeueCurrent() {
    if (!this.current) return false;
    const item = this.current;
    transitionSpeechItem(item, "held", { now: this.now() });
    transitionSpeechItem(item, "waiting", { now: this.now() });
    this.current = null;
    this.pending.push(item);
    this.pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    return true;
  }

  restorePending(items) {
    const existing = this.pending;
    this.pending = [];
    const restored = [];
    const current = items.find((item) => item.runtimeReloadCurrent);
    if (current) this.resumeNext = createSpeechItem({ ...current, resumeNext: true }, current.createdAt);
    // Existing user-queued items are never silently discarded just because the
    // new configuration lowers a pending limit. New items added while the new
    // runtime was starting are appended after the transferred queue.
    for (const item of items.filter((item) => !item.runtimeReloadCurrent)) {
      const restoredItem = createSpeechItem(item, item.createdAt);
      this.pending.push(restoredItem);
      restored.push(restoredItem);
    }
    this.pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    for (const item of existing) {
      const candidate = item;
      const sourceCount = this.pending.filter((entry) => entry.source === candidate.source).length;
      if (sourceCount >= this.policy.maxPendingPerSource || this.pending.length >= this.policy.maxPending) {
        this.#drop(candidate, "runtime-restore-overflow");
      } else {
        this.pending.push(candidate);
        this.pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        this.metrics.enqueued++;
        restored.push(candidate);
      }
    }
    return restored.length;
  }

  expire(now = this.now()) {
    if (this.held && !this.policy.expireWhileHeld) return 0;
    let count = 0;
    for (const item of [...this.pending]) {
      if ((item.deadlineAt != null && item.deadlineAt <= now) || now - item.createdAt > this.policy.maxAgeMs) {
        this.pending.splice(this.pending.indexOf(item), 1);
        this.#drop(item, item.deadlineAt != null && item.deadlineAt <= now ? "deadline-expired" : "max-age");
        count++;
      }
    }
    return count;
  }

  snapshot() {
    const clone = (item) => item ? Object.freeze({ ...item, voice: Object.freeze({ ...item.voice }) }) : null;
    return Object.freeze({
      current: clone(this.current ?? this.resumeNext),
      pending: Object.freeze(this.pending.map(clone)),
      history: Object.freeze(this.history.snapshot()),
      metrics: this.metrics.snapshot(),
      oldestPendingAgeMs: this.pending.length ? Math.max(0, this.now() - Math.min(...this.pending.map((item) => item.createdAt))) : 0,
    });
  }

  #makeRoom(incoming, candidates, reason) {
    const removable = [...candidates].sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    if (this.policy.overflow === "drop-new") { this.#drop(incoming, reason); return false; }
    if (this.policy.overflow === "aggregate" && this.policy.aggregate) {
      const target = removable[0];
      if (target && this.policy.aggregate(target, incoming)) { this.#drop(incoming, "aggregated"); return false; }
    }
    const target = this.policy.overflow === "replace-latest"
      ? [...candidates].sort((a, b) => b.sequence - a.sequence)[0]
      : removable[0];
    if (!target || target.priority > incoming.priority) { this.#drop(incoming, `${reason}-priority-protected`); return false; }
    this.pending.splice(this.pending.indexOf(target), 1);
    this.#drop(target, reason);
    return true;
  }

  #drop(item, reason) {
    if (!TERMINAL_SPEECH_STATES.has(item.state)) transitionSpeechItem(item, "dropped", { now: this.now(), dropReason: reason });
    this.history.add(item);
    this.metrics.terminal++;
    this.metrics.recordDrop(reason);
    return item;
  }
}
