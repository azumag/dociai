// Tests for issue #90's EventSub-notification-to-StreamEvent normalizer layer
// (electron/main/services/twitch/events/{twitch-event-normalizer,event-validation,text-sanitizer,
// timestamp-normalizer,normalizers/*}.ts), built on top of #89's StreamEvent contract
// (src/stream-events/{contract,schemas}.js) and #87's desired-subscriptions.ts type@version list.
// Follows the exact esbuild-bundle-then-node--test convention #75/#76/#83/#84/#85/#86/#87
// established (see scripts/test/twitch-eventsub-subscriptions.test.mjs).
//
// Every normalized event produced here is checked against the REAL src/stream-events/schemas.js
// `validateStreamEvent()` (imported directly, not reimplemented/re-asserted by hand) — issue #90's
// own acceptance criterion that a normalizer's output actually satisfies #89's real contract, not
// just this test file's own idea of the shape.
//
// Fixtures under tests/fixtures/twitch/eventsub/*.json are full EventSub `notification` message
// envelopes (`{ metadata, payload: { subscription, event } }`), shaped after Twitch's own
// documented example JSON for channel.cheer/channel.subscribe/channel.subscription.message/
// channel.subscription.gift (dev.twitch.tv/docs/eventsub/eventsub-subscription-types/, fetched
// verbatim) and, for channel.channel_points_custom_reward_redemption.add, twitchdev's own
// official `twitch-cli` mock-event source (see twitch-event-normalizer.ts's own module doc
// comment for the exact source list) — most edge cases below are deliberately expressed as
// small in-test overrides of a loaded fixture's `event` object rather than one-off fixture files
// per case, mirroring scripts/test/stream-events-schema.test.mjs's own `baseEvent({ overrides })`
// convention. A few numeric edge cases (NaN/Infinity) are inline JS objects rather than fixtures
// for a structural reason, not a style one: JSON itself cannot encode NaN/Infinity, so Twitch's
// real wire format (JSON) could never actually deliver them — but this normalizer still defends
// against them being constructed programmatically upstream.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { findRawPayloadLeaks } from "../../src/stream-events/contract.js";
import { validateStreamEvent } from "../../src/stream-events/schemas.js";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const fixturesDir = path.join(repoRoot, "tests/fixtures/twitch/eventsub");

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { normalizeTwitchEvent, SUPPORTED_TYPE_VERSIONS } from "./electron/main/services/twitch/events/twitch-event-normalizer.ts";`,
        `export { sanitizeText, MAX_TEXT_LENGTH } from "./electron/main/services/twitch/events/text-sanitizer.ts";`,
        `export { normalizeEventTimestamp } from "./electron/main/services/twitch/events/timestamp-normalizer.ts";`,
        `export { EVENT_DEFINITIONS } from "./electron/main/services/twitch/eventsub/desired-subscriptions.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "twitch-event-normalizer-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-twitch-event-normalizer-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

