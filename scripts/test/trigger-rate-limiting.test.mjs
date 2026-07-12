// Issue #92: coverage for cooldown/rate-limit/aggregation/global-budget flood protection built on
// top of #91's matcher output, under src/triggers/{cooldown-key,cooldown-tracker}.js and
// src/actions/{action-rate-limiter,event-aggregator,global-action-budget}.js. Follows this repo's
// plain `.mjs` `node --test` convention for pure-JS src/ modules (see
// scripts/test/event-trigger-matcher.test.mjs, scripts/test/response-budget.test.mjs) and its
// established "manual fake clock, never sleep real wall-clock time" idiom for anything timer-based
// (see scripts/test/twitch-chat.test.mjs's own `clock`/`timers` fixture, mirrored below for
// EventAggregator's real setTimeout/clearTimeout usage).
import assert from "node:assert/strict";
import test from "node:test";

import { CURRENT_SCHEMA_VERSION } from "../../src/stream-events/contract.js";
import { TriggerTraceBuffer } from "../../src/triggers/trigger-trace.js";

import { COOLDOWN_KEY_DIMENSIONS, buildCooldownKey, isValidCooldownKeyBy } from "../../src/triggers/cooldown-key.js";
import { COOLDOWN_CONSUME_POINTS, CooldownTracker } from "../../src/triggers/cooldown-tracker.js";
import { ActionRateLimiter, OVERFLOW_POLICIES } from "../../src/actions/action-rate-limiter.js";
import { EventAggregator, summarizeAggregatedEvents } from "../../src/actions/event-aggregator.js";
import { GlobalActionBudget } from "../../src/actions/global-action-budget.js";

// ---------------------------------------------------------------------------------------------
// Fixtures — real StreamEvent shapes, matching event-trigger-matcher.test.mjs's own convention.
// ---------------------------------------------------------------------------------------------

function baseEvent(kind, data, overrides = {}) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: overrides.id ?? `evt-${kind}-${Math.random().toString(36).slice(2)}`,
    kind,
    timestamp: overrides.timestamp ?? "2026-07-12T10:00:00.000Z",
    actor: overrides.actor ?? { id: "user-1", displayName: "Alice", isAnonymous: false },
    channel: { id: "channel-1", displayName: "AliceChannel" },
    sourceMetadata: { connectionId: "conn-1" },
    data,
    ...overrides,
  };
}

const anonymousActor = { id: null, displayName: "Anonymous", isAnonymous: true };

/** Manual fake Clock for EventAggregator (real setTimeout/clearTimeout usage) — mirrors
 * scripts/test/twitch-chat.test.mjs's own `clock`/`timers` fixture. `advance(ms)` fires every timer
 * whose deadline has been reached, in deadline order. `calls` independently records EVERY
 * setTimeout invocation (even ones later cleared) so a test can grab a raw callback reference and
 * invoke it directly — the only way to genuinely exercise the "callback already escaped the timer
 * queue when cancel() ran" race described in event-aggregator.js's own header comment. */
function createFakeClock(startAt = 0) {
  let now = startAt;
  let seq = 0;
  const timers = new Map();
  const calls = [];
  return {
    clock: {
      now: () => now,
      setTimeout(callback, ms) {
        const id = ++seq;
        timers.set(id, { callback, deadline: now + ms });
        calls.push({ id, callback, ms });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, t]) => t.deadline <= now).sort((a, b) => a[1].deadline - b[1].deadline);
      for (const [id, t] of due) {
        timers.delete(id);
        t.callback();
      }
    },
    setNow(value) {
      now = value;
    },
    get now() {
      return now;
    },
    calls,
    pendingTimerCount: () => timers.size,
  };
}

// ---------------------------------------------------------------------------------------------
// cooldown-key.js
// ---------------------------------------------------------------------------------------------

test("buildCooldownKey: base trigger scope, no narrowing", () => {
  const event = baseEvent("cheer", { bits: 100 });
  const result = buildCooldownKey({ triggerId: "trig-1", keyBy: [], event });
  assert.equal(result.key, "trigger:trig-1");
  assert.equal(result.exempt, false);
});

test("buildCooldownKey: each dimension narrows independently and combines in a fixed canonical order regardless of input array order", () => {
  const event = baseEvent("reward-redemption", { rewardId: "reward-9", rewardTitle: "T", cost: 100 }, { actor: { id: "user-42", displayName: "Bob", isAnonymous: false } });
  const a = buildCooldownKey({ triggerId: "trig-1", keyBy: ["actor", "reward", "eventType"], event });
  const b = buildCooldownKey({ triggerId: "trig-1", keyBy: ["eventType", "actor", "reward"], event });
  assert.equal(a.key, b.key);
  assert.equal(a.key, "trigger:trig-1|eventType:reward-redemption|reward:reward-9|actor:user-42");
});

