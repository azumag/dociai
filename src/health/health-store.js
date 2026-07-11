import { reduceHealth } from "./health-reducer.js";
import { createHealthSnapshot } from "./integration-health.js";
export class HealthStore {
  constructor() { this.snapshot = createHealthSnapshot(); this.listeners = new Set(); }
  report(event) { const next = reduceHealth(this.snapshot, event); if (next === this.snapshot) return false; this.snapshot = next; for (const listener of [...this.listeners]) listener(next, event); return true; }
  getSnapshot() { return this.snapshot; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose() { this.listeners.clear(); }
}