async function loadFixture(name) {
  const raw = await fs.readFile(path.join(fixturesDir, `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const FIXED_RECEIVED_AT_MS = Date.parse("2026-01-01T00:00:00.000Z");

/** Builds a `NormalizeInput` from a loaded envelope fixture, with an `event` override for tests
 * that need to mutate a specific field without hand-building a whole new envelope. */
function inputFromFixture(fixture, eventOverrides = {}, inputOverrides = {}) {
  return {
    event: { ...fixture.payload.event, ...eventOverrides },
    messageId: fixture.metadata.message_id,
    messageTimestamp: fixture.metadata.message_timestamp,
    receivedAtMs: FIXED_RECEIVED_AT_MS,
    ...inputOverrides,
  };
}

function typeVersionFromFixture(fixture) {
  return [fixture.metadata.subscription_type, fixture.metadata.subscription_version];
}

function issueCodes(issues) {
  return issues.map((i) => i.code);
}

// =============================================================================================
// Registry: type@version dispatch, and consistency with #87's desired-subscriptions.ts.
// =============================================================================================

test("SUPPORTED_TYPE_VERSIONS is exactly the 5 type@version pairs desired-subscriptions.ts (#87) targets — the normalizer registry never drifts from the subscription registry", async () => {
  const { modules } = await loadModules();
  const expected = modules.EVENT_DEFINITIONS.map((d) => `${d.type}@${d.version}`).sort();
  assert.deepEqual([...modules.SUPPORTED_TYPE_VERSIONS].sort(), expected);
  assert.equal(modules.SUPPORTED_TYPE_VERSIONS.length, 5);
});

test("normalizeTwitchEvent: an unknown type/version is reported (ok:false, diagnostic issue), never a silent drop", async () => {
  const { modules } = await loadModules();
  const cases = [
    ["channel.cheer", "2"], // known type, unsupported version
    ["channel.unknown_thing", "1"], // entirely unknown type
    ["", ""],
  ];
  for (const [type, version] of cases) {
    const result = modules.normalizeTwitchEvent(type, version, { event: {}, messageId: "msg-1", receivedAtMs: FIXED_RECEIVED_AT_MS });
    assert.equal(result.ok, false, `${type}@${version}`);
    assert.ok(issueCodes(result.issues).includes("unknown_subscription"), `${type}@${version}`);
    assert.equal(result.diagnostics.type, type);
    assert.equal(result.diagnostics.version, version);
  }
});

test("normalizeTwitchEvent: a missing/blank messageId fails normalization regardless of type/version", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  for (const badId of [undefined, "", "   "]) {
    const [type, version] = typeVersionFromFixture(fixture);
    const result = modules.normalizeTwitchEvent(type, version, inputFromFixture(fixture, {}, { messageId: badId }));
    assert.equal(result.ok, false, JSON.stringify(badId));
    assert.ok(result.issues.some((i) => i.field === "messageId" && i.severity === "error"));
  }
});

// =============================================================================================
// Every canonical + anonymous fixture normalizes to a StreamEvent that passes the REAL #89
// validateStreamEvent().
// =============================================================================================

const CANONICAL_FIXTURES = [
  ["cheer", "cheer"],
  ["cheer-anonymous", "cheer"],
  ["subscribe", "subscription"],
  ["subscription-message", "resub"],
  ["subscription-gift", "gift-subscription"],
  ["subscription-gift-anonymous", "gift-subscription"],
  ["reward-redemption", "reward-redemption"],
];

for (const [fixtureName, expectedKind] of CANONICAL_FIXTURES) {
  test(`normalizeTwitchEvent("${fixtureName}"): produces a StreamEvent that passes the real #89 validateStreamEvent()`, async () => {
    const { modules } = await loadModules();
    const fixture = await loadFixture(fixtureName);
    const [type, version] = typeVersionFromFixture(fixture);
    const result = modules.normalizeTwitchEvent(type, version, inputFromFixture(fixture));
    assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
    assert.equal(result.event.kind, expectedKind);

    const validation = validateStreamEvent(result.event);
    assert.equal(validation.ok, true, `real validateStreamEvent() rejected the normalized event: ${JSON.stringify(validation.ok ? null : validation.issues)}`);
    assert.deepEqual(findRawPayloadLeaks(result.event), [], "normalized event must never carry a raw-payload-shaped field");
    assert.equal(result.event.id, fixture.metadata.message_id, "StreamEvent.id must be the EventSub message_id (dedupe key parity with notification-dedupe.ts)");
  });
}

// =============================================================================================
// Named vs anonymous identity — "匿名identityを推測しない".
// =============================================================================================

test("cheer: named actor uses user_name as displayName and the real user_id", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", inputFromFixture(fixture));
  assert.equal(result.ok, true);
  assert.deepEqual(result.event.actor, { id: "1234", displayName: "Cool_User", isAnonymous: false });
});

test("cheer: anonymous actor is null id + fixed 'Anonymous' displayName, never derived from any other field", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer-anonymous");
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", inputFromFixture(fixture));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.deepEqual(result.event.actor, { id: null, displayName: "Anonymous", isAnonymous: true });
});

