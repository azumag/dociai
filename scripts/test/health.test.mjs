import assert from "node:assert/strict";
import test from "node:test";
import { HealthStore } from "../../src/health/health-store.js";
import { HealthRegistry } from "../../src/health/health-registry.js";
import { HealthProvider } from "../../src/health/health-provider.js";
import { createHealthEvent, isHealthEvent } from "../../src/health/health-events.js";

test("health store rejects old generations and noncritical disabled services", () => {
  const store = new HealthStore();
  store.report({ serviceId: "ai", status: "ready", generation: 2, critical: true, at: 2 });
  assert.equal(store.report({ serviceId: "ai", status: "error", generation: 1, critical: true, at: 3 }), false);
  store.report({ serviceId: "rss", status: "disabled", generation: 2, critical: false, at: 4 });
  assert.equal(store.getSnapshot().overall, "ready");
});
test("health registry bounds ownership and rejects duplicate providers", () => {
  const store = new HealthStore(); const registry = new HealthRegistry({ store }); let emit;
  const provider = { id: "obs", subscribe: (listener) => { emit = listener; return () => { emit = null; }; } };
  registry.register(provider); assert.throws(() => registry.register(provider), /duplicate/);
  emit({ status: "degraded", generation: 1, critical: false }); assert.equal(store.getSnapshot().services.obs.status, "degraded");
  assert.equal(registry.unregister("obs"), true); assert.equal(emit, null);
});
test("health provider emits validated events and keeps bounded history", async () => {
  const provider = new HealthProvider({ id: "ai", critical: true, maxHistory: 2, check: async () => ({ status: "ready" }) });
  const events = []; provider.subscribe((event) => events.push(event));
  provider.report({ status: "unknown", generation: 1 });
  provider.report({ status: "checking", generation: 1 });
  await provider.runCheck();
  assert.equal(events.at(-1).status, "ready");
  assert.equal(provider.getHistory().length, 2);
  assert.equal(provider.getHistory().at(-1).critical, true);
  provider.dispose();
});
test("health events are self-describing and reject invalid payloads", () => {
  const event = createHealthEvent({ serviceId: "rss", status: "degraded", generation: 3 });
  assert.equal(event.type, "changed");
  assert.equal(isHealthEvent(event), true);
  assert.equal(isHealthEvent({ type: "changed", serviceId: "rss", status: "nope" }), false);
});
