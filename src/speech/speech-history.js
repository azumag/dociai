export class SpeechHistory {
  constructor(limit = 50) { this.limit = limit; this.items = []; this.index = new Map(); }
  add(item) {
    this.items.push(item);
    this.index.set(item.id, item);
    while (this.items.length > this.limit) {
      const removed = this.items.shift();
      this.index.delete(removed.id);
    }
  }
  snapshot() { return this.items.map((item) => Object.freeze({ ...item, voice: Object.freeze({ ...item.voice }) })); }
}