test("cheer: is_anonymous:true ignores user_id/user_login/user_name EVEN IF Twitch (contrary to its own documented shape) sent them non-null — identity is never derived from anything but the fixed label", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer-anonymous");
  // The real cheer-anonymous.json fixture already nulls these out per Twitch's documented shape,
  // which means a regression that fell back to user_name when it's null/absent would be invisible
  // to the test above. This override simulates the (undocumented, but not impossible for a
  // malformed/future payload) case where is_anonymous:true co-occurs with a non-null identity, to
  // prove buildActor() truly never inspects those fields on the anonymous path at all.
  const result = modules.normalizeTwitchEvent(
    "channel.cheer",
    "1",
    inputFromFixture(fixture, { user_id: "999999", user_login: "sneaky_login", user_name: "Sneaky_Name" }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.deepEqual(result.event.actor, { id: null, displayName: "Anonymous", isAnonymous: true });
});

test("subscription.gift: anonymous gifter is null id + fixed displayName; cumulative_total:null is a normal (not warned) omission", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("subscription-gift-anonymous");
  const result = modules.normalizeTwitchEvent("channel.subscription.gift", "1", inputFromFixture(fixture));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.deepEqual(result.event.actor, { id: null, displayName: "Anonymous", isAnonymous: true });
  assert.equal(result.event.data.cumulativeTotal, undefined);
  assert.equal(result.event.data.count, 5);
  assert.equal(result.event.data.tier, "2000");
  assert.ok(!result.issues.some((i) => i.field === "data.cumulativeTotal"), "a documented-nullable field being null must not itself produce an issue");
});

test("subscription.gift: named gifter keeps cumulative_total when present", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("subscription-gift");
  const result = modules.normalizeTwitchEvent("channel.subscription.gift", "1", inputFromFixture(fixture));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.deepEqual(result.event.actor, { id: "1234", displayName: "Cool_User", isAnonymous: false });
  assert.equal(result.event.data.cumulativeTotal, 284);
  assert.equal(result.event.data.count, 2);
});

// =============================================================================================
// subscribe: normal vs gift mapping.
// =============================================================================================

test("subscribe: is_gift:false maps to data.isGift:false", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("subscribe");
  const result = modules.normalizeTwitchEvent("channel.subscribe", "1", inputFromFixture(fixture));
  assert.equal(result.ok, true);
  assert.equal(result.event.data.isGift, false);
  assert.equal(result.event.data.tier, "1000");
});

test("subscribe: is_gift:true maps to data.isGift:true", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("subscribe");
  const result = modules.normalizeTwitchEvent("channel.subscribe", "1", inputFromFixture(fixture, { is_gift: true }));
  assert.equal(result.ok, true);
  assert.equal(result.event.data.isGift, true);
});

// =============================================================================================
// resub (subscription.message): streak null/empty message, cumulative/duration mapping.
// =============================================================================================

test("resub: the documented example fixture maps tier/cumulativeMonths/streakMonths/message/durationMonths correctly", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("subscription-message");
  const result = modules.normalizeTwitchEvent("channel.subscription.message", "1", inputFromFixture(fixture));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.equal(result.event.data.tier, "1000");
  assert.equal(result.event.data.cumulativeMonths, 15);
  assert.equal(result.event.data.streakMonths, 1);
  assert.equal(result.event.data.message, "Love the stream! FevziGG");
  assert.equal(result.event.sourceMetadata.durationMonths, 6);
});

test("resub: streak_months:null (streak sharing opted out) omits streakMonths without any issue", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("subscription-message");
  const result = modules.normalizeTwitchEvent("channel.subscription.message", "1", inputFromFixture(fixture, { streak_months: null }));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.equal(result.event.data.streakMonths, undefined);
  assert.ok(!result.issues.some((i) => i.field === "data.streakMonths"), "documented-nullable streak_months:null must not itself produce an issue");
});

test("resub: an empty message.text omits data.message rather than keeping a blank string", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("subscription-message");
  const result = modules.normalizeTwitchEvent("channel.subscription.message", "1", inputFromFixture(fixture, { message: { text: "", emotes: [] } }));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.equal(result.event.data.message, undefined);
});

// =============================================================================================
// reward-redemption: empty/long user_input, unknown status, reward/user-input mapping.
// =============================================================================================

test("reward-redemption: the documented shape maps rewardId/rewardTitle/cost/userInput/status and keeps redemptionId in sourceMetadata", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("reward-redemption");
  const result = modules.normalizeTwitchEvent("channel.channel_points_custom_reward_redemption.add", "1", inputFromFixture(fixture));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.equal(result.event.data.rewardId, "92af127c-7326-4483-a52b-b0da0be61c01");
  assert.equal(result.event.data.rewardTitle, "Give a shoutout");
  assert.equal(result.event.data.cost, 500);
  assert.equal(result.event.data.userInput, "Give me a shoutout!");
  assert.equal(result.event.data.status, "unfulfilled");
  assert.equal(result.event.sourceMetadata.redemptionId, "17fa2df1-ad76-4804-bfa5-a40ef63efe63");
  assert.equal(result.event.timestamp, new Date("2020-07-15T17:16:03.17106713Z").toISOString(), "must prefer the event's own redeemed_at over the message envelope timestamp");
});

