// Issue #89: runtime validation for the StreamEvent discriminated union defined in contract.js.
// Mirrors src/config/config-validation.js's shape (a single `validate*(candidate) -> {ok, issues}`
// function built from the same structured `issue()` helper) rather than pulling in a general
// schema library — this repo's own established "pure function + structured issue list" style.
import {
  CURRENT_SCHEMA_VERSION,
  STREAM_EVENT_KINDS,
  SUBSCRIPTION_TIERS,
  failureResult,
  findRawPayloadLeaks,
  issue,
  successResult,
} from "./contract.js";

const REWARD_REDEMPTION_STATUSES = Object.freeze(["fulfilled", "unfulfilled", "canceled"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isValidTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function validateActor(actor, issues) {
  if (!isPlainObject(actor)) { issues.push(issue(["actor"], "type.object", "actor must be an object")); return; }
  if (typeof actor.isAnonymous !== "boolean") issues.push(issue(["actor", "isAnonymous"], "type.boolean", "actor.isAnonymous must be a boolean"));
  if (!isNonEmptyString(actor.displayName)) issues.push(issue(["actor", "displayName"], "required", "actor.displayName is required"));
  if (actor.id !== null && actor.id !== undefined && typeof actor.id !== "string") {
    issues.push(issue(["actor", "id"], "type.string", "actor.id must be a string or null"));
  } else if (actor.isAnonymous !== true && !isNonEmptyString(actor.id)) {
    issues.push(issue(["actor", "id"], "required", "actor.id is required unless actor.isAnonymous is true"));
  }
}

function validateChannel(channel, issues) {
  if (!isPlainObject(channel)) { issues.push(issue(["channel"], "type.object", "channel must be an object")); return; }
  if (!isNonEmptyString(channel.id)) issues.push(issue(["channel", "id"], "required", "channel.id is required"));
  if (!isNonEmptyString(channel.displayName)) issues.push(issue(["channel", "displayName"], "required", "channel.displayName is required"));
}

function validateSourceMetadata(sourceMetadata, issues) {
  if (sourceMetadata === undefined) return;
  if (!isPlainObject(sourceMetadata)) issues.push(issue(["sourceMetadata"], "type.object", "sourceMetadata must be an object when present"));
}

function validateTier(data, issues, path) {
  if (!SUBSCRIPTION_TIERS.includes(data?.tier)) issues.push(issue([...path, "tier"], "enum", "data.tier is not a supported subscription tier", { meta: { options: SUBSCRIPTION_TIERS } }));
}

function validateKindData(kind, data, issues) {
  const path = ["data"];
  if (!isPlainObject(data)) { issues.push(issue(path, "type.object", `"${kind}" events require a data object`)); return; }
  switch (kind) {
    case "cheer": {
      if (!isFiniteNumber(data.bits) || data.bits <= 0) issues.push(issue([...path, "bits"], "type.positiveNumber", "data.bits must be a positive number"));
      if (data.message !== undefined && typeof data.message !== "string") issues.push(issue([...path, "message"], "type.string", "data.message must be a string"));
      break;
    }
    case "subscription": {
      validateTier(data, issues, path);
      if (data.isGift !== undefined && typeof data.isGift !== "boolean") issues.push(issue([...path, "isGift"], "type.boolean", "data.isGift must be a boolean"));
      break;
    }
    case "resub": {
      validateTier(data, issues, path);
      if (!isPositiveInteger(data.cumulativeMonths)) issues.push(issue([...path, "cumulativeMonths"], "type.positiveInteger", "data.cumulativeMonths must be a positive integer"));
      if (data.streakMonths !== undefined && !isNonNegativeInteger(data.streakMonths)) issues.push(issue([...path, "streakMonths"], "type.nonNegativeInteger", "data.streakMonths must be a non-negative integer"));
      if (data.message !== undefined && typeof data.message !== "string") issues.push(issue([...path, "message"], "type.string", "data.message must be a string"));
      break;
    }
    case "gift-subscription": {
      validateTier(data, issues, path);
      if (!isPositiveInteger(data.count)) issues.push(issue([...path, "count"], "type.positiveInteger", "data.count must be a positive integer"));
      if (data.cumulativeTotal !== undefined && !isNonNegativeInteger(data.cumulativeTotal)) issues.push(issue([...path, "cumulativeTotal"], "type.nonNegativeInteger", "data.cumulativeTotal must be a non-negative integer"));
      break;
    }
    case "reward-redemption": {
      if (!isNonEmptyString(data.rewardId)) issues.push(issue([...path, "rewardId"], "required", "data.rewardId is required"));
      if (!isNonEmptyString(data.rewardTitle)) issues.push(issue([...path, "rewardTitle"], "required", "data.rewardTitle is required"));
      if (!isNonNegativeInteger(data.cost)) issues.push(issue([...path, "cost"], "type.nonNegativeInteger", "data.cost must be a non-negative integer"));
      if (data.userInput !== undefined && typeof data.userInput !== "string") issues.push(issue([...path, "userInput"], "type.string", "data.userInput must be a string"));
      if (data.status !== undefined && !REWARD_REDEMPTION_STATUSES.includes(data.status)) issues.push(issue([...path, "status"], "enum", "data.status is not supported", { meta: { options: REWARD_REDEMPTION_STATUSES } }));
      break;
    }
    default:
      break;
  }
}

/** Validates a candidate value against the StreamEvent discriminated union: base fields
 * (schemaVersion/id/kind/timestamp/actor/channel/sourceMetadata), the per-`kind` `data` shape, AND
 * (per issue #89's "raw payloadをbusへ入れないruntime guard") that no field anywhere in the
 * candidate looks like a raw platform-payload escape hatch. A future (> CURRENT_SCHEMA_VERSION)
 * schemaVersion is a WARNING, not a hard failure — see contract.js's own doc comment on
 * CURRENT_SCHEMA_VERSION for why. Never throws. */
export function validateStreamEvent(candidate) {
  const issues = [];
  if (!isPlainObject(candidate)) return failureResult([issue([], "type.object", "stream event must be an object")], candidate);

  if (typeof candidate.schemaVersion !== "number" || !Number.isInteger(candidate.schemaVersion) || candidate.schemaVersion < 1) {
    issues.push(issue(["schemaVersion"], "type.positiveInteger", "schemaVersion must be a positive integer"));
  } else if (candidate.schemaVersion > CURRENT_SCHEMA_VERSION) {
    issues.push(issue(["schemaVersion"], "version.future", `schemaVersion ${candidate.schemaVersion} is newer than this build supports (${CURRENT_SCHEMA_VERSION})`, { severity: "warning" }));
  }

  if (!isNonEmptyString(candidate.id)) issues.push(issue(["id"], "required", "id is required"));
  if (!STREAM_EVENT_KINDS.includes(candidate.kind)) issues.push(issue(["kind"], "enum", "kind is not a supported StreamEvent kind", { meta: { options: STREAM_EVENT_KINDS } }));
  if (!isValidTimestamp(candidate.timestamp)) issues.push(issue(["timestamp"], "type.isoTimestamp", "timestamp must be an ISO-8601 string"));

  validateActor(candidate.actor, issues);
  validateChannel(candidate.channel, issues);
  validateSourceMetadata(candidate.sourceMetadata, issues);
  if (STREAM_EVENT_KINDS.includes(candidate.kind)) validateKindData(candidate.kind, candidate.data, issues);

  for (const leakPath of findRawPayloadLeaks(candidate)) {
    issues.push(issue(leakPath.split("."), "forbidden.rawPayload", `field "${leakPath}" looks like a raw platform-payload escape hatch and is not allowed on a StreamEvent`));
  }

  const errors = issues.filter((entry) => entry.severity === "error");
  return errors.length ? failureResult(issues, candidate) : successResult(candidate, issues);
}
