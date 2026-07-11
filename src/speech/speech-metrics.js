export class SpeechMetrics {
  constructor() { this.enqueued = 0; this.started = 0; this.terminal = 0; this.dropped = 0; this.dropReasons = {}; }
  recordDrop(reason) { this.dropped++; this.dropReasons[reason] = (this.dropReasons[reason] ?? 0) + 1; }
  snapshot() { return Object.freeze({ ...this, dropReasons: Object.freeze({ ...this.dropReasons }) }); }
}
