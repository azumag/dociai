import { createHealthEvent } from "./health-events.js";

export class HealthProvider {
  constructor({ id, critical = false, check = null, maxHistory = 32 } = {}) {
    if (!id || typeof id !== "string") throw new TypeError("health provider id is required");
    if (!Number.isSafeInteger(maxHistory) || maxHistory < 1) throw new RangeError("maxHistory must be positive");
    this.id = id;
    this.critical = Boolean(critical);
    this.check = check;
    this.maxHistory = maxHistory;
    this.generation = 0;
    this.history = [];
    this.listeners = new Set();
    this.disposed = false;
  }

  subscribe(listener) {
    if (this.disposed) throw new Error("health provider is disposed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  report(patch = {}) {
    if (this.disposed) return false;
    const event = createHealthEvent({
      ...patch,
      serviceId: this.id,
      critical: patch.critical ?? this.critical,
      generation: patch.generation ?? this.generation,
    });
    this.generation = Math.max(this.generation, event.generation);
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    for (const listener of [...this.listeners]) listener(event);
    return true;
  }

  getHistory() { return [...this.history]; }

  async runCheck(context) {
    if (typeof this.check !== "function") return this.report({ status: "unknown" });
    this.report({ status: "checking" });
    try {
      const result = await this.check(context);
      return this.report(result ?? { status: "ready" });
    } catch (error) {
      this.report({ status: "error", error: { code: error?.code ?? "CHECK_FAILED", message: String(error?.message ?? error) } });
      return false;
    }
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}

export function createHealthProvider(options) { return new HealthProvider(options); }