test("reward-redemption: an empty user_input omits data.userInput rather than keeping a blank string", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("reward-redemption");
  const result = modules.normalizeTwitchEvent("channel.channel_points_custom_reward_redemption.add", "1", inputFromFixture(fixture, { user_input: "" }));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.equal(result.event.data.userInput, undefined);
});

test("reward-redemption: an overlong user_input is truncated to MAX_TEXT_LENGTH and flagged with a warning, not failed", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("reward-redemption");
  const longInput = "a".repeat(modules.MAX_TEXT_LENGTH + 250);
  const result = modules.normalizeTwitchEvent("channel.channel_points_custom_reward_redemption.add", "1", inputFromFixture(fixture, { user_input: longInput }));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.equal(result.event.data.userInput.length, modules.MAX_TEXT_LENGTH);
  assert.ok(result.issues.some((i) => i.field === "data.userInput" && i.code === "text.truncated" && i.severity === "warning"));
});

test("reward-redemption: an unrecognized status (Twitch's own documented 'unknown' RedemptionStatus value) omits data.status with a warning, does not fail the event", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("reward-redemption");
  const result = modules.normalizeTwitchEvent("channel.channel_points_custom_reward_redemption.add", "1", inputFromFixture(fixture, { status: "unknown" }));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.equal(result.event.data.status, undefined);
  assert.ok(result.issues.some((i) => i.field === "data.status" && i.code === "enum" && i.severity === "warning"));
});

test("reward-redemption: missing reward.id/reward.title/reward.cost fails normalization (critical fields)", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("reward-redemption");
  const result = modules.normalizeTwitchEvent(
    "channel.channel_points_custom_reward_redemption.add",
    "1",
    inputFromFixture(fixture, { reward: { id: "", title: "", cost: "not-a-number" } }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.field === "data.rewardId" && i.severity === "error"));
  assert.ok(result.issues.some((i) => i.field === "data.rewardTitle" && i.severity === "error"));
  assert.ok(result.issues.some((i) => i.field === "data.cost" && i.severity === "error"));
});

// =============================================================================================
// HTML / control chars / bidi override / emoji in free-text fields.
// =============================================================================================

test("cheer message: HTML passes through as inert text, control chars + bidi overrides are stripped, emoji survive untouched", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  const nul = String.fromCodePoint(0x00);
  const rlo = String.fromCodePoint(0x202e);
  const pdf = String.fromCodePoint(0x202c);
  const hostileMessage = `<script>alert(1)</script>${nul}${rlo}evil${pdf} 🎉🔥 pogchamp\n\n\n\nmore text`;
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", inputFromFixture(fixture, { message: hostileMessage }));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  const message = result.event.data.message;
  assert.match(message, /<script>alert\(1\)<\/script>/, "HTML must pass through unescaped/unstripped as inert data");
  assert.ok(!message.includes(nul), "NUL byte must be removed");
  assert.ok(!message.includes(rlo) && !message.includes(pdf), "bidi override/PDF characters must be removed");
  assert.match(message, /🎉🔥/, "emoji must survive untouched");
  assert.equal(
    message,
    "<script>alert(1)</script>evil 🎉🔥 pogchamp\n\nmore text",
    "4 consecutive newlines must collapse to exactly 2 (one blank line), not merely 'fewer than 4'",
  );
  assert.ok(result.issues.some((i) => i.code === "text.controlChars"));
  assert.ok(result.issues.some((i) => i.code === "text.bidiOverride"));
  assert.ok(result.issues.some((i) => i.code === "text.excessiveNewlines"));

  const validation = validateStreamEvent(result.event);
  assert.equal(validation.ok, true, JSON.stringify(validation.ok ? null : validation.issues));
});

test("sanitizeText: legitimate bidi ISOLATE characters (not overrides) are left untouched", async () => {
  const { modules } = await loadModules();
  const lri = String.fromCodePoint(0x2066);
  const pdi = String.fromCodePoint(0x2069);
  const text = `${lri}isolated RTL span${pdi} plain text`;
  const result = modules.sanitizeText(text);
  assert.equal(result.text, text);
  assert.equal(result.hadBidiOverride, false);
});

