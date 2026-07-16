// Issue #91: coverage for the StreamEvent (#89) condition schema/matcher/trace layer under
// src/triggers/{event-trigger-schema,event-field-registry,trigger-validation,event-trigger-
// matcher,trigger-trace}.js, plus its registration into src/config/*'s shared schema/validation
// pipeline (#64). Follows this repo's plain `.mjs` `node --test` convention for pure-JS src/
// modules (see scripts/test/config-core.test.mjs, scripts/test/stream-events-schema.test.mjs,
// scripts/test/response-budget.test.mjs) — no esbuild bundling, since none of this is TypeScript.
//
// Fixtures below reuse #89's real StreamEvent field shapes one-for-one (checked against
// src/stream-events/schemas.js's own validateStreamEvent() for a representative fixture per kind,
// and against #90's actual normalizer output shapes under electron/main/services/twitch/events/
// normalizers/*.ts for field names/values) rather than inventing a divergent shape, mirroring
// scripts/test/stream-events-schema.test.mjs's own `baseEvent({ overrides })` convention.
import assert from "node:assert/strict";
import test from "node:test";

import { CURRENT_SCHEMA_VERSION } from "../../src/stream-events/contract.js";
import { validateStreamEvent } from "../../src/stream-events/schemas.js";

import {
  EVENT_FIELD_KEYS,
  OPERATORS_BY_TYPE,
  getFieldDefinition,
  isFieldValidForAnyKind,
  isFieldValidForKind,
  operatorsForField,
  resolveFieldValue,
} from "../../src/triggers/event-field-registry.js";
import {
  DEFAULT_MAX_MATCHES_PER_EVENT,
  MAX_CONDITION_DEPTH,
  createEventTriggerConfig,
  isConditionGroupNode,
  isConditionLeafNode,
} from "../../src/triggers/event-trigger-schema.js";
import { validateEventTriggerConfig, validateEventTriggersConfig } from "../../src/triggers/trigger-validation.js";
import { evaluateCondition, matchEvent } from "../../src/triggers/event-trigger-matcher.js";
import { TriggerTraceBuffer } from "../../src/triggers/trigger-trace.js";

import { CURRENT_CONFIG_SCHEMA } from "../../src/config/config-schema.js";
import { applyConfigDefaults } from "../../src/config/config-defaults.js";
import { validateConfigStructure } from "../../src/config/config-validation.js";

// ---------------------------------------------------------------------------------------------
// Fixtures — real StreamEvent shapes (see header comment).
// ---------------------------------------------------------------------------------------------

function baseEvent(kind, data, overrides = {}) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: overrides.id ?? `evt-${kind}-1`,
    kind,
    timestamp: "2026-07-12T10:00:00.000Z",
    actor: { id: "user-1", displayName: "Alice", isAnonymous: false },
    channel: { id: "channel-1", displayName: "AliceChannel" },
    sourceMetadata: { connectionId: "conn-1" },
    data,
    ...overrides,
  };
}

const anonymousActor = { id: null, displayName: "Anonymous", isAnonymous: true };

function cheerEvent(bits, { message, anonymous = false } = {}) {
  const event = baseEvent("cheer", { bits, ...(message !== undefined ? { message } : {}) });
  if (anonymous) event.actor = anonymousActor;
  return event;
}
function subscriptionEvent(tier, isGift) {
  return baseEvent("subscription", { tier, ...(isGift !== undefined ? { isGift } : {}) });
}
function resubEvent(tier, cumulativeMonths, { streakMonths, message } = {}) {
  return baseEvent("resub", { tier, cumulativeMonths, ...(streakMonths !== undefined ? { streakMonths } : {}), ...(message !== undefined ? { message } : {}) });
}
function giftSubscriptionEvent(tier, count, { cumulativeTotal, anonymous = false } = {}) {
  const event = baseEvent("gift-subscription", { tier, count, ...(cumulativeTotal !== undefined ? { cumulativeTotal } : {}) });
  if (anonymous) event.actor = anonymousActor;
  return event;
}
function rewardRedemptionEvent(rewardId, cost, { userInput, status = "fulfilled", rewardTitle = "Hydrate!" } = {}) {
  return baseEvent("reward-redemption", { rewardId, rewardTitle, cost, ...(userInput !== undefined ? { userInput } : {}), status });
}

