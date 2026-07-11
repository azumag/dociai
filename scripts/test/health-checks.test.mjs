import assert from "node:assert/strict";
import test from "node:test";
import { HealthProvider } from "../../src/health/health-provider.js";
import { HealthRegistry } from "../../src/health/health-registry.js";
import { HealthStore } from "../../src/health/health-store.js";
import { HealthCheckRunner } from "../../src/health/health-check-runner.js";
import { HealthNotificationPolicy } from "../../src/health/health-notification-policy.js";
import { isKnownHealthAction, resolveHealthAction } from "../../src/health/health-action-registry.js";

test("health checks coalesce, timeout/cancel, and reject paid checks", async () => {
  const store = new HealthStore(); const registry = new HealthRegistry({ store }); let calls = 0;
  const provider = new HealthProvider({ id: "local", check: async () => { calls += 1; await new Promise((done) => setTimeout(done, 5)); return { status: "ready" }; } });
  registry.register(provider); const runner = new HealthCheckRunner({ registry, timeoutMs: 20 });
  const first = runner.check("local"); assert.strictEqual(first, runner.check("local")); assert.equal((await first).status, "ready"); assert.equal(calls, 1);
  const paid = new HealthProvider({ id: "paid", paid: true, check: async () => ({ status: "ready" }) }); registry.register(paid); assert.deepEqual(await runner.check("paid"), { serviceId: "paid", status: "skipped", reason: "paid-check" });
  const slow = new HealthProvider({ id: "slow", check: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) }); registry.register(slow); assert.equal((await runner.check("slow")).status, "cancelled");
  runner.dispose();
});

test("checkAll limits concurrency, maps safe actions, and emits progress", async () => {
  const store = new HealthStore(); const registry = new HealthRegistry({ store }); let running = 0; let maximum = 0;
  for (const id of ["a", "b", "c", "d"]) registry.register(new HealthProvider({ id, check: async () => { running += 1; maximum = Math.max(maximum, running); await new Promise((r) => setTimeout(r, 5)); running -= 1; return { status: "ready" }; } }));
  const runner = new HealthCheckRunner({ registry, maxConcurrency: 2 }); const progress = []; const results = await runner.checkAll(["a", "b", "c", "d"], { onProgress: (event) => progress.push(event.completed) }); assert.equal(maximum, 2); assert.deepEqual(progress, [1, 2, 3, 4]); assert.ok(results.every((result) => result.status === "ready"));
  assert.equal(resolveHealthAction({ code: "AUTH" }), "reauth"); assert.equal(resolveHealthAction({ code: "NETWORK" }), "retry"); assert.equal(isKnownHealthAction(resolveHealthAction({ code: "UNKNOWN" })), true);
});

test("notification policy dedupes bursts and retains suppressed count", () => {
  let now = 1000; const policy = new HealthNotificationPolicy({ cooldownMs: 100, now: () => now }); const event = { serviceId: "ai", status: "error", error: { code: "NETWORK" } };
  assert.equal(policy.publish(event).emitted, true); now += 10; const suppressed = policy.publish(event); assert.equal(suppressed.emitted, false); assert.equal(suppressed.suppressedCount, 1); now += 100; const next = policy.publish(event); assert.equal(next.emitted, true); assert.equal(next.persistent, true); assert.equal(policy.publish({ serviceId: "ai", status: "ready" }).recovery, true);
});