test("buildCooldownKey: unknown keyBy entries are ignored", () => {
  const event = baseEvent("cheer", { bits: 1 });
  const result = buildCooldownKey({ triggerId: "trig-1", keyBy: ["actor", "bogus", "not-a-real-dimension"], event });
  assert.equal(result.key, "trigger:trig-1|actor:user-1");
});

test("buildCooldownKey: missing triggerId yields a null key with an explicit reason", () => {
  const result = buildCooldownKey({ triggerId: null, keyBy: [], event: baseEvent("cheer", { bits: 1 }) });
  assert.equal(result.key, null);
  assert.equal(result.exempt, false);
  assert.equal(result.reason, "missing-trigger-id");
});

test("buildCooldownKey: two different named actors get distinct actor-scoped keys", () => {
  const eventA = baseEvent("cheer", { bits: 1 }, { actor: { id: "user-a", displayName: "A", isAnonymous: false } });
  const eventB = baseEvent("cheer", { bits: 1 }, { actor: { id: "user-b", displayName: "B", isAnonymous: false } });
  const keyA = buildCooldownKey({ triggerId: "trig-1", keyBy: ["actor"], event: eventA }).key;
  const keyB = buildCooldownKey({ triggerId: "trig-1", keyBy: ["actor"], event: eventB }).key;
  assert.notEqual(keyA, keyB);
});

test("buildCooldownKey: anonymous actor bucket policy — actor-scoped cooldown is fully EXEMPT (not a shared 'anonymous' bucket) for an anonymous event", () => {
  const eventAnon1 = baseEvent("cheer", { bits: 1 }, { actor: anonymousActor, id: "evt-anon-1" });
  const eventAnon2 = baseEvent("cheer", { bits: 1 }, { actor: anonymousActor, id: "evt-anon-2" });
  const resultAnon1 = buildCooldownKey({ triggerId: "trig-1", keyBy: ["actor"], event: eventAnon1 });
  const resultAnon2 = buildCooldownKey({ triggerId: "trig-1", keyBy: ["actor"], event: eventAnon2 });
  assert.equal(resultAnon1.key, null);
  assert.equal(resultAnon1.exempt, true);
  assert.equal(resultAnon1.reason, "anonymous-actor-exempt");
  assert.equal(resultAnon2.exempt, true);
});

test("buildCooldownKey: a non-actor dimension still applies normally to an anonymous event", () => {
  const event = baseEvent("reward-redemption", { rewardId: "reward-5", rewardTitle: "T", cost: 1 }, { actor: anonymousActor });
  const result = buildCooldownKey({ triggerId: "trig-1", keyBy: ["reward"], event });
  assert.equal(result.exempt, false);
  assert.equal(result.key, "trigger:trig-1|reward:reward-5");
});

test("isValidCooldownKeyBy validates against the fixed dimension allow-list", () => {
  assert.equal(isValidCooldownKeyBy(["actor", "reward"]), true);
  assert.equal(isValidCooldownKeyBy(["actor", "nope"]), false);
  assert.equal(isValidCooldownKeyBy(COOLDOWN_KEY_DIMENSIONS), true);
});

// ---------------------------------------------------------------------------------------------
// cooldown-tracker.js
// ---------------------------------------------------------------------------------------------

test("CooldownTracker: consumeOn 'scheduled' consumes immediately and blocks a second schedule() until cooldownMs elapses", () => {
  let now = 0;
  const tracker = new CooldownTracker({ clock: () => now });
  const first = tracker.schedule("k1", { cooldownMs: 1_000, consumeOn: "scheduled" }, now);
  assert.equal(first.allowed, true);
  assert.equal(first.reservation, null);
  assert.ok(first.consumedAt !== null);

  now += 500;
  const second = tracker.schedule("k1", { cooldownMs: 1_000, consumeOn: "scheduled" }, now);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "cooldown-active");

  now = 1_000;
  const third = tracker.schedule("k1", { cooldownMs: 1_000, consumeOn: "scheduled" }, now);
  assert.equal(third.allowed, true);
});

