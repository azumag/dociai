import assert from "node:assert/strict";
import test from "node:test";
import { PersonaRouter } from "../../src/persona-router.js";
import { createResponseBudgetKey } from "../../src/personas/response-budget-key.js";
import { ResponseBudgetTracker } from "../../src/personas/response-budget-tracker.js";

test("ResponseBudgetTracker reserves, commits, releases, and enforces the response limit", () => {
  let now = 1_000;
  const tracker = new ResponseBudgetTracker({ ttlMs: 1_000, maxEntries: 4, sweepEveryOperations: 1, clock: () => now });
  const first = tracker.reserve("comment:one", 2);
  const second = tracker.reserve("comment:one", 2);
  assert.ok(first); assert.ok(second); assert.equal(tracker.reserve("comment:one", 2), null);
  assert.equal(tracker.commit(first), true); assert.equal(tracker.release(second), true);
  assert.equal(tracker.count("comment:one"), 1);
  const third = tracker.reserve("comment:one", 2);
  assert.ok(third); tracker.release(third);
  now += 1_001;
  assert.equal(tracker.count("comment:one"), 0);
  assert.equal(tracker.stats().evictedByTtl, 1);
});

test("ResponseBudgetTracker is bounded and never evicts an active reservation", () => {
  let now = 1_000;
  const tracker = new ResponseBudgetTracker({ ttlMs: 100_000, maxEntries: 2, sweepEveryOperations: 10_000, clock: () => now });
  const active = tracker.reserve("comment:active", 2);
  assert.ok(active);
  for (let index = 0; index < 100_000; index++) {
    const reservation = tracker.reserve(`comment:${index}`, 1, ++now);
    assert.ok(reservation);
    tracker.commit(reservation);
  }
  assert.ok(tracker.stats().entries <= 2);
  assert.equal(tracker.stats().reservations, 1);
  assert.ok(tracker.stats().evictedByLimit > 0);
  tracker.release(active);
});

test("ResponseBudgetTracker refuses a new key when every entry is reserved", () => {
  const tracker = new ResponseBudgetTracker({ maxEntries: 1 });
  assert.ok(tracker.reserve("comment:active", 2));
  assert.equal(tracker.reserve("comment:other", 1), null);
  assert.equal(tracker.stats().rejectedReservations, 1);
});

test("response budget keys are namespaced and reject oversized identifiers", () => {
  assert.equal(createResponseBudgetKey("comment", "same"), "comment:same");
  assert.equal(createResponseBudgetKey("stream-event", "same"), "stream-event:same");
  assert.equal(createResponseBudgetKey("comment", "x".repeat(201)), null);
});

test("PersonaRouter keeps per-comment replies bounded and releases selections that never start", () => {
  let now = 10_000;
  const router = new PersonaRouter([
    { id: "a", enabled: true, triggers: ["mention"] },
    { id: "b", enabled: true, triggers: ["mention"] },
  ], { maxRepliesPerComment: 2, cooldownSeconds: 0, historyTtlSeconds: 60, historyMaxEntries: 100 }, { clock: () => now });
  const comment = { id: "comment-1" };
  const first = router.select("mention", { comment });
  assert.equal(first.selected.length, 2);
  assert.equal(router.commitSelection(first.selected[0]), true);
  assert.equal(router.releaseSelection(first.selected[1]), true);
  const second = router.select("mention", { comment });
  assert.equal(second.selected.length, 1);
  assert.equal(router.commitSelection(second.selected[0]), true);
  assert.equal(router.select("mention", { comment }).selected.length, 0);
  assert.equal(router.budgetStats().entries, 1);
  router.dispose();
  assert.equal(router.budgetStats().entries, 0);
  now += 1;
});