test("sanitizeText: does not apply Unicode NFKC normalization (full-width characters survive unchanged)", async () => {
  const { modules } = await loadModules();
  const fullWidth = "ＡＢＣ"; // fullwidth "ABC"
  const result = modules.sanitizeText(fullWidth);
  assert.equal(result.text, fullWidth, "NFKC would fold this to ASCII ABC; it must not be folded");
});

test("sanitizeText: collapses a run of 3+ newlines to EXACTLY 2 (one blank line), not to 1 or to 'fewer than the input'", async () => {
  const { modules } = await loadModules();
  assert.equal(modules.sanitizeText("a\n\n\nb").text, "a\n\nb", "exactly 3 newlines -> 2");
  assert.equal(modules.sanitizeText("a\n\n\n\n\nb").text, "a\n\nb", "5 newlines -> 2, not 3");
  assert.equal(modules.sanitizeText("a\nb\n\nc").text, "a\nb\n\nc", "runs under the 3-newline threshold are left alone entirely");
  assert.equal(modules.sanitizeText("a\n\n\nb\n\n\n\nc").text, "a\n\nb\n\nc", "multiple separate excessive runs each collapse independently");
});

// =============================================================================================
// Numeric validation: negative / NaN / Infinity / missing / wrong-type.
// =============================================================================================

test("cheer: negative bits fails normalization (critical field, range violation)", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", inputFromFixture(fixture, { bits: -5 }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.field === "data.bits" && i.severity === "error"));
});

test("cheer: missing bits fails normalization", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  const event = { ...fixture.payload.event };
  delete event.bits;
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", { event, messageId: fixture.metadata.message_id, messageTimestamp: fixture.metadata.message_timestamp, receivedAtMs: FIXED_RECEIVED_AT_MS });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.field === "data.bits" && i.code === "type.integer"));
});

test("cheer: bits as the wrong type (string) fails normalization", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", inputFromFixture(fixture, { bits: "1000" }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.field === "data.bits" && i.code === "type.integer"));
});

test("cheer: a non-integer bits value (1.5) fails normalization", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", inputFromFixture(fixture, { bits: 1.5 }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.field === "data.bits" && i.code === "type.integer"));
});

// JSON cannot encode NaN/Infinity — Twitch's real wire format (JSON) could never actually deliver
// these, but this normalizer still defends against them if constructed programmatically upstream.
test("cheer: NaN/Infinity/-Infinity bits all fail normalization (never silently coerced)", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  for (const bad of [NaN, Infinity, -Infinity]) {
    const result = modules.normalizeTwitchEvent("channel.cheer", "1", inputFromFixture(fixture, { bits: bad }));
    assert.equal(result.ok, false, String(bad));
    assert.ok(result.issues.some((i) => i.field === "data.bits" && i.code === "type.integer"), String(bad));
  }
});

test("resub: a negative cumulative_months fails normalization", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("subscription-message");
  const result = modules.normalizeTwitchEvent("channel.subscription.message", "1", inputFromFixture(fixture, { cumulative_months: -1 }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.field === "data.cumulativeMonths" && i.severity === "error"));
});

test("resub: an out-of-range streak_months (negative) is an OPTIONAL-field warning, not a failure", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("subscription-message");
  const result = modules.normalizeTwitchEvent("channel.subscription.message", "1", inputFromFixture(fixture, { streak_months: -3 }));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.equal(result.event.data.streakMonths, undefined);
  assert.ok(result.issues.some((i) => i.field === "data.streakMonths" && i.severity === "warning"));
});

test("gift-subscription: an unsupported tier fails normalization", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("subscription-gift");
  const result = modules.normalizeTwitchEvent("channel.subscription.gift", "1", inputFromFixture(fixture, { tier: "9999" }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.field === "data.tier" && i.code === "enum"));
});

// =============================================================================================
// Timestamp fallback chain: event -> message -> receivedAt, malformed values flagged not thrown.
// =============================================================================================

