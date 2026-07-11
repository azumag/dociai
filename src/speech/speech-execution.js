export class SpeechExecution {
  constructor(id, item, backend) {
    this.id = id;
    this.item = item;
    this.backend = backend;
    this.controller = new AbortController();
    this.settled = false;
    this.startedAt = Date.now();
  }
  matches(candidate) { return !this.settled && candidate === this; }
  abort(reason = "cancelled") { if (!this.controller.signal.aborted) this.controller.abort(reason); }
  settle() { if (this.settled) return false; this.settled = true; return true; }
  snapshot() { return Object.freeze({ id: this.id, itemId: this.item.id, backend: this.backend.id, startedAt: this.startedAt, aborted: this.controller.signal.aborted }); }
}