test("CooldownTracker: consumeOn 'started' reserves at schedule time (blocking concurrent duplicates) but only starts the cooldown clock at markStarted()", () => {
  let now = 0;
  const tracker = new CooldownTracker({ clock: () => now });
  const gate = tracker.schedule("k1", { cooldownMs: 1_000, consumeOn: "started" }, now);
  assert.equal(gate.allowed, true);
  assert.ok(gate.reservation);
  assert.equal(gate.consumedAt, null);

  // A second concurrent schedule() for the same key is blocked while the first is still pending.
  const duplicate = tracker.schedule("k1", { cooldownMs: 1_000, consumeOn: "started" }, now);
  assert.equal(duplicate.allowed, false);

  now = 500;
  assert.equal(tracker.markStarted(gate, now), true);
  assert.equal(gate.consumedAt, 500);
  assert.equal(gate.reservation, null);

  // cooldown window is measured from the START time (500), not the schedule time (0).
  now = 1_499;
  assert.equal(tracker.schedule("k1", { cooldownMs: 1_000, consumeOn: "started" }, now).allowed, false);
  now = 1_500;
  assert.equal(tracker.schedule("k1", { cooldownMs: 1_000, consumeOn: "started" }, now).allowed, true);
});

test("CooldownTracker: consumeOn 'completed' — cancel() before completion releases the reservation without consuming any cooldown", () => {
  let now = 0;
  const tracker = new CooldownTracker({ clock: () => now });
  const gate = tracker.schedule("k1", { cooldownMs: 5_000, consumeOn: "completed" }, now);
  assert.equal(gate.allowed, true);
  assert.ok(gate.reservation);

  // markStarted must be a no-op for a 'completed' gate — nothing is consumed yet.
  assert.equal(tracker.markStarted(gate, now), false);
  assert.ok(gate.reservation);

  tracker.cancel(gate);
  assert.equal(gate.reservation, null);

  // Cooldown was never consumed — an immediate re-schedule at the SAME instant succeeds.
  const again = tracker.schedule("k1", { cooldownMs: 5_000, consumeOn: "completed" }, now);
  assert.equal(again.allowed, true);
  assert.ok(tracker.markCompleted(again, now));
  assert.equal(tracker.schedule("k1", { cooldownMs: 5_000, consumeOn: "completed" }, now).allowed, false);
});

test("CooldownTracker: COOLDOWN_CONSUME_POINTS lists exactly the three configurable lifecycle stages", () => {
  assert.deepEqual([...COOLDOWN_CONSUME_POINTS], ["scheduled", "started", "completed"]);
});

test("CooldownTracker: two different actors get independent cooldowns under an actor-scoped key", () => {
  let now = 0;
  const tracker = new CooldownTracker({ clock: () => now });
  const gateA1 = tracker.schedule("trigger:t|actor:a", { cooldownMs: 1_000, consumeOn: "scheduled" }, now);
  const gateB1 = tracker.schedule("trigger:t|actor:b", { cooldownMs: 1_000, consumeOn: "scheduled" }, now);
  assert.equal(gateA1.allowed, true);
  assert.equal(gateB1.allowed, true);
  const gateA2 = tracker.schedule("trigger:t|actor:a", { cooldownMs: 1_000, consumeOn: "scheduled" }, now);
  assert.equal(gateA2.allowed, false); // A is on cooldown...
  const gateB2 = tracker.schedule("trigger:t|actor:b", { cooldownMs: 1_000, consumeOn: "scheduled" }, now);
  assert.equal(gateB2.allowed, false); // ...independently, B is ALSO on its own cooldown, not because of A
});

test("CooldownTracker: a null key (cooldown-key.js's anonymous-exempt result) is always allowed and never tracked", () => {
  let now = 0;
  const tracker = new CooldownTracker({ clock: () => now });
  for (let i = 0; i < 5; i++) {
    const gate = tracker.schedule(null, { cooldownMs: 1_000, consumeOn: "scheduled" }, now);
    assert.equal(gate.allowed, true);
    assert.equal(gate.reason, "exempt");
  }
  assert.equal(tracker.stats().entries, 0);
});

test("CooldownTracker: bypassCooldown (simulation) always allows and never touches real cooldown state", () => {
  let now = 0;
  const tracker = new CooldownTracker({ clock: () => now });
  tracker.schedule("k1", { cooldownMs: 10_000, consumeOn: "scheduled" }, now); // consumes real cooldown
  assert.equal(tracker.schedule("k1", { cooldownMs: 10_000, consumeOn: "scheduled" }, now).allowed, false);

  const bypassed = tracker.schedule("k1", { cooldownMs: 10_000, consumeOn: "scheduled", bypassCooldown: true }, now);
  assert.equal(bypassed.allowed, true);
  assert.equal(bypassed.reason, "bypassed-simulation");

  // The real (non-bypassed) cooldown is still active — bypass did not reset or consume it.
  assert.equal(tracker.schedule("k1", { cooldownMs: 10_000, consumeOn: "scheduled" }, now).allowed, false);
});

