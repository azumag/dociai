export class ReconnectPolicy {
  constructor({ baseDelayMs = 1_000, maxDelayMs = 30_000, jitterRatio = 0.2, resetAfterMs = 60_000, random = Math.random } = {}) {
    this.baseDelayMs = Math.max(0, Number(baseDelayMs) || 1_000);
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(maxDelayMs) || 30_000);
    this.jitterRatio = Math.max(0, Math.min(1, Number(jitterRatio) || 0));
    this.resetAfterMs = Math.max(0, Number(resetAfterMs) || 60_000);
    this.random = random;
  }
  delay(attempt) {
    const base = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
    const factor = 1 - this.jitterRatio + (2 * this.jitterRatio * this.random());
    return Math.max(0, Math.round(base * factor));
  }
}