test("fixtures are real, schema-valid StreamEvents (one representative per kind)", () => {
  for (const event of [cheerEvent(500, { message: "gg" }), subscriptionEvent("1000", false), resubEvent("2000", 12, { streakMonths: 3 }), giftSubscriptionEvent("3000", 5, { cumulativeTotal: 20 }), rewardRedemptionEvent("reward-1", 200, { userInput: "drink water" })]) {
    const result = validateStreamEvent(event);
    assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  }
});

function trigger(overrides = {}) {
  return createEventTriggerConfig({ id: "t1", eventTypes: ["cheer"], condition: { all: [{ field: "data.bits", operator: "gte", value: 100 }] }, ...overrides });
}

// ---------------------------------------------------------------------------------------------
// event-field-registry.js
// ---------------------------------------------------------------------------------------------

test("field registry resolves real field values via fixed getters, never a dynamic path walk", () => {
  const event = cheerEvent(250, { message: "nice" });
  assert.equal(resolveFieldValue("data.bits", event), 250);
  assert.equal(resolveFieldValue("data.message", event), "nice");
  assert.equal(resolveFieldValue("actor.isAnonymous", event), false);
  assert.equal(resolveFieldValue("actor.displayName", event), "Alice");
  assert.equal(resolveFieldValue("channel.id", event), "channel-1");
});

test("field registry rejects arbitrary/unregistered property paths, including prototype-shaped keys", () => {
  const event = cheerEvent(100);
  for (const key of ["__proto__", "__proto__.polluted", "constructor", "constructor.prototype.polluted", "data.__proto__.bits", "toString", "data.bits.__proto__", "data.notARealField", "totally.made.up"]) {
    assert.equal(getFieldDefinition(key), null, `expected "${key}" to be unregistered`);
    assert.equal(resolveFieldValue(key, event), undefined, `expected "${key}" to resolve to undefined`);
  }
  // Confirm the registry lookup itself never leaks prototype internals even when handed a key that
  // is a real property on Object.prototype.
  assert.equal(Object.prototype.hasOwnProperty.call(event, "__proto__"), false);
});

test("field registry: operator sets are derived purely from value type", () => {
  assert.deepEqual(operatorsForField("data.bits"), OPERATORS_BY_TYPE.number);
  assert.deepEqual(operatorsForField("data.tier"), OPERATORS_BY_TYPE.string);
  assert.deepEqual(operatorsForField("data.isGift"), OPERATORS_BY_TYPE.boolean);
  assert.deepEqual(operatorsForField("unknown.field"), []);
});

test("field registry: isFieldValidForKind / isFieldValidForAnyKind reflect the real per-kind allow-list", () => {
  assert.equal(isFieldValidForKind("data.bits", "cheer"), true);
  assert.equal(isFieldValidForKind("data.bits", "subscription"), false);
  assert.equal(isFieldValidForAnyKind("data.bits", ["subscription", "cheer"]), true);
  assert.equal(isFieldValidForAnyKind("data.bits", ["subscription", "resub"]), false);
  assert.ok(EVENT_FIELD_KEYS.includes("data.rewardId"));
  assert.ok(EVENT_FIELD_KEYS.includes("data.cost"));
  assert.ok(EVENT_FIELD_KEYS.includes("data.count")); // real field name; issue text's "total" paraphrase
  assert.ok(EVENT_FIELD_KEYS.includes("actor.isAnonymous"));
});

// ---------------------------------------------------------------------------------------------
// event-trigger-schema.js — shape predicates + defaults
// ---------------------------------------------------------------------------------------------

test("createEventTriggerConfig applies defaults without validating", () => {
  const config = createEventTriggerConfig({ id: "x", eventTypes: ["cheer"] });
  assert.equal(config.enabled, true);
  assert.equal(config.priority, 0);
  assert.equal(config.stopPropagation, false);
  assert.deepEqual(config.condition, { all: [] });
});

test("isConditionGroupNode / isConditionLeafNode distinguish group vs leaf shapes", () => {
  assert.equal(isConditionGroupNode({ all: [] }), true);
  assert.equal(isConditionGroupNode({ any: [] }), true);
  assert.equal(isConditionGroupNode({ field: "data.bits", operator: "eq", value: 1 }), false);
  assert.equal(isConditionLeafNode({ field: "data.bits", operator: "eq", value: 1 }), true);
  assert.equal(isConditionLeafNode({ all: [] }), false);
});

