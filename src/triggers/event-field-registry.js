// Issue #91: fixed allow-list registry of which StreamEvent (#89) fields an EventTriggerConfig
// condition may reference, per event kind. This is the ONLY way a condition's `field` key ever
// resolves to an actual value on a live event — every entry below carries its own hardcoded getter
// closure (`(event) => event?.data?.bits`, etc.), so resolving a field is always a fixed, direct
// property read. There is deliberately NO generic dot-path-string-walking helper anywhere in this
// module (e.g. `key.split(".").reduce((o,k)=>o[k], event)`) that could be handed an
// attacker/user-editable key like `"__proto__.polluted"` or `"constructor.prototype.x"` and reach
// into prototype internals — an unregistered key (including any of those) simply isn't a key in
// `FIELD_BY_KEY`, so it resolves to `null`/`undefined` and is rejected by trigger-validation.js
// before it can ever reach match time (see event-trigger-matcher.js's resolveFieldValue() call).
//
// Field-name note: this issue's own Japanese task text paraphrases the target fields as
// "bits/tier/isGift/total/reward ID/cost/anonymous/message/userInput", but the REAL field names on
// a validated StreamEvent (src/stream-events/{contract,schemas}.js, confirmed against #90's
// normalizers under electron/main/services/twitch/events/normalizers/*.ts) differ in two places:
//   - "total" is StreamEvent's `data.count` (gift-subscription's normalizer explicitly renames
//     Twitch's own `total` wire field to `count` — see subscription-gift.ts's own comment).
//   - "reward ID/cost" are FLAT `data.rewardId` / `data.cost` on StreamEvent, not a nested
//     `reward.id`/`reward.cost` object (Twitch's own nested `reward.{id,cost,title}` payload gets
//     flattened by reward-redemption.ts's normalizer).
//   - "anonymous" is `actor.isAnonymous` (a base StreamEvent field present on every kind, not a
//     per-kind `data` field) — see schemas.js's validateActor().
// The registry below uses the REAL names throughout, not the issue text's paraphrase.
import { STREAM_EVENT_KINDS } from "../stream-events/contract.js";

/** The 3 primitive value types a registered field may hold. Every operator set below is derived
 * purely from this type, per the issue's "event typeごとの許可field/operator/value typeをregistry
 * 化" instruction — no per-field operator overrides, keeping the allow-list simple to audit. */
export const FIELD_VALUE_TYPES = Object.freeze(["number", "string", "boolean"]);

export const OPERATORS_BY_TYPE = Object.freeze({
  number: Object.freeze(["eq", "gt", "gte", "lt", "lte", "in", "between"]),
  string: Object.freeze(["eq", "contains", "in"]),
  boolean: Object.freeze(["eq"]),
});

const ALL_KINDS = STREAM_EVENT_KINDS;

function defineField(key, type, kinds, get) {
  return Object.freeze({ key, type, kinds: Object.freeze([...kinds]), operators: OPERATORS_BY_TYPE[type], get });
}

