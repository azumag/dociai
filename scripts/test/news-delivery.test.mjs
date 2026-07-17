import assert from "node:assert/strict";
import test from "node:test";

import { buildAttributions, hasUnattributableRequiredSource } from "../../src/news/delivery/news-attribution.js";
import { createNewsSpeechMetadata } from "../../src/news/delivery/news-delivery-contract.js";
import { decideQueueAcceptance } from "../../src/news/delivery/news-queue-policy.js";
import { buildSlotKey, jitterDelayMs, resolveDueSlot } from "../../src/news/delivery/news-schedule-policy.js";
import { createNewsDeliveryStage } from "../../src/news/stages/deliver-stage.js";
import { PipelineStageError } from "../../src/news/contracts.js";

test("buildAttributions prefers research bundle sources and carries license/attributionRequired through", () => {
  const research = { sources: [
    { id: "s1", url: "https://a.example/1", sourceName: "A", author: "Reporter A", license: { name: "CC BY 4.0", url: "https://license.example", attributionRequired: true } },
    { id: "s2", url: "https://b.example/2", sourceName: "B" },
  ] };
  const attributions = buildAttributions(research, { sourceName: "fallback", canonicalUrl: "https://fallback.example" });
  assert.equal(attributions.length, 2);
  assert.deepEqual(attributions[0], { sourceName: "A", url: "https://a.example/1", author: "Reporter A", licenseName: "CC BY 4.0", licenseUrl: "https://license.example", attributionRequired: true });
  assert.equal(attributions[1].attributionRequired, false);
});

test("buildAttributions falls back to the candidate's own source when there is no research bundle", () => {
  const candidate = { sourceName: "Example News", canonicalUrl: "https://example.com/article", license: { name: "All rights reserved", attributionRequired: false } };
  const attributions = buildAttributions(null, candidate);
  assert.equal(attributions.length, 1);
  assert.equal(attributions[0].url, "https://example.com/article");
  assert.equal(attributions[0].licenseName, "All rights reserved");

  assert.deepEqual(buildAttributions(null, {}), []);
  assert.deepEqual(buildAttributions({ sources: [] }, {}), []);
});

test("buildAttributions never leaks the candidate's own license onto unrelated research-bundle sources", () => {
  const research = { sources: [{ id: "s1", url: "https://wikipedia.org/x", sourceName: "Wikipedia" }] };
  const candidate = { sourceName: "CC-licensed feed", license: { name: "CC BY 4.0", attributionRequired: true } };
  const attributions = buildAttributions(research, candidate);
  assert.equal(attributions.length, 1);
  assert.equal(attributions[0].licenseName, null, "a third-party research source must not inherit the candidate feed's own license");
  assert.equal(attributions[0].attributionRequired, false);
});

test("hasUnattributableRequiredSource flags a required source with neither name nor URL", () => {
  assert.equal(hasUnattributableRequiredSource([{ attributionRequired: true, url: null, sourceName: "" }]), true);
  assert.equal(hasUnattributableRequiredSource([{ attributionRequired: true, url: "https://x.example", sourceName: "" }]), false);
  assert.equal(hasUnattributableRequiredSource([{ attributionRequired: false, url: null, sourceName: "" }]), false);
});

test("createNewsSpeechMetadata defaults and copies array fields defensively", () => {
  const sourceIds = ["s1"];
  const attribution = [{ sourceName: "A" }];
  const metadata = createNewsSpeechMetadata({ runId: "r1", candidateId: "c1", mode: "current", title: "T", summary: "S", sourceIds, attribution });
  assert.equal(metadata.source, "news");
  assert.deepEqual(metadata, { source: "news", runId: "r1", candidateId: "c1", mode: "current", title: "T", summary: "S", sourceIds: ["s1"], attribution: [{ sourceName: "A" }] });
  sourceIds.push("s2");
  assert.deepEqual(metadata.sourceIds, ["s1"], "must not alias caller's array");

  const empty = createNewsSpeechMetadata();
  assert.deepEqual(empty, { source: "news", runId: null, candidateId: null, mode: null, title: "", summary: "", sourceIds: [], attribution: [] });
});

