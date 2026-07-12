// Issue #89: pure-JS `StreamEvent` domain contract. Mirrors src/config/config-contract.js's own
// split (this file = constants + structured-issue/result helpers; ./schemas.js = the actual
// validation logic; ./display.js = pure UI formatting) so #91-93's future trigger/action/UI
// consumers under src/ can import this the same way src/*.js already imports src/config/*.js.
//
// `StreamEvent` itself must stay Twitch-vocabulary-free ("Twitch固有payloadから独立した") — every
// field name here is generic domain vocabulary, never Twitch's own EventSub field/type names.
// See eventsub-message-parser.ts / desired-subscriptions.ts (#86/#87) for the 5 real Twitch
// EventSub subscription types this abstraction sits in front of (channel.cheer,
// channel.subscribe, channel.subscription.message, channel.subscription.gift,
// channel.channel_points_custom_reward_redemption.add) — #90 (a later issue) is what actually
// normalizes those raw payloads into the `StreamEvent`s defined here.

/** Bumped only for a breaking change to the StreamEvent shape. A newer schemaVersion than this
 * build knows about is accepted with a warning (forward compat for older subscriber builds), not
 * rejected outright — see schemas.js's future-version handling. */
export const CURRENT_SCHEMA_VERSION = 1;

/** The 5 domain event kinds — one per Twitch EventSub subscription type in this sub-epic's scope,
 * named with generic vocabulary instead of Twitch's own type strings. */
export const STREAM_EVENT_KINDS = Object.freeze([
  "cheer",
  "subscription",
  "resub",
  "gift-subscription",
  "reward-redemption",
]);

/** Twitch's own sub tier strings (1000/2000/3000 = Tier 1/2/3, "prime" = Prime Gaming sub) —
 * these are values, not vocabulary, so reusing Twitch's literal tier strings here is not a
 * violation of the "Twitch-vocabulary-free" rule (the rule is about field/type naming). */
export const SUBSCRIPTION_TIERS = Object.freeze(["1000", "2000", "3000", "prime"]);

/** Structured issue shape, mirroring src/config/config-contract.js's own `issue()` one-for-one for
 * consistency across this repo's two schema/validation layers. */
export const issue = (path, code, message, { severity = "error", meta = {} } = {}) =>
  Object.freeze({
    path: Object.freeze(Array.isArray(path) ? [...path] : String(path).split(".").filter(Boolean)),
    code,
    message,
    severity,
    meta: Object.freeze({ ...meta }),
  });

export const successResult = (event, issues = []) => Object.freeze({ ok: true, event, issues: Object.freeze([...issues]) });
export const failureResult = (issues, input = null) => Object.freeze({ ok: false, issues: Object.freeze([...issues]), input });

// -------------------------------------------------------------------------------------------
// Raw-payload escape-hatch guard ("raw payloadをbusへ入れないruntime guard").
//
// A StreamEvent must never carry a field shaped like Twitch's own EventSub envelope
// (`{ metadata, payload }`) or a generic "here's the original platform payload" escape hatch —
// even nested a few levels deep inside `sourceMetadata`'s otherwise-opaque bag, which is the most
// likely place a future normalizer bug would try to smuggle the whole raw notification through.
// Checked recursively (bounded depth) rather than only at the top level for that reason.
// -------------------------------------------------------------------------------------------

const FORBIDDEN_KEY_EXACT = new Set([
  "raw",
  "rawpayload",
  "rawevent",
  "rawdata",
  "rawnotification",
  "rawjson",
  "rawbody",
  "rawmessage",
  "payload",
  "originalpayload",
  "sourcepayload",
  "twitchpayload",
  "eventsubpayload",
]);

/** True for any key name that looks like a "here is the original platform payload" escape hatch:
 * an exact match against the well-known names above, OR anything starting with "raw" once
 * separators are stripped (catches `rawTwitchPayload`, `raw_body`, `RAW-DATA`, etc.). */
export function isForbiddenRawPayloadKey(key) {
  const normalized = String(key).toLowerCase().replace(/[-_\s]/g, "");
  return FORBIDDEN_KEY_EXACT.has(normalized) || normalized.startsWith("raw");
}

/** Twitch notification payloads are shallow (a handful of levels); this is generous headroom
 * against a pathological input while still bounding recursion cost. */
const MAX_RAW_PAYLOAD_SCAN_DEPTH = 12;

/** Recursively walks `value` and returns the dotted-path of every key that looks like a raw
 * platform-payload escape hatch, at any depth (including inside `sourceMetadata`). Empty array
 * means the value is clean. Never throws — a malformed/cyclical-looking input just stops at the
 * depth limit rather than blowing the stack. */
export function findRawPayloadLeaks(value, path = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > MAX_RAW_PAYLOAD_SCAN_DEPTH) return [];
  const leaks = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => leaks.push(...findRawPayloadLeaks(item, [...path, index], depth + 1)));
    return leaks;
  }
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (isForbiddenRawPayloadKey(key)) leaks.push(nextPath.join("."));
    leaks.push(...findRawPayloadLeaks(nested, nextPath, depth + 1));
  }
  return leaks;
}