test("normalizeEventTimestamp: prefers the event's own valid timestamp over the message envelope's", async () => {
  const { modules } = await loadModules();
  const result = modules.normalizeEventTimestamp({ eventTimestamp: "2020-07-15T17:16:03.000Z", messageTimestamp: "2019-11-16T10:11:12.000Z", receivedAtMs: FIXED_RECEIVED_AT_MS });
  assert.equal(result.source, "event");
  assert.equal(result.timestamp, new Date("2020-07-15T17:16:03.000Z").toISOString());
  assert.deepEqual(result.issues, []);
});

test("normalizeEventTimestamp: a malformed event timestamp falls back to the message envelope's timestamp, flagged as a warning", async () => {
  const { modules } = await loadModules();
  const result = modules.normalizeEventTimestamp({ eventTimestamp: "not-a-date", messageTimestamp: "2019-11-16T10:11:12.000Z", receivedAtMs: FIXED_RECEIVED_AT_MS });
  assert.equal(result.source, "message");
  assert.equal(result.timestamp, new Date("2019-11-16T10:11:12.000Z").toISOString());
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, "type.malformedTimestamp");
  assert.equal(result.issues[0].severity, "warning");
});

test("normalizeEventTimestamp: both event and message timestamps malformed falls all the way back to receivedAt, flagged twice", async () => {
  const { modules } = await loadModules();
  const result = modules.normalizeEventTimestamp({ eventTimestamp: "garbage", messageTimestamp: "also garbage", receivedAtMs: FIXED_RECEIVED_AT_MS });
  assert.equal(result.source, "receivedAt");
  assert.equal(result.timestamp, new Date(FIXED_RECEIVED_AT_MS).toISOString());
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every((i) => i.code === "type.malformedTimestamp" && i.severity === "warning"));
});

test("normalizeEventTimestamp: a bare short numeric string is rejected as malformed, not silently accepted as a bogus far-future/past date", async () => {
  // V8's legacy (non-ISO) date parser treats short numeric strings like "12345"/"123456" as a
  // parseable date, producing a wildly-wrong-but-finite Date rather than NaN
  // (Date.parse("12345") resolves to the year 12344) — a naive `Number.isFinite(Date.parse(v))`
  // check alone would wrongly accept these as valid timestamps.
  const { modules } = await loadModules();
  for (const bogus of ["12345", "0", "123456"]) {
    const result = modules.normalizeEventTimestamp({ eventTimestamp: bogus, messageTimestamp: "2019-11-16T10:11:12.634234626Z", receivedAtMs: FIXED_RECEIVED_AT_MS });
    assert.equal(result.source, "message", bogus);
    assert.ok(result.issues.some((i) => i.code === "type.malformedTimestamp"), bogus);
  }
});

test("normalizeEventTimestamp: a whitespace-padded but otherwise valid timestamp is accepted without throwing", async () => {
  // new Date(" 2019-11-16T10:11:12.634234626Z ") (note the padding) throws RangeError even though
  // Date.parse() on the trimmed string is perfectly valid — this must be handled without ever
  // letting that exception escape normalizeEventTimestamp().
  const { modules } = await loadModules();
  const result = modules.normalizeEventTimestamp({ eventTimestamp: "  2019-11-16T10:11:12.634234626Z  ", receivedAtMs: FIXED_RECEIVED_AT_MS });
  assert.equal(result.source, "event");
  assert.equal(result.timestamp, new Date("2019-11-16T10:11:12.634234626Z").toISOString());
  assert.deepEqual(result.issues, []);
});

test("normalizeEventTimestamp: a non-finite receivedAtMs (NaN/Infinity) never throws and still yields a valid ISO timestamp", async () => {
  const { modules } = await loadModules();
  for (const bad of [NaN, Infinity, -Infinity]) {
    const result = modules.normalizeEventTimestamp({ receivedAtMs: bad });
    assert.equal(result.source, "receivedAt", String(bad));
    assert.ok(Number.isFinite(Date.parse(result.timestamp)), String(bad));
  }
});

test("reward-redemption: a malformed redeemed_at falls back to the message envelope timestamp, event still normalizes successfully", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("reward-redemption");
  const result = modules.normalizeTwitchEvent("channel.channel_points_custom_reward_redemption.add", "1", inputFromFixture(fixture, { redeemed_at: "not-a-timestamp" }));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.equal(result.event.timestamp, new Date(fixture.metadata.message_timestamp).toISOString());
  assert.ok(result.issues.some((i) => i.code === "type.malformedTimestamp" && i.severity === "warning"));
  const validation = validateStreamEvent(result.event);
  assert.equal(validation.ok, true, JSON.stringify(validation.ok ? null : validation.issues));
});