test("CooldownTracker: distinct cooldownMs values share one tracker instance via independent duration buckets", () => {
  let now = 0;
  const tracker = new CooldownTracker({ clock: () => now });
  tracker.schedule("k-fast", { cooldownMs: 100, consumeOn: "scheduled" }, now);
  tracker.schedule("k-slow", { cooldownMs: 10_000, consumeOn: "scheduled" }, now);
  assert.equal(tracker.stats().durationBuckets, 2);

  now = 100;
  assert.equal(tracker.schedule("k-fast", { cooldownMs: 100, consumeOn: "scheduled" }, now).allowed, true);
  assert.equal(tracker.schedule("k-slow", { cooldownMs: 10_000, consumeOn: "scheduled" }, now).allowed, false);
});

test("CooldownTracker: exceeding maxDurationBuckets fails OPEN (allowed) with an explicit reason rather than blocking forever", () => {
  let now = 0;
  const tracker = new CooldownTracker({ clock: () => now, maxDurationBuckets: 1 });
  tracker.schedule("k1", { cooldownMs: 100, consumeOn: "scheduled" }, now);
  const overflow = tracker.schedule("k2", { cooldownMs: 200, consumeOn: "scheduled" }, now);
  assert.equal(overflow.allowed, true);
  assert.equal(overflow.reason, "duration-bucket-limit-exceeded");
  assert.equal(tracker.stats().durationBucketOverflows, 1);
});

test("CooldownTracker: bounded TTL/LRU per duration bucket — many distinct keys never grow the tracker past maxEntriesPerDuration", () => {
  let now = 0;
  const tracker = new CooldownTracker({ clock: () => now, maxEntriesPerDuration: 5 });
  for (let i = 0; i < 500; i++) {
    now += 1;
    tracker.schedule(`k-${i}`, { cooldownMs: 100_000, consumeOn: "scheduled" }, now);
  }
  assert.ok(tracker.stats().entries <= 5);
});

test("CooldownTracker.clear() resets all duration buckets", () => {
  let now = 0;
  const tracker = new CooldownTracker({ clock: () => now });
  tracker.schedule("k1", { cooldownMs: 1_000, consumeOn: "scheduled" }, now);
  assert.equal(tracker.schedule("k1", { cooldownMs: 1_000, consumeOn: "scheduled" }, now).allowed, false);
  tracker.clear();
  assert.equal(tracker.stats().durationBuckets, 0);
  const fresh = new CooldownTracker({ clock: () => now });
  assert.equal(fresh.schedule("k1", { cooldownMs: 1_000, consumeOn: "scheduled" }, now).allowed, true);
});

// ---------------------------------------------------------------------------------------------
// action-rate-limiter.js
// ---------------------------------------------------------------------------------------------

test("ActionRateLimiter: allows exactly maxActions within the window, then rejects the boundary-exceeding one", () => {
  let now = 0;
  const limiter = new ActionRateLimiter({ clock: () => now });
  for (let i = 0; i < 3; i++) {
    const result = limiter.attempt("k1", { windowMs: 1_000, maxActions: 3 }, now);
    assert.equal(result.allowed, true, `attempt ${i} should be allowed`);
    now += 1;
  }
  const overflow = limiter.attempt("k1", { windowMs: 1_000, maxActions: 3 }, now);
  assert.equal(overflow.allowed, false);
  assert.equal(overflow.reason, "rate-limit-exceeded");
});

test("ActionRateLimiter: the sliding window recovers once old entries age out", () => {
  let now = 0;
  const limiter = new ActionRateLimiter({ clock: () => now });
  limiter.attempt("k1", { windowMs: 1_000, maxActions: 1 }, now);
  assert.equal(limiter.attempt("k1", { windowMs: 1_000, maxActions: 1 }, now).allowed, false);
  now = 1_001;
  assert.equal(limiter.attempt("k1", { windowMs: 1_000, maxActions: 1 }, now).allowed, true);
});

for (const policy of OVERFLOW_POLICIES) {
  test(`ActionRateLimiter: overflow policy '${policy}' is reported verbatim as the decision once the window is exhausted`, () => {
    let now = 0;
    const limiter = new ActionRateLimiter({ clock: () => now });
    limiter.attempt("k1", { windowMs: 1_000, maxActions: 1, overflowPolicy: policy }, now);
    const result = limiter.attempt("k1", { windowMs: 1_000, maxActions: 1, overflowPolicy: policy }, now);
    assert.equal(result.allowed, false);
    assert.equal(result.decision, policy);
  });
}

