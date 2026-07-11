export class SpeechControls {
  constructor({ onFirstHold = () => {}, onAllReleased = () => {}, onChange = () => {} } = {}) {
    this.reasons = new Set();
    this.onFirstHold = onFirstHold;
    this.onAllReleased = onAllReleased;
    this.onChange = onChange;
  }
  get held() { return this.reasons.size > 0; }
  hold(reason) {
    const wasHeld = this.held;
    this.reasons.add(String(reason));
    if (!wasHeld) this.onFirstHold(reason);
    this.onChange(this.snapshot());
    return !wasHeld;
  }
  release(reason) {
    if (!this.reasons.delete(String(reason))) return false;
    this.onChange(this.snapshot());
    if (!this.held) this.onAllReleased(reason);
    return true;
  }
  clear() {
    const wasHeld = this.held;
    this.reasons.clear();
    this.onChange(this.snapshot());
    if (wasHeld) this.onAllReleased("clear");
  }
  snapshot() { return Object.freeze([...this.reasons]); }
}
