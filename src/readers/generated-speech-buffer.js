// A generated item is committed to its source as soon as it is accepted into this buffer.
// That matches the existing readers' successful-delivery transition and prevents the next
// replenish attempt from generating the same news item or Todoist task again.
export class GeneratedSpeechBuffer {
  // onDelivered (optional): fires with an item's `deliveryPayload` once that item reaches the
  // real speech queue (never on drop). Bound by whichever generation currently owns this buffer
  // (see runtime-factory.js) — reassign `buffer.onDelivered` after a config reload rebuilds this
  // buffer with the SAME persisted state.items. That is what lets a buffered item that survives
  // a reload still broadcast onRead / complete its Todoist task through the CURRENT generation's
  // isCurrent()/handlers when it is eventually played, instead of a stale one from generate time.
  constructor({ speechQueue, state = { items: [] }, capacity = 1, log = () => {}, onDelivered = null }) {
    this.speechQueue = speechQueue;
    this.state = state;
    this.capacity = capacity;
    this.log = log;
    this.onDelivered = onDelivered;
    this.state.items ??= [];
  }

  get size() { return this.state.items.length; }
  get full() { return this.size >= this.capacity; }

  enqueue(input) {
    if (this.full) return { state: "dropped" };
    // A caller-supplied onDelivered closure is deliberately dropped here, never stored: it may
    // capture a specific generation's isCurrent()/onRead, and this buffer's state.items can
    // survive a config reload into a NEW generation (see constructor comment). Only the plain
    // deliveryPayload (if any) is kept — play() below fires THIS buffer's own onDelivered, bound
    // fresh by whichever generation currently owns it, instead of replaying a stale closure.
    const { onDelivered: _ignored, ...rest } = input;
    const item = { ...rest, voice: input.voice ? { ...input.voice } : input.voice };
    this.state.items.push(item);
    return { state: "waiting" };
  }

  play() {
    const item = this.state.items.shift();
    if (!item) return null;
    const onDelivered = this.onDelivered ? () => this.onDelivered(item.deliveryPayload) : undefined;
    try {
      // The item was already committed to its source (history/markRead) when it entered this
      // buffer, so a drop here (real-queue deadline/overflow, src/speech/speech-scheduler.js) is
      // otherwise silent and unrecoverable — it will never be spoken and never regenerated. Log
      // it so it is at least visible, even though it isn't retried.
      const result = this.speechQueue?.enqueue({ ...item, onDelivered });
      if (result?.state === "dropped") this.log(`事前生成した読み上げがキュー上限/期限切れで破棄されました: ${item.text ?? ""}`.slice(0, 200), "warn");
    } catch (error) {
      // Unlike a drop, a THROW (e.g. SpeechQueue's strict-ordering/voice-mix validation) means
      // the item never actually reached the real queue — nothing was lost yet, so put it back
      // instead of discarding it. The next play() gets another chance once conditions change.
      this.state.items.unshift(item);
      this.log(`事前生成した読み上げの再生に失敗しました。次回再試行します: ${error.message}`.slice(0, 200), "warn");
      return null;
    }
    return item;
  }
}

// The public reader remains the trigger target. `run()` means Play: consume a prepared item
// or generate one before playing it. Generation always limits the source reader to one item.
export class BufferedReader {
  constructor({ reader, buffer, log = () => {} }) {
    this.reader = reader;
    this.buffer = buffer;
    this.log = log;
  }

  get enabled() { return this.reader.enabled; }
  get busy() { return this.reader.busy; }

  async generate(context = {}) {
    if (this.buffer.full) return { status: "buffer-full" };
    return this.reader.run({ ...context, maxItems: 1 });
  }

  async run(context = {}) {
    if (!this.buffer.size) await this.generate(context);
    const queued = this.buffer.play();
    if (!queued) return null;
    // Awaited (not fire-and-forget): callers such as AutomationCoordinator resolve their
    // busy/onComplete state from this promise, and status()'s read count only reflects a
    // replenish once it lands. A detached (`void`) replenish previously left both stuck
    // mid-flight from the caller's perspective even after the item had actually landed.
    await this.generate(context).catch((error) => this.log(`読み上げ用の次の項目を生成できませんでした: ${error.message}`, "warn"));
    return queued;
  }

  status() { return { ...this.reader.status(), bufferedCount: this.buffer.size }; }
  retryNow(key) { return this.reader.retryNow(key); }
  skip(key) { return this.reader.skip(key); }
  restore(key) { return this.reader.restore(key); }
}
