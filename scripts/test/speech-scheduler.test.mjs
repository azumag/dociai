import assert from "node:assert/strict";
import test from "node:test";
import { SpeechScheduler } from "../../src/speech/speech-scheduler.js";
import { transitionSpeechItem } from "../../src/speech/speech-state-machine.js";

test("scheduler uses stable priority FIFO and never preempts current", () => {
  const scheduler = new SpeechScheduler();
  const low = scheduler.enqueue({ text: "low", priority: 0 });
  assert.equal(scheduler.take(), low);
  const highA = scheduler.enqueue({ text: "high-a", priority: 10 });
  const highB = scheduler.enqueue({ text: "high-b", priority: 10 });
  assert.equal(scheduler.take(), null);
  scheduler.complete(low, "done");
  assert.equal(scheduler.take(), highA);
  scheduler.complete(highA, "done");
  assert.equal(scheduler.take(), highB);
});

test("global and source overflow preserve higher priority items", () => {
  const scheduler = new SpeechScheduler({ maxPending: 3, maxPendingPerSource: 2, overflow: "drop-oldest" });
  const protectedItem = scheduler.enqueue({ text: "event", source: "event", priority: 100 });
  scheduler.enqueue({ text: "chat-1", source: "chat", priority: 0 });
  scheduler.enqueue({ text: "chat-2", source: "chat", priority: 0 });
  const replacement = scheduler.enqueue({ text: "chat-3", source: "chat", priority: 1 });
  const rejected = scheduler.enqueue({ text: "low-event", source: "event", priority: -1 });
  assert.equal(protectedItem.state, "waiting");
  assert.equal(replacement.state, "waiting");
  assert.equal(rejected.state, "dropped");
  assert.ok(rejected.dropReason.includes("priority-protected"));
  assert.equal(scheduler.pending.length, 3);
});

test("overflow policies support drop-new, replace-latest, and aggregate hooks", () => {
  const dropNew = new SpeechScheduler({ maxPending: 1, maxPendingPerSource: 1, overflow: "drop-new" });
  dropNew.enqueue({ text: "first" });
  assert.equal(dropNew.enqueue({ text: "second" }).state, "dropped");

  const replace = new SpeechScheduler({ maxPending: 2, maxPendingPerSource: 2, overflow: "replace-latest" });
  const first = replace.enqueue({ text: "first" });
  const latest = replace.enqueue({ text: "latest" });
  replace.enqueue({ text: "replacement" });
  assert.equal(first.state, "waiting");
  assert.equal(latest.state, "dropped");

  const aggregate = new SpeechScheduler({ maxPending: 1, maxPendingPerSource: 1, overflow: "aggregate", aggregate: (target, incoming) => { target.text += `+${incoming.text}`; return true; } });
  const target = aggregate.enqueue({ text: "one" });
  assert.equal(aggregate.enqueue({ text: "two" }).dropReason, "aggregated");
  assert.equal(target.text, "one+two");
});

test("peekNext looks at the next item without dequeuing it", () => {
  const scheduler = new SpeechScheduler();
  assert.equal(scheduler.peekNext(), null);
  const first = scheduler.enqueue({ text: "first" });
  scheduler.enqueue({ text: "second" });
  assert.equal(scheduler.peekNext(), first);
  assert.equal(scheduler.peekNext(), first, "peeking twice does not consume the item");
  assert.equal(scheduler.pending.length, 2);
  assert.equal(scheduler.take(), first);

  const resumed = new SpeechScheduler();
  resumed.enqueue({ text: "pending" });
  resumed.restorePending([{ text: "resumed", createdAt: 0, runtimeReloadCurrent: true }]);
  assert.equal(resumed.peekNext()?.text, "resumed", "resumeNext takes priority over pending");
});

test("expiry policy handles deadlines, max age, and held queues", () => {
  let now = 1_000;
  const scheduler = new SpeechScheduler({ maxAgeMs: 1_000, expireWhileHeld: false }, { now: () => now });
  scheduler.enqueue({ text: "old" });
  scheduler.held = true;
  now = 3_000;
  assert.equal(scheduler.expire(), 0);
  scheduler.held = false;
  assert.equal(scheduler.expire(), 1);
  assert.equal(scheduler.enqueue({ text: "late", deadlineAt: now }).dropReason, "deadline-expired");
});

test("history trim cannot remove current or pending and snapshots are immutable", () => {
  const scheduler = new SpeechScheduler({ maxHistory: 1, maxPending: 10 });
  const current = scheduler.enqueue({ text: "current" });
  scheduler.take();
  const pending = scheduler.enqueue({ text: "pending" });
  scheduler.complete(current, "done");
  const next = scheduler.take();
  scheduler.complete(next, "failed");
  assert.equal(scheduler.history.items.length, 1);
  const stillPending = scheduler.enqueue({ text: "still-pending" });
  const snapshot = scheduler.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.pending));
  assert.equal(scheduler.pending.includes(stillPending), true);
  assert.notEqual(pending, null);
});

test("invalid transitions fail and a 1000 item burst stays bounded", () => {
  const scheduler = new SpeechScheduler({ maxPending: 25, maxPendingPerSource: 25, maxHistory: 30 });
  const item = scheduler.enqueue({ text: "guard" });
  transitionSpeechItem(item, "done");
  assert.throws(() => transitionSpeechItem(item, "speaking"), /Invalid speech state transition/);
  scheduler.pending.splice(scheduler.pending.indexOf(item), 1);
  for (let index = 0; index < 1000; index++) scheduler.enqueue({ text: String(index), source: "burst", priority: index % 5 });
  assert.ok(scheduler.pending.length <= 25);
  assert.ok(scheduler.history.items.length <= 30);
  assert.ok(scheduler.history.index.size <= 30);
  assert.ok(scheduler.metrics.dropped > 0);
});