// Base fields present on every StreamEvent kind (actor/channel), followed by each kind's own
// `data` fields, grouped and commented per kind for traceability against schemas.js's
// validateKindData()/the normalizers.
const FIELD_DEFINITIONS = Object.freeze([
  // -- base fields (all 5 kinds) --
  defineField("actor.isAnonymous", "boolean", ALL_KINDS, (event) => event?.actor?.isAnonymous),
  defineField("actor.displayName", "string", ALL_KINDS, (event) => event?.actor?.displayName),
  defineField("actor.id", "string", ALL_KINDS, (event) => event?.actor?.id),
  defineField("channel.id", "string", ALL_KINDS, (event) => event?.channel?.id),
  defineField("channel.displayName", "string", ALL_KINDS, (event) => event?.channel?.displayName),

  // -- cheer: { bits, message? } --
  defineField("data.bits", "number", ["cheer"], (event) => event?.data?.bits),

  // -- cheer + resub both carry an optional free-text `data.message` string --
  defineField("data.message", "string", ["cheer", "resub"], (event) => event?.data?.message),

  // -- subscription/resub/gift-subscription all carry `data.tier` (Twitch tier strings) --
  defineField("data.tier", "string", ["subscription", "resub", "gift-subscription"], (event) => event?.data?.tier),

  // -- subscription: { tier, isGift? } --
  defineField("data.isGift", "boolean", ["subscription"], (event) => event?.data?.isGift),

  // -- resub: { tier, cumulativeMonths, streakMonths?, message? } --
  defineField("data.cumulativeMonths", "number", ["resub"], (event) => event?.data?.cumulativeMonths),
  defineField("data.streakMonths", "number", ["resub"], (event) => event?.data?.streakMonths),

  // -- gift-subscription: { tier, count, cumulativeTotal? } (Twitch's own `total` -> `count`) --
  defineField("data.count", "number", ["gift-subscription"], (event) => event?.data?.count),
  defineField("data.cumulativeTotal", "number", ["gift-subscription"], (event) => event?.data?.cumulativeTotal),

  // -- reward-redemption: { rewardId, rewardTitle, cost, userInput?, status? } --
  defineField("data.rewardId", "string", ["reward-redemption"], (event) => event?.data?.rewardId),
  defineField("data.rewardTitle", "string", ["reward-redemption"], (event) => event?.data?.rewardTitle),
  defineField("data.cost", "number", ["reward-redemption"], (event) => event?.data?.cost),
  defineField("data.userInput", "string", ["reward-redemption"], (event) => event?.data?.userInput),
  defineField("data.status", "string", ["reward-redemption"], (event) => event?.data?.status),
]);

const FIELD_BY_KEY = new Map(FIELD_DEFINITIONS.map((entry) => [entry.key, entry]));

/** Every registered field key, in definition order — the complete allow-list surface (e.g. for a
 * config-authoring UI's field picker). */
export const EVENT_FIELD_KEYS = Object.freeze(FIELD_DEFINITIONS.map((entry) => entry.key));

/** Looks up a field's registry definition by its exact key. Returns `null` for ANY key not
 * literally present in the fixed allow-list above — including prototype-shaped keys like
 * `"__proto__"` or `"constructor"`, which are simply absent from `FIELD_BY_KEY` and never treated
 * specially (a `Map` has no prototype-chain lookup surprises the way a plain object does). */
export function getFieldDefinition(key) {
  if (typeof key !== "string") return null;
  return FIELD_BY_KEY.get(key) ?? null;
}

/** True if `key` is a registered field AND valid for the single event kind `kind`. */
export function isFieldValidForKind(key, kind) {
  const definition = getFieldDefinition(key);
  return Boolean(definition && definition.kinds.includes(kind));
}

/** True if `key` is a registered field valid for AT LEAST ONE of `kinds` — used by
 * trigger-validation.js to allow a condition leaf inside an `any` group to target just one of a
 * multi-kind trigger's event types (e.g. `eventTypes: ["cheer","subscription"]` with an `any`
 * group containing one cheer-only leaf and one subscription-only leaf). */
export function isFieldValidForAnyKind(key, kinds) {
  const definition = getFieldDefinition(key);
  if (!definition) return false;
  return (Array.isArray(kinds) ? kinds : []).some((kind) => definition.kinds.includes(kind));
}

/** The operator allow-list for a field, derived from its value type. Empty array for an
 * unregistered field (so a caller can safely check `.includes(operator)` without a null guard). */
export function operatorsForField(key) {
  return getFieldDefinition(key)?.operators ?? Object.freeze([]);
}

/** Resolves a condition leaf's actual value from a StreamEvent using ONLY this fixed registry's
 * own getter closure for `key` — never a generic/dynamic property-path traversal. Returns
 * `undefined` for an unregistered key or if the getter itself throws (defensive; none of the
 * getters above can throw against a well-formed event, but a malformed one must never crash the
 * matcher). */
export function resolveFieldValue(key, event) {
  const definition = getFieldDefinition(key);
  if (!definition) return undefined;
  try {
    return definition.get(event);
  } catch {
    return undefined;
  }
}