test("ActionRateLimiter: priorityExempt always allows regardless of window state", () => {
  let now = 0;
  const limiter = new ActionRateLimiter({ clock: () => now });
  limiter.attempt("k1", { windowMs: 1_000, maxActions: 1 }, now);
  const exempt = limiter.attempt("k1", { windowMs: 1_000, maxActions: 1, priorityExempt: true }, now);
  assert.equal(exempt.allowed, true);
});

test("ActionRateLimiter: peek() never mutates state", () => {
  let now = 0;
  const limiter = new ActionRateLimiter({ clock: () => now });
  assert.equal(limiter.peek("k1", { windowMs: 1_000 }, now), 0);
  limiter.attempt("k1", { windowMs: 1_000, maxActions: 5 }, now);
  assert.equal(limiter.peek("k1", { windowMs: 1_000 }, now), 1);
  assert.equal(limiter.peek("k1", { windowMs: 1_000 }, now), 1); // still 1, peek did not add an entry
});

test("ActionRateLimiter: bounded by maxKeys — a burst of many distinct keys never grows past the configured bound", () => {
  let now = 0;
  const limiter = new ActionRateLimiter({ clock: () => now, maxKeys: 10 });
  for (let i = 0; i < 500; i++) {
    now += 1;
    limiter.attempt(`k-${i}`, { windowMs: 100_000, maxActions: 5 }, now);
  }
  assert.ok(limiter.stats().keys <= 10);
});

// ---------------------------------------------------------------------------------------------
// event-aggregator.js
// ---------------------------------------------------------------------------------------------

test("summarizeAggregatedEvents: totals bits/gift counts/reward redemptions and counts anonymous events as distinct actors", () => {
  const events = [
    baseEvent("cheer", { bits: 100 }, { actor: { id: "u1", displayName: "A", isAnonymous: false } }),
    baseEvent("cheer", { bits: 50 }, { actor: anonymousActor }),
    baseEvent("cheer", { bits: 25 }, { actor: anonymousActor }),
    baseEvent("gift-subscription", { tier: "1000", count: 5 }, { actor: { id: "u2", displayName: "B", isAnonymous: false } }),
    baseEvent("reward-redemption", { rewardId: "r1", rewardTitle: "T", cost: 10 }, { actor: { id: "u1", displayName: "A", isAnonymous: false } }),
  ];
  const summary = summarizeAggregatedEvents("trigger:x", events);
  assert.equal(summary.count, 5);
  assert.equal(summary.totalBits, 175);
  assert.equal(summary.totalGiftCount, 5);
  assert.equal(summary.rewardRedemptionCount, 1);
  // u1 (2 events), u2 (1 event), and 2 SEPARATE anonymous events => 4 unique actors, not 3.
  assert.equal(summary.uniqueActors, 4);
});

test("EventAggregator: flushes on the window timer with a correct summary, without any real sleep", () => {
  const { clock, advance } = createFakeClock(0);
  const flushes = [];
  const aggregator = new EventAggregator({ windowMs: 1_000, maxBatchSize: 100, onFlush: (summary, ctx) => flushes.push({ summary, ctx }), clock });
  aggregator.add("k1", baseEvent("cheer", { bits: 10 }), clock.now());
  aggregator.add("k1", baseEvent("cheer", { bits: 20 }), clock.now());
  assert.equal(flushes.length, 0);
  advance(999);
  assert.equal(flushes.length, 0);
  advance(1);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].summary.count, 2);
  assert.equal(flushes[0].summary.totalBits, 30);
  assert.equal(flushes[0].ctx.cause, "timer");
});

test("EventAggregator: flushOnMax flushes immediately once maxBatchSize is reached, and the deferred timer never double-flushes", () => {
  const { clock, advance } = createFakeClock(0);
  const flushes = [];
  const aggregator = new EventAggregator({ windowMs: 1_000, maxBatchSize: 3, onFlush: (summary, ctx) => flushes.push({ summary, ctx }), clock });
  for (let i = 0; i < 3; i++) aggregator.add("k1", baseEvent("cheer", { bits: 1 }), clock.now());
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].ctx.cause, "max");
  assert.equal(flushes[0].summary.count, 3);
  advance(2_000); // well past the window — must not fire a second, stale flush for the same batch
  assert.equal(flushes.length, 1);
});