// ---------------------------------------------------------------------------------------------
// trigger-validation.js — save-time validation
// ---------------------------------------------------------------------------------------------

test("validateEventTriggerConfig accepts a well-formed trigger", () => {
  const result = validateEventTriggerConfig(trigger());
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
});

test("validateEventTriggerConfig rejects a missing id / non-boolean enabled / empty eventTypes", () => {
  const result = validateEventTriggerConfig(trigger({ id: undefined, enabled: "yes", eventTypes: [] }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "id" && entry.code === "required"));
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "enabled" && entry.code === "type.boolean"));
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "eventTypes" && entry.code === "required"));
});

test("validateEventTriggerConfig rejects an eventTypes entry that isn't a real StreamEvent kind", () => {
  const result = validateEventTriggerConfig(trigger({ eventTypes: ["cheer", "follow"] }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "eventTypes.1" && entry.code === "enum"));
});

test("validateEventTriggerConfig rejects an unregistered/arbitrary field path (defense against prototype-shaped keys)", () => {
  for (const field of ["__proto__", "__proto__.polluted", "constructor.prototype.polluted", "data.notARealField"]) {
    const result = validateEventTriggerConfig(trigger({ condition: { all: [{ field, operator: "eq", value: 1 }] } }));
    assert.equal(result.ok, false, `expected field "${field}" to be rejected`);
    assert.ok(result.issues.some((entry) => entry.code === "field.unknown"), `expected a field.unknown issue for "${field}"`);
  }
});

test("validateEventTriggerConfig rejects a field not valid for any of the trigger's configured eventTypes", () => {
  const result = validateEventTriggerConfig(trigger({ eventTypes: ["subscription"], condition: { all: [{ field: "data.bits", operator: "gte", value: 100 }] } }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "field.notApplicable"));
});