test("decideQueueAcceptance rejects a duplicate (mode, candidateId) already pending and enforces congestion defer", () => {
  const pending = [{ metadata: { candidateId: "c1", mode: "current" } }, { metadata: { candidateId: "c2", mode: "topic" } }];
  assert.deepEqual(decideQueueAcceptance({ pendingItems: pending, candidateId: "c1", mode: "current" }), { accept: false, reason: "duplicate-candidate" });
  assert.deepEqual(decideQueueAcceptance({ pendingItems: pending, candidateId: "c1", mode: "topic" }), { accept: true, reason: null }, "same candidate but different mode is not a duplicate");
  assert.deepEqual(decideQueueAcceptance({ pendingItems: pending, candidateId: "c3", mode: "current", deferWhenQueueAbove: 1 }), { accept: false, reason: "queue-congested" });
  assert.deepEqual(decideQueueAcceptance({ pendingItems: pending, candidateId: "c3", mode: "current", deferWhenQueueAbove: 5 }), { accept: true, reason: null });
});

test("news-schedule-policy: resolveDueSlot matches within tolerance, respects daysOfWeek/cooldown/hour limit, and dedupes by fired slot key", () => {
  const monday0905 = new Date(2026, 0, 5, 9, 5); // 2026-01-05 is a Monday
  const slots = [{ id: "morning", minute: 9 * 60, toleranceMinutes: 10 }];

  const due = resolveDueSlot({ slots, now: monday0905 });
  assert.ok(due);
  assert.equal(due.slot.id, "morning");
  assert.equal(due.slotKey, buildSlotKey(slots[0], monday0905));

  const tooLate = new Date(2026, 0, 5, 9, 20);
  assert.equal(resolveDueSlot({ slots, now: tooLate }), null, "outside tolerance window must not catch up");

  const beforeSlot = new Date(2026, 0, 5, 8, 59);
  assert.equal(resolveDueSlot({ slots, now: beforeSlot }), null);

  assert.equal(resolveDueSlot({ slots, now: monday0905, firedSlotKeys: new Set([due.slotKey]) }), null, "already-fired slot key must not refire the same day");

  const weekendOnly = [{ id: "weekend", minute: 9 * 60, daysOfWeek: [0, 6] }];
  assert.equal(resolveDueSlot({ slots: weekendOnly, now: monday0905 }), null);

  assert.equal(resolveDueSlot({ slots, now: monday0905, cooldownMinutes: 30, lastFiredAt: monday0905.getTime() - 5 * 60_000 }), null);
  assert.ok(resolveDueSlot({ slots, now: monday0905, cooldownMinutes: 30, lastFiredAt: monday0905.getTime() - 31 * 60_000 }));

  assert.equal(resolveDueSlot({ slots, now: monday0905, maxRunsPerHour: 2, runsInLastHour: 2 }), null);
});

test("jitterDelayMs is deterministic given an injected rng and zero when jitterSeconds is falsy", () => {
  assert.equal(jitterDelayMs(0), 0);
  assert.equal(jitterDelayMs(10, () => 0.5), 5000);
  assert.equal(jitterDelayMs(10, () => 0), 0);
});

function fakeSpeechQueue({ items = [], paused = false, dropNext = false } = {}) {
  const enqueued = [];
  return {
    paused,
    items,
    enqueue(input) {
      const item = { id: `q${enqueued.length + 1}`, state: dropNext ? "dropped" : "waiting", ...input };
      enqueued.push(item);
      return item;
    },
    enqueued,
  };
}

