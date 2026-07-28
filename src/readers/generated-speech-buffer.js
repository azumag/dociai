// A generated item is committed to its source as soon as it is accepted into this buffer.
// That matches the existing readers' successful-delivery transition and prevents the next
// replenish attempt from generating the same news item or Todoist task again.
export class GeneratedSpeechBuffer {
  constructor({ speechQueue, state = { items: [] }, capacity = 1 }) {
    this.speechQueue = speechQueue;
    this.state = state;
    this.capacity = capacity;
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
    return item ? this.speechQueue?.enqueue(item) ?? null : null;
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
    // Start replenishment without delaying the just-requested playback. Source state was
    // committed when the generated item entered the buffer, so this cannot duplicate it.
    void this.generate(context).catch((error) => this.log(`読み上げ用の次の項目を生成できませんでした: ${error.message}`, "warn"));
    return queued;
  }

  status() { return { ...this.reader.status(), bufferedCount: this.buffer.size }; }
  retryNow(key) { return this.reader.retryNow(key); }
  skip(key) { return this.reader.skip(key); }
  restore(key) { return this.reader.restore(key); }
}
