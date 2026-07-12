// Issue #89: coverage for the pure-JS StreamEvent contract (src/stream-events/{contract,schemas,
// display}.js) — schema validation for all 5 discriminated-union kinds (valid + invalid), the
// raw-payload escape-hatch guard, and the pure display formatter. Follows this repo's plain `.mjs`
// convention for src/ pure-JS parts (see scripts/test/config-core.test.mjs / response-budget.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION, STREAM_EVENT_KINDS, findRawPayloadLeaks, isForbiddenRawPayloadKey } from "../../src/stream-events/contract.js";
import { validateStreamEvent } from "../../src/stream-events/schemas.js";
import { formatStreamEvent } from "../../src/stream-events/display.js";

function baseEvent(overrides = {}) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: "evt-1",
    kind: "cheer",
    timestamp: "2026-07-12T10:00:00.000Z",
    actor: { id: "user-1", displayName: "Alice", isAnonymous: false },
    channel: { id: "channel-1", displayName: "AliceChannel" },
    sourceMetadata: { connectionId: "conn-1" },
    data: { bits: 100 },
    ...overrides,
  };
}

const VALID_FIXTURES = {
  cheer: baseEvent({ kind: "cheer", data: { bits: 500, message: "gg" } }),
  subscription: baseEvent({ kind: "subscription", data: { tier: "1000", isGift: false } }),
  resub: baseEvent({ kind: "resub", data: { tier: "2000", cumulativeMonths: 12, streakMonths: 3, message: "thanks!" } }),
  "gift-subscription": baseEvent({ kind: "gift-subscription", data: { tier: "3000", count: 5, cumulativeTotal: 20 } }),
  "reward-redemption": baseEvent({ kind: "reward-redemption", data: { rewardId: "reward-1", rewardTitle: "Hydrate!", cost: 200, userInput: "drink water", status: "fulfilled" } }),
};

test("STREAM_EVENT_KINDS lists exactly the 5 documented kinds", () => {
  assert.deepEqual([...STREAM_EVENT_KINDS], ["cheer", "subscription", "resub", "gift-subscription", "reward-redemption"]);
});

for (const kind of STREAM_EVENT_KINDS) {
  test(`validateStreamEvent accepts a valid "${kind}" fixture`, () => {
    const result = validateStreamEvent(VALID_FIXTURES[kind]);
    assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
    assert.equal(result.event.kind, kind);
  });
}

test("validateStreamEvent rejects a non-object candidate", () => {
  const result = validateStreamEvent("not an event");
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "type.object"));
});

test("validateStreamEvent rejects an unsupported kind", () => {
  const result = validateStreamEvent(baseEvent({ kind: "follow" }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "kind" && entry.code === "enum"));
});

test("validateStreamEvent rejects a malformed timestamp", () => {
  const result = validateStreamEvent(baseEvent({ timestamp: "not-a-date" }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "timestamp"));
});

test("validateStreamEvent requires actor.id unless actor.isAnonymous", () => {
  const named = validateStreamEvent(baseEvent({ actor: { id: null, displayName: "Alice", isAnonymous: false } }));
  assert.equal(named.ok, false);
  assert.ok(named.issues.some((entry) => entry.path.join(".") === "actor.id"));

  const anonymous = validateStreamEvent(baseEvent({ actor: { id: null, displayName: "Anonymous", isAnonymous: true } }));
  assert.equal(anonymous.ok, true, JSON.stringify(anonymous.ok ? null : anonymous.issues));
});

test("validateStreamEvent requires channel.id and channel.displayName", () => {
  const result = validateStreamEvent(baseEvent({ channel: { id: "", displayName: "" } }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "channel.id"));
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "channel.displayName"));
});