test("EventAggregator.cancel(): discards a pending buffer WITHOUT flushing it — verified both via clearTimeout and via a direct race-simulating callback invocation", () => {
  const { clock, calls } = createFakeClock(0);
  const flushes = [];
  const aggregator = new EventAggregator({ windowMs: 1_000, maxBatchSize: 100, onFlush: (summary) => flushes.push(summary), clock });
  aggregator.add("k1", baseEvent("cheer", { bits: 999 }), clock.now());
  assert.equal(calls.length, 1);
  const racingCallback = calls[0].callback;

  aggregator.cancel();
  assert.equal(flushes.length, 0);
  assert.equal(aggregator.stats().discardedEvents, 1);
  assert.equal(aggregator.stats().discardedBuffers, 1);
  assert.equal(aggregator.stats().pendingEvents, 0);

  // Simulate the callback having already been dequeued by the event loop in the same tick cancel()
  // ran (clearTimeout alone cannot protect against this) — the generation guard must still no-op.
  racingCallback();
  assert.equal(flushes.length, 0, "a stale timer callback from a cancelled generation must never flush");
});

test("EventAggregator: config reload (cancel old instance, construct a new one) never fires the old generation's timer/action", () => {
  const { clock, advance } = createFakeClock(0);
  const oldFlushes = [];
  const oldAggregator = new EventAggregator({ windowMs: 1_000, maxBatchSize: 100, onFlush: (summary) => oldFlushes.push(summary), clock });
  oldAggregator.add("k1", baseEvent("cheer", { bits: 1 }), clock.now());
  oldAggregator.cancel(); // "runtime再適用後に旧aggregationが実行されない"

  const newFlushes = [];
  const newAggregator = new EventAggregator({ windowMs: 1_000, maxBatchSize: 100, onFlush: (summary) => newFlushes.push(summary), clock });
  newAggregator.add("k1", baseEvent("cheer", { bits: 2 }), clock.now());
  advance(1_000);

  assert.equal(oldFlushes.length, 0);
  assert.equal(newFlushes.length, 1);
  assert.equal(newFlushes[0].count, 1);
  assert.equal(newFlushes[0].totalBits, 2);
});

test("EventAggregator: bounded by maxKeys — the LEAST-RECENTLY-TOUCHED buffer is FLUSHED (not silently discarded) to make room", () => {
  const { clock } = createFakeClock(0);
  const flushes = [];
  const aggregator = new EventAggregator({ windowMs: 100_000, maxBatchSize: 100, maxKeys: 2, onFlush: (summary, ctx) => flushes.push({ summary, ctx }), clock });
  aggregator.add("k1", baseEvent("cheer", { bits: 1 }), clock.now());
  aggregator.add("k2", baseEvent("cheer", { bits: 2 }), clock.now());
  aggregator.add("k3", baseEvent("cheer", { bits: 3 }), clock.now()); // evicts k1 (oldest)
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].summary.key, "k1");
  assert.equal(flushes[0].ctx.cause, "max-keys-eviction");
  assert.equal(aggregator.stats().evictedByMaxKeys, 1);
  assert.equal(aggregator.stats().discardedBuffers, 0, "maxKeys eviction is a flush, not a discard");
  assert.ok(aggregator.stats().pendingKeys <= 2);
});

test("EventAggregator: manual flush()/flushAll()", () => {
  const { clock } = createFakeClock(0);
  const flushes = [];
  const aggregator = new EventAggregator({ windowMs: 100_000, maxBatchSize: 100, onFlush: (summary) => flushes.push(summary), clock });
  aggregator.add("k1", baseEvent("cheer", { bits: 1 }), clock.now());
  aggregator.add("k2", baseEvent("cheer", { bits: 2 }), clock.now());
  assert.equal(aggregator.flush("k1"), true);
  assert.equal(aggregator.flush("does-not-exist"), false);
  assert.equal(flushes.length, 1);
  aggregator.flushAll();
  assert.equal(flushes.length, 2);
});

// ---------------------------------------------------------------------------------------------
// global-action-budget.js
// ---------------------------------------------------------------------------------------------

test("GlobalActionBudget: rate window boundary and recovery", () => {
  let now = 0;
  const budget = new GlobalActionBudget({ windowMs: 1_000, maxPerWindow: 2, maxConcurrent: 10, highPriorityReserve: 0, clock: () => now });
  const first = budget.reserve({ priority: 0, now });
  const second = budget.reserve({ priority: 0, now });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  const third = budget.reserve({ priority: 0, now });
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "global-rate-limit");
  now = 1_001;
  assert.equal(budget.reserve({ priority: 0, now }).allowed, true);
});

