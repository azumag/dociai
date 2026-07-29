// A generated item is committed to its source as soon as it is accepted into this buffer.
// That matches the existing readers' successful-delivery transition and prevents the next
// replenish attempt from generating the same news item or Todoist task again.
export class GeneratedSpeechBuffer {
  constructor({ speechQueue, state = { items: [] }, capacity = 1, log = () => {} }) {
    this.speechQueue = speechQueue;
    this.state = state;
    this.capacity = capacity;
    this.log = log;
    this.state.items ??= [];
  }

  get size() { return this.state.items.length; }
  get full() { return this.size >= this.capacity; }

  enqueue(input) {
    if (this.full) return { state: "dropped" };
    const item = { ...input, voice: input.voice ? { ...input.voice } : input.voice };
    this.state.items.push(item);
    return { state: "waiting" };
  }

  play() {
    const item = this.state.items.shift();
    if (!item) return null;
    // The item was already committed to its source (history/markRead) when it entered this
    // buffer, so a drop here (real-queue deadline/overflow, src/speech/speech-scheduler.js) is
    // otherwise silent and unrecoverable — it will never be spoken and never regenerated. Log
    // it so it is at least visible, even though it isn't retried.
    const result = this.speechQueue?.enqueue(item);
    if (result?.state === "dropped") this.log(`事前生成した読み上げがキュー上限/期限切れで破棄されました: ${item.text ?? ""}`.slice(0, 200), "warn");
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