test("validateStreamEvent accepts a future schemaVersion as a warning, not a hard failure", () => {
  const result = validateStreamEvent(baseEvent({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "schemaVersion" && entry.severity === "warning" && entry.code === "version.future"));
});

test("validateStreamEvent rejects a non-positive-integer schemaVersion", () => {
  const result = validateStreamEvent(baseEvent({ schemaVersion: 0 }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "schemaVersion" && entry.severity === "error"));
});

// -------------------------------------------------------------------------------------------
// Per-kind `data` shape validation — one deliberately-invalid variant per kind.
// -------------------------------------------------------------------------------------------

test('validateStreamEvent rejects a "cheer" with non-positive bits', () => {
  const result = validateStreamEvent(baseEvent({ kind: "cheer", data: { bits: 0 } }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "data.bits"));
});

test('validateStreamEvent rejects a "subscription" with an unsupported tier', () => {
  const result = validateStreamEvent(baseEvent({ kind: "subscription", data: { tier: "gold" } }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "data.tier" && entry.code === "enum"));
});

test('validateStreamEvent rejects a "resub" missing cumulativeMonths', () => {
  const result = validateStreamEvent(baseEvent({ kind: "resub", data: { tier: "1000" } }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "data.cumulativeMonths"));
});

test('validateStreamEvent rejects a "gift-subscription" with a non-integer count', () => {
  const result = validateStreamEvent(baseEvent({ kind: "gift-subscription", data: { tier: "1000", count: 1.5 } }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "data.count"));
});

test('validateStreamEvent rejects a "reward-redemption" missing rewardId/rewardTitle', () => {
  const result = validateStreamEvent(baseEvent({ kind: "reward-redemption", data: { cost: 100 } }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "data.rewardId"));
  assert.ok(result.issues.some((entry) => entry.path.join(".") === "data.rewardTitle"));
});

// -------------------------------------------------------------------------------------------
// Raw platform-payload escape-hatch guard — "raw Twitch payload fieldがdomainへ漏れない".
// -------------------------------------------------------------------------------------------

test("isForbiddenRawPayloadKey flags raw-payload-shaped key names and nothing else", () => {
  for (const key of ["raw", "rawPayload", "raw_payload", "RAW-DATA", "payload", "rawTwitchPayload", "eventsubPayload"]) {
    assert.equal(isForbiddenRawPayloadKey(key), true, key);
  }
  for (const key of ["id", "kind", "sourceMetadata", "rewardTitle", "drawResult"]) {
    assert.equal(isForbiddenRawPayloadKey(key), false, key);
  }
});

test("findRawPayloadLeaks finds a top-level rawPayload field", () => {
  const leaks = findRawPayloadLeaks(baseEvent({ rawPayload: { metadata: {}, payload: {} } }));
  assert.ok(leaks.includes("rawPayload"));
});

test("findRawPayloadLeaks finds a leak nested inside sourceMetadata", () => {
  const leaks = findRawPayloadLeaks(baseEvent({ sourceMetadata: { connectionId: "conn-1", extra: { rawEvent: { subscription_type: "channel.cheer" } } } }));
  assert.ok(leaks.some((path) => path === "sourceMetadata.extra.rawEvent"));
});

test("validateStreamEvent rejects an event carrying a raw Twitch-shaped payload field, even nested in sourceMetadata", () => {
  const smuggled = baseEvent({
    sourceMetadata: {
      connectionId: "conn-1",
      // A believable attempt to smuggle Twitch's own EventSub envelope shape through the
      // otherwise-opaque sourceMetadata bag.
      rawPayload: { metadata: { message_id: "abc", subscription_type: "channel.cheer" }, payload: { is_anonymous: false, bits: 500 } },
    },
  });
  const result = validateStreamEvent(smuggled);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "forbidden.rawPayload" && entry.path.join(".") === "sourceMetadata.rawPayload"));
});

// -------------------------------------------------------------------------------------------
// display.js — pure formatter, one assertion set per kind.
// -------------------------------------------------------------------------------------------

test("formatStreamEvent formats a cheer event", () => {
  const display = formatStreamEvent(VALID_FIXTURES.cheer);
  assert.equal(display.value, 500);
  assert.match(display.summary, /Alice/);
  assert.match(display.summary, /500/);
  assert.equal(typeof display.icon, "string");
  assert.equal(typeof display.label, "string");
});

test("formatStreamEvent formats a subscription event", () => {
  const display = formatStreamEvent(VALID_FIXTURES.subscription);
  assert.equal(display.value, 1);
  assert.match(display.summary, /Alice/);
});

test("formatStreamEvent formats a resub event", () => {
  const display = formatStreamEvent(VALID_FIXTURES.resub);
  assert.equal(display.value, 12);
  assert.match(display.summary, /12/);
});

test("formatStreamEvent formats a gift-subscription event", () => {
  const display = formatStreamEvent(VALID_FIXTURES["gift-subscription"]);
  assert.equal(display.value, 5);
  assert.match(display.summary, /5/);
});

test("formatStreamEvent formats a reward-redemption event", () => {
  const display = formatStreamEvent(VALID_FIXTURES["reward-redemption"]);
  assert.equal(display.value, 200);
  assert.match(display.summary, /Hydrate!/);
});

test("formatStreamEvent never throws on an unrecognized kind and returns a safe fallback", () => {
  const display = formatStreamEvent(baseEvent({ kind: "future-kind", data: {} }));
  assert.equal(typeof display.icon, "string");
  assert.equal(typeof display.summary, "string");
  assert.equal(display.value, 0);
});
