const TERMINAL = new Set(["read", "failed_permanent", "skipped"]);
const RETRYABLE_STATES = new Set(["retry_wait", "failed_permanent"]);
const SKIPPABLE_STATES = new Set(["unread", "retry_wait", "failed_permanent"]);

function copy(record) {
  return record ? {
    ...record,
    lastError: record.lastError ? { ...record.lastError } : null,
  } : null;
}

function emptyCounts() {
  return { unread: 0, processing: 0, read: 0, retry_wait: 0, failed_permanent: 0, skipped: 0 };
}

// 永続化 adapter に差し替えられるよう、reader はこの最小の lifecycle API だけを使う。
export class MemoryItemProcessingStore {
  constructor({ maxEntries = 2000, ttlMs = 24 * 60 * 60 * 1000, clock = () => Date.now() } = {}) {
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 1));
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.records = new Map();
  }

  get(key) {
    return copy(this.records.get(key));
  }

  ensure(item, generation, now = this.clock()) {
    const key = String(item.key ?? item.guid ?? item.link ?? "").slice(0, 256);
    if (!key) throw new Error("reader item key is required");
    const current = this.records.get(key);
    if (current) {
      // reload 後の新 reader が同じ store を共有しても、旧 generation の完了を受け入れない。
      // processing だけは旧 run の途中状態なので、新世代で未読候補へ戻す。
      if (current.generation !== generation) {
        Object.assign(current, {
          generation,
          state: current.state === "processing" ? "unread" : current.state,
          nextRetryAt: current.state === "processing" ? null : current.nextRetryAt,
          updatedAt: now,
        });
      }
      return copy(current);
    }

    this.cleanup(now);
    this.#makeRoom();
    const record = {
      key,
      sourceName: String(item.sourceName ?? "").slice(0, 128),
      title: String(item.title ?? "").slice(0, 300),
      guid: item.guid ? String(item.guid).slice(0, 256) : null,
      state: "unread",
      attempts: 0,
      firstSeenAt: now,
      updatedAt: now,
      generation,
      lastError: null,
      nextRetryAt: null,
    };
    this.records.set(key, record);
    return copy(record);
  }

  begin(key, generation, now = this.clock()) {
    const record = this.records.get(key);
    if (!record || record.generation !== generation || record.state === "processing" || TERMINAL.has(record.state)) return null;
    if (record.state === "retry_wait" && record.nextRetryAt > now) return null;
    record.state = "processing";
    record.attempts++;
    record.lastAttemptAt = now;
    record.updatedAt = now;
    return copy(record);
  }

  markRead(key, generation, now = this.clock()) {
    return this.#transition(key, generation, "read", now, { readAt: now, nextRetryAt: null, lastError: null });
  }

  markFailure(key, generation, error, decision, now = this.clock()) {
    const state = decision.action === "retry" ? "retry_wait" : decision.action === "reset-unread" ? "unread" : "failed_permanent";
    return this.#transition(key, generation, state, now, {
      nextRetryAt: decision.nextRetryAt ?? null,
      lastError: {
        code: decision.reason ?? "unknown",
        message: String(error?.message ?? error ?? "処理に失敗しました").slice(0, 300),
        retryable: decision.action === "retry",
      },
    });
  }

  // cancel/reload の途中状態だけを未読へ戻す。完了済み item を巻き戻さない。
  resetUnread(key, generation, now = this.clock()) {
    return this.#transition(key, generation, "unread", now, { nextRetryAt: null });
  }

  retryNow(key, generation, now = this.clock()) {
    const record = this.records.get(key);
    if (!record || record.generation !== generation || !RETRYABLE_STATES.has(record.state)) return false;
    Object.assign(record, { state: "unread", attempts: 0, nextRetryAt: null, manualRetryAt: now, updatedAt: now });
    return true;
  }

  skip(key, generation, now = this.clock()) {
    const record = this.records.get(key);
    if (!record || record.generation !== generation || !SKIPPABLE_STATES.has(record.state)) return false;
    Object.assign(record, { state: "skipped", skippedAt: now, nextRetryAt: null, updatedAt: now });
    return true;
  }

  restore(key, generation, now = this.clock()) {
    const record = this.records.get(key);
    if (!record || record.generation !== generation || record.state !== "skipped") return false;
    Object.assign(record, { state: "unread", nextRetryAt: null, updatedAt: now });
    return true;
  }

  candidates(generation, now = this.clock()) {
    return [...this.records.values()]
      .filter((record) => record.generation === generation && (record.state === "unread" || (record.state === "retry_wait" && record.nextRetryAt <= now)))
      .map(copy);
  }

  list({ states, limit } = {}) {
    const allowed = states ? new Set(Array.isArray(states) ? states : [states]) : null;
    const records = [...this.records.values()]
      .filter((record) => !allowed || allowed.has(record.state))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(copy);
    return Number.isFinite(limit) ? records.slice(0, Math.max(0, limit)) : records;
  }

  counts() {
    const counts = emptyCounts();
    for (const record of this.records.values()) counts[record.state] = (counts[record.state] ?? 0) + 1;
    return counts;
  }

  cleanup(now = this.clock()) {
    // active/retry item を TTL/LRU で捨てると、障害復旧後の再試行を失う。
    for (const [key, record] of this.records) {
      if (TERMINAL.has(record.state) && record.updatedAt + this.ttlMs <= now) this.records.delete(key);
    }
    this.#trimTerminal();
  }

  clear() {
    this.records.clear();
  }

  #makeRoom() {
    while (this.records.size >= this.maxEntries && this.#trimTerminal(true)) {
      // terminal、次に古い未読 record だけを削除して、新しい item のための枠を空ける。
    }
  }

  #trimTerminal(force = false) {
    if (!force && this.records.size <= this.maxEntries) return false;
    const candidate = [...this.records.values()]
      // processing/retry_wait は失敗復旧のため保持する。容量圧迫時だけ未読の古い item を落とす。
      .filter((record) => TERMINAL.has(record.state) || record.state === "unread")
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!candidate) return false;
    this.records.delete(candidate.key);
    return true;
  }

  #transition(key, generation, state, now, patch) {
    const record = this.records.get(key);
    if (!record || record.generation !== generation || record.state !== "processing") return false;
    Object.assign(record, patch, { state, updatedAt: now });
    return true;
  }
}
