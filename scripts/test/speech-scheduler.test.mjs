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

test("scheduler can prefer a matching pending item over higher numeric priority", () => {
  const scheduler = new SpeechScheduler();
  const ai = scheduler.enqueue({ text: "AI", priority: 100, source: "ai" });
  const comment = scheduler.enqueue({ text: "comment", priority: 0, source: "comment" });
  const isComment = (item) => item.source === "comment";
  assert.equal(scheduler.peekNext(isComment), comment);
  assert.equal(scheduler.take(isComment), comment);
  scheduler.complete(comment, "done");
  assert.equal(scheduler.take(isComment), ai, "AI resumes when no comment is waiting");
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

test("preserve items survive max-age expiry, overflow, holds, and restore (issue #277)", () => {
  // --- max-age expiry + held queue: 保留中でも通常項目だけが期限切れになる ---
  let now = 1_000;
  const scheduler = new SpeechScheduler({ maxAgeMs: 1_000, maxPending: 10, maxPendingPerSource: 10, expireWhileHeld: true }, { now: () => now });
  const comment = scheduler.enqueue({ text: "comment", preserve: true });
  const plain = scheduler.enqueue({ text: "plain" });
  scheduler.held = true;
  now = 5_000;
  assert.equal(scheduler.expire(), 1);
  assert.equal(plain.state, "dropped");
  assert.equal(comment.state, "waiting");
  assert.equal(scheduler.pending.length, 1);
  assert.equal(scheduler.pending[0], comment);

  // --- overflow: 上限超過でもpreserveは破棄されず、新規の通常項目が代わりに除外される ---
  const over = new SpeechScheduler({ maxPending: 2, maxPendingPerSource: 2, overflow: "drop-oldest" });
  over.enqueue({ text: "c1", preserve: true });
  over.enqueue({ text: "c2", preserve: true });
  const incoming = over.enqueue({ text: "news" });
  assert.equal(incoming.state, "dropped", "全候補がpreserveのときは新規の通常項目が除外される");
  assert.ok(incoming.dropReason.includes("priority-protected"));
  assert.equal(over.pending.length, 2, "preserve項目は上限を超えても保持される");

  // --- runtime-restore-overflowでもpreserveは破棄されない。 ---
  const restored = new SpeechScheduler({ maxPending: 1, maxPendingPerSource: 1 });
  const kept = restored.enqueue({ text: "kept", preserve: true });
  const alsoKept = restored.enqueue({ text: "also-kept" });
  assert.equal(kept.state, "waiting");
  assert.equal(alsoKept.state, "dropped", "preserveが破棄候補になれないため新規の通常項目は除外される");
  const transfer = [...restored.pending];
  const revived = new SpeechScheduler({ maxPending: 1, maxPendingPerSource: 1 });
  const existingPreserve = revived.enqueue({ text: "existing-preserve", preserve: true });
  const existingPlain = revived.enqueue({ text: "existing-plain" });
  revived.restorePending(transfer);
  const revivedKept = revived.pending.find((item) => item.text === "kept");
  assert.ok(revivedKept, "preserve項目は復元時の上限超過でも破棄されない");
  assert.equal(revivedKept.preserve, true, "preserveフラグは復元 (createSpeechItem再構築) をまたいで維持される");
  assert.ok(revived.pending.some((item) => item.text === "existing-preserve"), "既存のpreserve項目も復元時上限超過で破棄されない");
  assert.equal(existingPlain.state, "dropped", "復元時上限超過で破棄されるのは非preserveだけ");
});

test("preserve items are never chosen as overflow victims (issue #277)", () => {
  const scheduler = new SpeechScheduler({ maxPending: 3, maxPendingPerSource: 3, overflow: "drop-oldest" });
  const commentA = scheduler.enqueue({ text: "comment-a", source: "chat", preserve: true });
  const commentB = scheduler.enqueue({ text: "comment-b", source: "chat", preserve: true });
  const chatC = scheduler.enqueue({ text: "chat-c", source: "chat" });
  const incoming = scheduler.enqueue({ text: "chat-d", source: "chat" });
  assert.equal(commentA.state, "waiting");
  assert.equal(commentB.state, "waiting");
  assert.equal(chatC.state, "dropped", "追い出し対象はpreserve以外から選ばれる");
  assert.equal(incoming.state, "waiting");
});

test("preserve items are skipped by the aggregate overflow hook (issue #277)", () => {
  const scheduler = new SpeechScheduler({ maxPending: 1, maxPendingPerSource: 1, overflow: "aggregate", aggregate: (target, incoming) => { target.text += `+${incoming.text}`; return true; } });
  const comment = scheduler.enqueue({ text: "one", preserve: true });
  const incoming = scheduler.enqueue({ text: "two" });
  assert.equal(comment.text, "one", "preserve項目はaggregateの対象にならない");
  assert.equal(incoming.state, "dropped", "追い出し候補が無ければ新規の通常項目が除外される");
  assert.ok(incoming.dropReason.includes("priority-protected"));
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

test("createSpeechItem/scheduler.enqueue carry an optional caller-defined metadata field through unchanged, defaulting to null", () => {
  const scheduler = new SpeechScheduler();
  const metadata = { source: "news", candidateId: "c1" };
  const withMetadata = scheduler.enqueue({ text: "news item", metadata });
  assert.equal(withMetadata.metadata, metadata);

  const withoutMetadata = scheduler.enqueue({ text: "plain item" });
  assert.equal(withoutMetadata.metadata, null);
});
