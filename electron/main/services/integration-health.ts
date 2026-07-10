import type { HealthEvent, HealthStatus } from "../../shared/services/service-events";
import type { ServiceErrorShape } from "../../shared/services/service-errors";

type HealthSnapshot = { serviceId: string; status: HealthStatus; at: number; latencyMs?: number; error?: ServiceErrorShape };
type Listener = (event: HealthEvent) => void;

export class IntegrationHealth {
  #states = new Map<string, HealthSnapshot>();
  #listeners = new Set<Listener>();
  report(event: HealthEvent): void {
    if (event.type === "changed") this.#states.set(event.serviceId, { serviceId: event.serviceId, status: event.status, at: event.at, latencyMs: event.latencyMs, error: event.error });
    for (const listener of [...this.#listeners]) listener(event);
  }
  subscribe(listener: Listener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  snapshot(): HealthSnapshot[] { return [...this.#states.values()].map((state) => ({ ...state })); }
  dispose(): void { this.#listeners.clear(); this.#states.clear(); }
}