test("createNewsDeliveryStage accepts, tags metadata, and reflects a mic-hold as status 'held'", async () => {
  const speechQueue = fakeSpeechQueue({ paused: true });
  const stage = createNewsDeliveryStage({ speechQueue });
  const research = { sources: [{ id: "s1", url: "https://a.example", sourceName: "A" }] };
  const item = { processingKey: "p1", title: "見出し", description: "説明" };
  const persona = { id: "persona-1", name: "P", voice: { engine: "voicevox" } };

  const result = await stage.run({ persona, item, text: "本文", research, modePolicy: { mode: "current" }, runId: "run-1" });
  assert.equal(result.status, "held");
  assert.equal(result.commitAllowed, true);
  assert.equal(result.queueItemId, "q1");
  assert.equal(speechQueue.enqueued[0].source, "newstalk");
  assert.equal(speechQueue.enqueued[0].metadata.candidateId, "p1");
  assert.equal(speechQueue.enqueued[0].metadata.mode, "current");
  assert.deepEqual(result.attribution[0].sourceName, "A");
});

test("createNewsDeliveryStage throws a retryable PipelineStageError on queue-limit drop", async () => {
  const speechQueue = fakeSpeechQueue({ dropNext: true });
  const stage = createNewsDeliveryStage({ speechQueue });
  const item = { processingKey: "p1", title: "見出し" };
  const persona = { id: "persona-1", name: "P", voice: {} };
  await assert.rejects(
    stage.run({ persona, item, text: "本文", research: null, modePolicy: { mode: "current" }, runId: "run-1" }),
    (error) => error instanceof PipelineStageError && error.retryable === true,
  );
});

test("createNewsDeliveryStage throws a non-retryable PipelineStageError before enqueueing a duplicate (mode, candidate) already pending", async () => {
  const speechQueue = fakeSpeechQueue({ items: [{ source: "newstalk", state: "waiting", metadata: { candidateId: "p1", mode: "current" } }] });
  const stage = createNewsDeliveryStage({ speechQueue });
  const item = { processingKey: "p1", title: "見出し" };
  const persona = { id: "persona-1", name: "P", voice: {} };
  await assert.rejects(
    stage.run({ persona, item, text: "本文", research: null, modePolicy: { mode: "current" }, runId: "run-1" }),
    (error) => error instanceof PipelineStageError && error.retryable === false,
  );
  assert.equal(speechQueue.enqueued.length, 0);
});

test("createNewsDeliveryStage also treats the currently-speaking item (not just waiting ones) as a duplicate, so a post-cancellation retry doesn't double-read", async () => {
  const speechQueue = fakeSpeechQueue({ items: [{ source: "newstalk", state: "speaking", metadata: { candidateId: "p1", mode: "current" } }] });
  const stage = createNewsDeliveryStage({ speechQueue });
  const item = { processingKey: "p1", title: "見出し" };
  const persona = { id: "persona-1", name: "P", voice: {} };
  await assert.rejects(stage.run({ persona, item, text: "本文", research: null, modePolicy: { mode: "current" }, runId: "run-1" }));
  assert.equal(speechQueue.enqueued.length, 0);
});

test("createNewsDeliveryStage defers when the newstalk queue is above the configured congestion threshold", async () => {
  const items = [
    { source: "newstalk", state: "waiting", metadata: { candidateId: "other-1", mode: "current" } },
    { source: "newstalk", state: "waiting", metadata: { candidateId: "other-2", mode: "current" } },
  ];
  const speechQueue = fakeSpeechQueue({ items });
  const stage = createNewsDeliveryStage({ speechQueue, deferWhenQueueAbove: 1 });
  const item = { processingKey: "p1", title: "見出し" };
  const persona = { id: "persona-1", name: "P", voice: {} };
  await assert.rejects(
    stage.run({ persona, item, text: "本文", research: null, modePolicy: { mode: "current" }, runId: "run-1" }),
    (error) => error instanceof PipelineStageError && error.retryable === true,
  );
  assert.equal(speechQueue.enqueued.length, 0);
});