test("validateEventTriggerConfig allows a cross-kind field inside an \"any\" group spanning multiple eventTypes", () => {
  const result = validateEventTriggerConfig(
    trigger({
      eventTypes: ["cheer", "subscription"],
      condition: { any: [{ field: "data.bits", operator: "gte", value: 1000 }, { field: "data.tier", operator: "in", value: ["2000", "3000"] }] },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
});

test("validateEventTriggerConfig rejects number/string/boolean type mismatches at save time", () => {
  const numberMismatch = validateEventTriggerConfig(trigger({ condition: { all: [{ field: "data.bits", operator: "gte", value: "100" }] } }));
  assert.equal(numberMismatch.ok, false);
  assert.ok(numberMismatch.issues.some((entry) => entry.code === "type.number"));

  const stringMismatch = validateEventTriggerConfig(trigger({ eventTypes: ["subscription"], condition: { all: [{ field: "data.tier", operator: "eq", value: 1000 }] } }));
  assert.equal(stringMismatch.ok, false);
  assert.ok(stringMismatch.issues.some((entry) => entry.code === "type.string"));

  const booleanMismatch = validateEventTriggerConfig(trigger({ eventTypes: ["subscription"], condition: { all: [{ field: "data.isGift", operator: "eq", value: "true" }] } }));
  assert.equal(booleanMismatch.ok, false);
  assert.ok(booleanMismatch.issues.some((entry) => entry.code === "type.boolean"));

  const betweenMismatch = validateEventTriggerConfig(trigger({ condition: { all: [{ field: "data.bits", operator: "between", value: [100] }] } }));
  assert.equal(betweenMismatch.ok, false);
  assert.ok(betweenMismatch.issues.some((entry) => entry.code === "type.numberRange"));

  const inMismatch = validateEventTriggerConfig(trigger({ condition: { all: [{ field: "data.bits", operator: "in", value: "100" }] } }));
  assert.equal(inMismatch.ok, false);
  assert.ok(inMismatch.issues.some((entry) => entry.code === "type.numberArray"));
});

test("validateEventTriggerConfig rejects an operator not valid for the field's type", () => {
  const result = validateEventTriggerConfig(trigger({ condition: { all: [{ field: "data.bits", operator: "contains", value: "1" }] } }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "operator.invalid"));
});

test("validateEventTriggerConfig rejects regex-family operators outright (v1 has no regex support)", () => {
  const result = validateEventTriggerConfig(trigger({ eventTypes: ["cheer"], condition: { all: [{ field: "data.message", operator: "regex", value: "^gg$" }] } }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "operator.unsupported"));
});

test("validateEventTriggerConfig rejects an ambiguous all+any node and an empty group", () => {
  const ambiguous = validateEventTriggerConfig(trigger({ condition: { all: [{ field: "data.bits", operator: "gte", value: 1 }], any: [{ field: "data.bits", operator: "lte", value: 2 }] } }));
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.issues.some((entry) => entry.code === "condition.ambiguous"));

  const empty = validateEventTriggerConfig(trigger({ condition: { all: [] } }));
  assert.equal(empty.ok, false);
  assert.ok(empty.issues.some((entry) => entry.code === "condition.empty"));
});

test("validateEventTriggerConfig rejects a condition tree deeper than MAX_CONDITION_DEPTH", () => {
  let node = { field: "data.bits", operator: "gte", value: 1 };
  for (let depth = 0; depth <= MAX_CONDITION_DEPTH + 1; depth++) node = { all: [node] };
  const result = validateEventTriggerConfig(trigger({ condition: node }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "condition.tooDeep"));
});

test("validateEventTriggerConfig rejects a condition node that is neither a group nor a leaf", () => {
  const result = validateEventTriggerConfig(trigger({ condition: { all: [{ nonsense: true }] } }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "condition.invalidShape"));
});

test("validateEventTriggersConfig aggregates per-trigger issues under eventTriggers.<id>.* paths and flags id mismatches", () => {
  const result = validateEventTriggersConfig({
    good: trigger({ id: "good" }),
    bad: trigger({ id: "mismatched-id", eventTypes: [] }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "eventTriggers.bad.eventTypes" && entry.code === "required"));
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "eventTriggers.bad.id" && entry.code === "id.mismatch" && entry.severity === "warning"));
});

test("validateEventTriggersConfig treats an absent section as valid (optional, additive section)", () => {
  const result = validateEventTriggersConfig(undefined);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------------------------
// event-trigger-matcher.js — evaluateCondition() + matchEvent()
// ---------------------------------------------------------------------------------------------

test("bits threshold boundary: 99 fails, 100 and 101 pass a >= 100 condition", () => {
  const t = trigger({ condition: { all: [{ field: "data.bits", operator: "gte", value: 100 }] } });
  assert.equal(evaluateCondition(t.condition, cheerEvent(99)).passed, false);
  assert.equal(evaluateCondition(t.condition, cheerEvent(100)).passed, true);
  assert.equal(evaluateCondition(t.condition, cheerEvent(101)).passed, true);
});

test("bits threshold boundary via \"between\": 99 fails, 100 and 200 pass, 201 fails", () => {
  const condition = { all: [{ field: "data.bits", operator: "between", value: [100, 200] }] };
  assert.equal(evaluateCondition(condition, cheerEvent(99)).passed, false);
  assert.equal(evaluateCondition(condition, cheerEvent(100)).passed, true);
  assert.equal(evaluateCondition(condition, cheerEvent(200)).passed, true);
  assert.equal(evaluateCondition(condition, cheerEvent(201)).passed, false);
});

test("tier eq / in", () => {
  const eqCondition = { all: [{ field: "data.tier", operator: "eq", value: "1000" }] };
  assert.equal(evaluateCondition(eqCondition, subscriptionEvent("1000", false)).passed, true);
  assert.equal(evaluateCondition(eqCondition, subscriptionEvent("2000", false)).passed, false);

  const inCondition = { all: [{ field: "data.tier", operator: "in", value: ["2000", "3000"] }] };
  assert.equal(evaluateCondition(inCondition, subscriptionEvent("2000", false)).passed, true);
  assert.equal(evaluateCondition(inCondition, subscriptionEvent("1000", false)).passed, false);
});

test("isGift true / false", () => {
  const condition = { all: [{ field: "data.isGift", operator: "eq", value: true }] };
  assert.equal(evaluateCondition(condition, subscriptionEvent("1000", true)).passed, true);
  assert.equal(evaluateCondition(condition, subscriptionEvent("1000", false)).passed, false);
});

test("reward ID and cost", () => {
  const condition = { all: [{ field: "data.rewardId", operator: "eq", value: "reward-1" }, { field: "data.cost", operator: "lte", value: 200 }] };
  assert.equal(evaluateCondition(condition, rewardRedemptionEvent("reward-1", 200)).passed, true);
  assert.equal(evaluateCondition(condition, rewardRedemptionEvent("reward-1", 500)).passed, false);
  assert.equal(evaluateCondition(condition, rewardRedemptionEvent("reward-2", 100)).passed, false);
});

test("anonymous actor (actor.isAnonymous)", () => {
  const condition = { all: [{ field: "actor.isAnonymous", operator: "eq", value: true }] };
  assert.equal(evaluateCondition(condition, cheerEvent(100, { anonymous: true })).passed, true);
  assert.equal(evaluateCondition(condition, cheerEvent(100, { anonymous: false })).passed, false);
  assert.equal(evaluateCondition(condition, giftSubscriptionEvent("1000", 1, { anonymous: true })).passed, true);
});

test("message present/contains: matches when present and containing the substring, fails (value-missing) when absent", () => {
  const condition = { all: [{ field: "data.message", operator: "contains", value: "gg" }] };
  const present = evaluateCondition(condition, cheerEvent(100, { message: "gg wp" }));
  assert.equal(present.passed, true);

  const absent = evaluateCondition(condition, cheerEvent(100));
  assert.equal(absent.passed, false);
  assert.equal(absent.details[0].reason, "value-missing");

  const nonMatching = evaluateCondition(condition, cheerEvent(100, { message: "hello" }));
  assert.equal(nonMatching.passed, false);
  assert.equal(nonMatching.details[0].reason, "value-mismatch");
});

test("nested all/any group: any(bits>=1000, tier in [2000,3000]) works across event kinds via field-not-applicable", () => {
  const condition = { any: [{ field: "data.bits", operator: "gte", value: 1000 }, { field: "data.tier", operator: "in", value: ["2000", "3000"] }] };

  const bigCheer = evaluateCondition(condition, cheerEvent(1500));
  assert.equal(bigCheer.passed, true);
  // the tier leaf isn't applicable to a cheer event — confirm it's recorded as such, not thrown
  assert.ok(bigCheer.details.some((entry) => entry.field === "data.tier" && entry.reason === "field-not-applicable"));

  const tier2Sub = evaluateCondition(condition, subscriptionEvent("2000", false));
  assert.equal(tier2Sub.passed, true);
  assert.ok(tier2Sub.details.some((entry) => entry.field === "data.bits" && entry.reason === "field-not-applicable"));

  const smallCheer = evaluateCondition(condition, cheerEvent(10));
  assert.equal(smallCheer.passed, false);

  const nestedAllAny = { all: [{ field: "actor.isAnonymous", operator: "eq", value: false }, condition] };
  assert.equal(evaluateCondition(nestedAllAny, cheerEvent(2000)).passed, true);
});

test("matchEvent: priority descending order is always preserved across different priorities", () => {
  const triggers = [
    trigger({ id: "low", priority: 1 }),
    trigger({ id: "tie-a", priority: 5 }),
    trigger({ id: "tie-b", priority: 5 }),
    trigger({ id: "high", priority: 10 }),
    trigger({ id: "tie-c", priority: 5 }),
  ];
  const { matches } = matchEvent(triggers, cheerEvent(100));
  assert.equal(matches[0].triggerId, "high");
  assert.equal(matches[matches.length - 1].triggerId, "low");
  assert.deepEqual(
    matches.map((entry) => entry.triggerId).filter((id) => id.startsWith("tie-")).sort(),
    ["tie-a", "tie-b", "tie-c"],
  );
});

test("matchEvent: equal-priority ties are shuffled via the injectable `random`, not fixed to config array order", () => {
  const triggers = [
    trigger({ id: "tie-a", priority: 5 }),
    trigger({ id: "tie-b", priority: 5 }),
    trigger({ id: "tie-c", priority: 5 }),
  ];
  // A `random` that always returns 0 drives a deterministic (non-config-array-order) Fisher-Yates permutation.
  const { matches: shuffled } = matchEvent(triggers, cheerEvent(100), { random: () => 0 });
  assert.deepEqual(shuffled.map((entry) => entry.triggerId), ["tie-b", "tie-c", "tie-a"]);

  // The default `random` (Math.random) does not deterministically reproduce config array order
  // every time — sample many runs and confirm more than one distinct ordering occurs.
  const orderings = new Set();
  for (let i = 0; i < 50; i++) {
    const { matches } = matchEvent(triggers, cheerEvent(100));
    orderings.add(matches.map((entry) => entry.triggerId).join(","));
  }
  assert.ok(orderings.size > 1, `expected multiple distinct tie orderings across 50 runs, got: ${[...orderings].join(" | ")}`);
});

test("matchEvent: stopPropagation prevents lower-priority triggers from even being condition-evaluated", () => {
  const triggers = [
    trigger({ id: "stopper", priority: 10, stopPropagation: true }),
    trigger({ id: "would-also-match", priority: 5 }),
  ];
  const { matches, skipped } = matchEvent(triggers, cheerEvent(100));
  assert.deepEqual(matches.map((entry) => entry.triggerId), ["stopper"]);
  const blocked = skipped.find((entry) => entry.triggerId === "would-also-match");
  assert.equal(blocked.reason, "stopped-by-higher-priority");
  assert.deepEqual(blocked.details, []); // never condition-evaluated at all
});

test("matchEvent: maxMatchesPerEvent caps matches and marks the result truncated", () => {
  const triggers = [1, 2, 3, 4].map((n) => trigger({ id: `t${n}`, priority: 10 - n }));
  const { matches, skipped, truncated } = matchEvent(triggers, cheerEvent(500), { maxMatchesPerEvent: 2 });
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((entry) => entry.triggerId), ["t1", "t2"]);
  assert.equal(truncated, true);
  assert.ok(skipped.some((entry) => entry.triggerId === "t3" && entry.reason === "max-matches-reached"));
});

test("matchEvent respects the DEFAULT_MAX_MATCHES_PER_EVENT constant when no override is given", () => {
  const triggers = Array.from({ length: DEFAULT_MAX_MATCHES_PER_EVENT + 3 }, (_, index) => trigger({ id: `t${index}`, priority: 100 - index }));
  const { matches, truncated } = matchEvent(triggers, cheerEvent(500));
  assert.equal(matches.length, DEFAULT_MAX_MATCHES_PER_EVENT);
  assert.equal(truncated, true);
});

test("matchEvent: coarse enabled/eventType filter skips before any condition evaluation", () => {
  const triggers = [trigger({ id: "disabled", enabled: false }), trigger({ id: "wrong-kind", eventTypes: ["subscription"] })];
  const { matches, skipped } = matchEvent(triggers, cheerEvent(100));
  assert.equal(matches.length, 0);
  assert.equal(skipped.find((entry) => entry.triggerId === "disabled").reason, "disabled");
  assert.equal(skipped.find((entry) => entry.triggerId === "wrong-kind").reason, "event-type-mismatch");
});

test("matchEvent: a non-matching trigger records condition-not-met plus its failed leaf detail(s)", () => {
  const { skipped } = matchEvent([trigger({ id: "needs-1000-bits", condition: { all: [{ field: "data.bits", operator: "gte", value: 1000 }] } })], cheerEvent(10));
  const entry = skipped[0];
  assert.equal(entry.matched, false);
  assert.equal(entry.reason, "condition-not-met");
  assert.equal(entry.details[0].field, "data.bits");
  assert.equal(entry.details[0].actual, 10);
  assert.equal(entry.details[0].expected, 1000);
  assert.equal(entry.details[0].reason, "value-mismatch");
});

// ---------------------------------------------------------------------------------------------
// trigger-trace.js — bounded ring buffer
// ---------------------------------------------------------------------------------------------

test("TriggerTraceBuffer is bounded: oldest entries are evicted once over maxEntries", () => {
  const buffer = new TriggerTraceBuffer({ maxEntries: 3 });
  for (let i = 0; i < 10; i++) buffer.record({ triggerId: `t${i}` });
  assert.equal(buffer.list().length, 3);
  assert.deepEqual(buffer.list().map((entry) => entry.triggerId), ["t7", "t8", "t9"]);
  assert.equal(buffer.stats().totalRecorded, 10);
  assert.ok(buffer.stats().evictedByLimit > 0);
});

test("TriggerTraceBuffer.recent() returns newest-first and record() stamps a monotonic seq", () => {
  const buffer = new TriggerTraceBuffer({ maxEntries: 10 });
  buffer.record({ triggerId: "a" });
  buffer.record({ triggerId: "b" });
  buffer.record({ triggerId: "c" });
  assert.deepEqual(buffer.recent(2).map((entry) => entry.triggerId), ["c", "b"]);
  const seqs = buffer.list().map((entry) => entry.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test("TriggerTraceBuffer.clear() empties the buffer without resetting totalRecorded", () => {
  const buffer = new TriggerTraceBuffer({ maxEntries: 5 });
  buffer.record({ triggerId: "a" });
  buffer.clear();
  assert.equal(buffer.list().length, 0);
  assert.equal(buffer.stats().totalRecorded, 1);
});

test("TriggerTraceBuffer rejects a non-positive-integer maxEntries", () => {
  assert.throws(() => new TriggerTraceBuffer({ maxEntries: 0 }), RangeError);
});

test("matchEvent(..., { trace }) records both matched and skipped results, so match/skip reasons are recoverable from the trace", () => {
  const buffer = new TriggerTraceBuffer({ maxEntries: 20 });
  const triggers = [trigger({ id: "matches", condition: { all: [{ field: "data.bits", operator: "gte", value: 10 }] } }), trigger({ id: "misses", condition: { all: [{ field: "data.bits", operator: "gte", value: 10000 }] } })];
  matchEvent(triggers, cheerEvent(500), { trace: buffer });
  const recorded = buffer.list();
  assert.equal(recorded.length, 2);
  assert.equal(recorded.find((entry) => entry.triggerId === "matches").matched, true);
  const missed = recorded.find((entry) => entry.triggerId === "misses");
  assert.equal(missed.matched, false);
  assert.equal(missed.reason, "condition-not-met");
  assert.equal(missed.details[0].actual, 500);
});

// ---------------------------------------------------------------------------------------------
// #64 config registration
// ---------------------------------------------------------------------------------------------

test("eventTriggers is registered as its own additive config section (alongside, not replacing, the existing `triggers` section)", () => {
  assert.ok(CURRENT_CONFIG_SCHEMA.sections.includes("eventTriggers"));
  assert.ok(CURRENT_CONFIG_SCHEMA.sections.includes("triggers"));
  assert.ok(!CURRENT_CONFIG_SCHEMA.required.includes("eventTriggers")); // optional section
});

test("applyConfigDefaults fills in eventTriggers entry defaults without requiring the section to pre-exist", () => {
  const defaulted = applyConfigDefaults({ personas: [], connectors: {}, triggers: {} });
  assert.deepEqual(defaulted.eventTriggers, {});

  const withOne = applyConfigDefaults({ personas: [], connectors: {}, triggers: {}, eventTriggers: { t1: { eventTypes: ["cheer"], condition: { all: [] } } } });
  assert.equal(withOne.eventTriggers.t1.enabled, true);
  assert.equal(withOne.eventTriggers.t1.priority, 0);
  assert.equal(withOne.eventTriggers.t1.stopPropagation, false);
});

test("validateConfigStructure routes through trigger-validation.js's own field/type checks for eventTriggers", () => {
  const baseConfig = { schemaVersion: CURRENT_CONFIG_SCHEMA.version, connectors: {}, personas: [], triggers: {} };

  const invalid = validateConfigStructure({ ...baseConfig, eventTriggers: { bad: trigger({ id: "bad", condition: { all: [{ field: "__proto__", operator: "eq", value: 1 }] } }) } });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((entry) => entry.path.join(".") === "eventTriggers.bad.condition.all.0.field" && entry.code === "field.unknown"));

  const valid = validateConfigStructure({ ...baseConfig, eventTriggers: { good: trigger({ id: "good" }) } });
  assert.ok(!valid.issues.some((entry) => entry.path[0] === "eventTriggers" && entry.severity === "error"));
});

test("existing src/trigger-engine.js keyword/hotkey/interval/random/manual system is untouched by this module set", async () => {
  const triggerEngineSource = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../src/trigger-engine.js", import.meta.url), "utf8"));
  assert.ok(!triggerEngineSource.includes("event-trigger-matcher"));
  assert.ok(!triggerEngineSource.includes("event-trigger-schema"));
  assert.ok(!triggerEngineSource.includes("triggers/"));
});