test("GlobalActionBudget: concurrency cap blocks even within rate-window budget, and complete() frees a slot", () => {
  let now = 0;
  const budget = new GlobalActionBudget({ windowMs: 100_000, maxPerWindow: 100, maxConcurrent: 1, highPriorityReserve: 0, clock: () => now });
  const first = budget.reserve({ priority: 0, now });
  assert.equal(first.allowed, true);
  const second = budget.reserve({ priority: 0, now });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "global-concurrency-limit");
  assert.equal(budget.complete(first.reservation), true);
  assert.equal(budget.reserve({ priority: 0, now }).allowed, true);
});

test("GlobalActionBudget: release() (cancelled before running) frees BOTH the concurrency slot and the rate-window entry", () => {
  let now = 0;
  const budget = new GlobalActionBudget({ windowMs: 100_000, maxPerWindow: 1, maxConcurrent: 1, highPriorityReserve: 0, clock: () => now });
  const first = budget.reserve({ priority: 0, now });
  assert.equal(budget.release(first.reservation), true);
  const second = budget.reserve({ priority: 0, now });
  assert.equal(second.allowed, true, "a released reservation must not still occupy the rate window");
});

test("GlobalActionBudget: a low-priority flood cannot exceed (capacity - highPriorityReserve), reserving headroom for high-priority requests", () => {
  let now = 0;
  const budget = new GlobalActionBudget({ windowMs: 10_000, maxPerWindow: 10, maxConcurrent: 10, highPriorityReserve: 3, highPriorityThreshold: 10, clock: () => now });
  let allowed = 0;
  for (let i = 0; i < 30; i++) {
    const result = budget.reserve({ priority: 0, now });
    if (result.allowed) allowed++;
  }
  assert.equal(allowed, 7); // maxPerWindow(10) - highPriorityReserve(3)
});

test("GlobalActionBudget: a genuine flood of many DIFFERENT low-priority triggers cannot starve one high-priority reservation of global budget (rate dimension)", () => {
  let now = 0;
  const budget = new GlobalActionBudget({ windowMs: 10_000, maxPerWindow: 20, maxConcurrent: 20, highPriorityReserve: 3, highPriorityThreshold: 10, clock: () => now });
  const limiter = new ActionRateLimiter({ clock: () => now });
  let allowedLowPriority = 0;
  let rejectedByGlobalRate = 0;
  for (let i = 0; i < 50; i++) {
    now += 1;
    const perTriggerKey = `trigger:redemption-${i}`; // 50 DISTINCT triggers, each individually within its own limit
    const perTriggerRate = limiter.attempt(perTriggerKey, { windowMs: 10_000, maxActions: 2 }, now);
    if (!perTriggerRate.allowed) continue;
    const reservation = budget.reserve({ priority: 0, now });
    if (reservation.allowed) {
      allowedLowPriority += 1;
      budget.complete(reservation.reservation);
    } else {
      rejectedByGlobalRate += 1;
    }
  }
  assert.ok(allowedLowPriority > 0, "sanity: the flood did produce some allowed low-priority actions");
  assert.ok(rejectedByGlobalRate > 0, "the flood must actually have been throttled by the GLOBAL budget, not just per-trigger limits");
  assert.ok(allowedLowPriority <= 17); // never exceeds maxPerWindow(20) - highPriorityReserve(3)

  now += 1;
  const highPriority = budget.reserve({ priority: 50, now });
  assert.equal(highPriority.allowed, true, "a high-priority event must still be able to fire after a low-priority flood");
  assert.equal(highPriority.isHighPriority, true);
});

test("GlobalActionBudget: a genuine flood exhausting CONCURRENCY (not just rate) still leaves room for a high-priority reservation", () => {
  let now = 0;
  const budget = new GlobalActionBudget({ windowMs: 100_000, maxPerWindow: 100, maxConcurrent: 5, highPriorityReserve: 2, highPriorityThreshold: 10, clock: () => now });
  const active = [];
  for (let i = 0; i < 10; i++) {
    const result = budget.reserve({ priority: 0, now });
    if (result.allowed) active.push(result.reservation); // never completed — simulates a pile-up of slow in-flight low-priority actions
  }
  assert.equal(active.length, 3); // maxConcurrent(5) - highPriorityReserve(2)
  const highPriority = budget.reserve({ priority: 20, now });
  assert.equal(highPriority.allowed, true);
});

