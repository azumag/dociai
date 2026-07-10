import { IntegrationHealth } from "./integration-health";
import { RequestRegistry } from "./request-registry";
import type { RequestHandle } from "../../shared/services/service-contract";

export class ServiceRuntime {
  readonly registry: RequestRegistry;
  readonly health = new IntegrationHealth();
  #generation = 0;
  constructor(readonly serviceId: string, registry = new RequestRegistry()) { this.registry = registry; }
  get generation(): number { return this.#generation; }
  createRequest(options: { ownerId: string; timeoutMs?: number; requestId?: string } = { ownerId: "app" }): RequestHandle { return this.registry.create({ serviceId: this.serviceId, generation: this.#generation, ...options }); }
  reload(): number { const old = this.#generation; this.#generation += 1; this.registry.cancelGeneration(old); return this.#generation; }
  dispose(): void { this.registry.dispose(); this.health.dispose(); }
}