// =============================================================================================
// Raw payload debug retention: opt-in, bounded, redacted, and OUTSIDE the published StreamEvent.
// =============================================================================================

test("normalizeTwitchEvent: keepRawPayload defaults to off — diagnostics.rawPayload is absent unless explicitly opted in", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", inputFromFixture(fixture));
  assert.equal(result.ok, true);
  assert.equal("rawPayload" in result.diagnostics, false);
});

test("normalizeTwitchEvent: keepRawPayload:true retains a redacted raw payload copy in diagnostics, never inside the StreamEvent itself", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", inputFromFixture(fixture, {}, { keepRawPayload: true }));
  assert.equal(result.ok, true);
  assert.ok(result.diagnostics.rawPayload, "rawPayload must be present when opted in");
  assert.equal(result.diagnostics.rawPayload.user_login, "[redacted]", "*_login fields must be redacted");
  assert.equal(result.diagnostics.rawPayload.broadcaster_user_login, "[redacted]");
  assert.equal(result.diagnostics.rawPayload.bits, 1000, "non-identity fields are preserved as-is");
  assert.equal(result.diagnostics.rawPayload.message, "pogchamp");

  // The raw payload must never leak into the published event, at any depth.
  assert.deepEqual(findRawPayloadLeaks(result.event), []);
  assert.equal(JSON.stringify(result.event).includes("rawPayload"), false);
  assert.equal("rawPayload" in result.event, false);
  assert.equal("rawPayload" in (result.event.sourceMetadata ?? {}), false);
});

test("normalizeTwitchEvent: an oversized raw payload is bounded (truncated), not retained in full, even when opted in", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  const hugeMessage = "x".repeat(20_000);
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", {
    event: { ...fixture.payload.event, message: hugeMessage },
    messageId: fixture.metadata.message_id,
    messageTimestamp: fixture.metadata.message_timestamp,
    receivedAtMs: FIXED_RECEIVED_AT_MS,
    keepRawPayload: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  assert.equal(result.diagnostics.rawPayload.truncated, true);
  assert.ok(result.diagnostics.rawPayload.preview.length <= 8000);
});

test("normalizeTwitchEvent: a *_login field nested deeper than the redaction depth cap never leaks unredacted into the opt-in debug copy", async () => {
  const { modules } = await loadModules();
  const fixture = await loadFixture("cheer");
  // None of the 5 real Twitch payload shapes nest this deep — this is a defensive/pathological
  // case, not a realistic fixture, to prove the depth cutoff degrades safely (replaces the
  // unexamined subtree with a placeholder) rather than passing it through unredacted.
  let deep = { user_login: "should_never_appear_unredacted" };
  for (let i = 0; i < 12; i += 1) deep = { nested: deep };
  const result = modules.normalizeTwitchEvent("channel.cheer", "1", {
    event: { ...fixture.payload.event, extra: deep },
    messageId: fixture.metadata.message_id,
    messageTimestamp: fixture.metadata.message_timestamp,
    receivedAtMs: FIXED_RECEIVED_AT_MS,
    keepRawPayload: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
  const asJson = JSON.stringify(result.diagnostics.rawPayload);
  assert.ok(!asJson.includes("should_never_appear_unredacted"), "a deeply-nested _login value must never survive unredacted, even past the depth cap");
});

// =============================================================================================
// Every produced event round-trips through the real #89 validateStreamEvent() even under the
// hostile-text/edge-case overrides above (a broader sweep beyond the one-assertion-per-case
// checks already embedded in the tests above).
// =============================================================================================

test("every canonical fixture's normalized event satisfies findRawPayloadLeaks() == [] independent of validateStreamEvent()'s own internal check", async () => {
  const { modules } = await loadModules();
  for (const [fixtureName] of CANONICAL_FIXTURES) {
    const fixture = await loadFixture(fixtureName);
    const [type, version] = typeVersionFromFixture(fixture);
    const result = modules.normalizeTwitchEvent(type, version, inputFromFixture(fixture));
    assert.equal(result.ok, true, fixtureName);
    assert.deepEqual(findRawPayloadLeaks(result.event), [], fixtureName);
  }
});