test("GlobalActionBudget.stats() and clear()", () => {
  let now = 0;
  const budget = new GlobalActionBudget({ clock: () => now });
  const r = budget.reserve({ priority: 0, now });
  assert.equal(budget.stats().activeGeneral, 1);
  budget.clear();
  assert.equal(budget.stats().activeGeneral, 0);
  assert.equal(budget.complete(r.reservation), false, "a reservation must not survive clear()");
});

// ---------------------------------------------------------------------------------------------
// Cross-module: burst-bounded and trace-compatibility integration tests.
// ---------------------------------------------------------------------------------------------

test("Integration: a burst of 100 rapid-fire events for ONE trigger produces a bounded number of fired actions and a bounded aggregation buffer, never unbounded growth", () => {
  let now = 0;
  const cooldownTracker = new CooldownTracker({ clock: () => now });
  const rateLimiter = new ActionRateLimiter({ clock: () => now });
  const flushes = [];
  const aggregator = new EventAggregator({ windowMs: 2_000, maxBatchSize: 10, onFlush: (summary) => flushes.push(summary), clock: { now: () => now, setTimeout: (cb) => cb, clearTimeout: () => {} } });
  // NOTE: this integration test drives the aggregator purely via flushOnMax/manual flush (never
  // lets a real timer fire) — `setTimeout` above returns the callback itself instead of arming a
  // real timer, and is simply never invoked, keeping this test byte-for-byte deterministic without
  // depending on EventAggregator's timer internals (already covered by the dedicated tests above).

  const triggerId = "trig-burst";
  const cooldownKey = buildCooldownKey({ triggerId, keyBy: [], event: baseEvent("reward-redemption", { rewardId: "r1", rewardTitle: "T", cost: 1 }) }).key;
  let observedMaxPendingEvents = 0;
  let firedCount = 0;

  for (let i = 0; i < 100; i++) {
    now += 1;
    const event = baseEvent("reward-redemption", { rewardId: "r1", rewardTitle: "T", cost: 1 }, { id: `evt-${i}` });
    const gate = cooldownTracker.schedule(cooldownKey, { cooldownMs: 10, consumeOn: "scheduled" }, now);
    if (gate.allowed) {
      const rate = rateLimiter.attempt(`trigger:${triggerId}`, { windowMs: 2_000, maxActions: 3, overflowPolicy: "aggregate" }, now);
      if (rate.allowed) {
        firedCount += 1;
        continue;
      }
    }
    aggregator.add(`trigger:${triggerId}`, event, now);
    observedMaxPendingEvents = Math.max(observedMaxPendingEvents, aggregator.stats().pendingEvents);
  }
  aggregator.flushAll();

  // The whole point: 100 input events must NOT translate into 100 fired actions or an
  // ever-growing buffer — both dimensions stay strictly bounded by configuration, not input size.
  assert.ok(firedCount < 100, `firedCount should be bounded, got ${firedCount}`);
  assert.ok(firedCount <= 10, `firedCount should be small relative to a 100-event burst, got ${firedCount}`);
  assert.ok(observedMaxPendingEvents <= 10, "the aggregation buffer must never exceed maxBatchSize");
  assert.ok(cooldownTracker.stats().entries <= 5);
  assert.ok(rateLimiter.stats().keys <= 5);

  const aggregatedTotal = flushes.reduce((sum, summary) => sum + summary.count, 0);
  assert.equal(firedCount + aggregatedTotal, 100, "every one of the 100 events must be accounted for as either fired or aggregated — none silently vanish");
});

test("Integration: cooldown/rate/aggregation/budget decision objects are directly compatible with #91's TriggerTraceBuffer", () => {
  const trace = new TriggerTraceBuffer({ maxEntries: 10 });
  const cooldownTracker = new CooldownTracker({ clock: () => 0 });
  const gate = cooldownTracker.schedule("trigger:x", { cooldownMs: 1_000, consumeOn: "scheduled" }, 0);
  trace.record({ ...gate, source: "cooldown" });

  const limiter = new ActionRateLimiter({ clock: () => 0 });
  const rateDecision = limiter.attempt("trigger:x", { windowMs: 1_000, maxActions: 1 }, 0);
  trace.record({ ...rateDecision, source: "rate-limit" });

  const budget = new GlobalActionBudget({ clock: () => 0 });
  const budgetDecision = budget.reserve({ priority: 0, now: 0 });
  trace.record({ ...budgetDecision, source: "global-budget" });

  const recorded = trace.list();
  assert.equal(recorded.length, 3);
  for (const entry of recorded) {
    assert.ok("reason" in entry);
    assert.equal(typeof entry.seq, "number");
    assert.equal(typeof entry.recordedAt, "number");
  }
});
