// Issue #91: EventTriggerConfig shape + `all`/`any` condition-group vocabulary for StreamEvent
// (#89) triggers. Mirrors src/stream-events/contract.js's own split (this file = constants +
// structured-issue/result helpers + shape predicates; ./trigger-validation.js = the actual
// save-time validation logic; ./event-trigger-matcher.js = runtime evaluation) — the same
// "contract vs validation vs runtime" layering this repo already uses for src/config/* and
// src/stream-events/*.
//
// An EventTriggerConfig is a named rule:
//   {
//     id: string,
//     enabled: boolean,
//     eventTypes: string[],       // subset of STREAM_EVENT_KINDS this trigger applies to
//     priority: number,           // higher fires first; see event-trigger-matcher.js's sort
//     stopPropagation: boolean,   // true: a match here prevents lower-priority triggers matching
//     condition: ConditionNode,   // { all: ConditionNode[] } | { any: ConditionNode[] } | Leaf
//   }
// A ConditionNode is either a group (`{ all: [...] }` XOR `{ any: [...] }`, nestable) or a leaf
// (`{ field, operator, value }`, `field` drawn from event-field-registry.js's fixed allow-list).
//
// This module is deliberately standalone from src/trigger-engine.js (the EXISTING keyword/hotkey/
// interval/random/manual dispatcher) — see event-trigger-matcher.js's own header comment for why.

export const CURRENT_EVENT_TRIGGER_SCHEMA_VERSION = 1;

export const DEFAULT_ENABLED = true;
export const DEFAULT_PRIORITY = 0;
export const DEFAULT_STOP_PROPAGATION = false;

/** A condition tree may nest `all`/`any` groups up to this many levels deep — generous headroom
 * for any realistic hand-authored trigger while still bounding recursion cost (both
 * trigger-validation.js's walk and event-trigger-matcher.js's evaluateCondition()) against a
 * pathological/attacker-editable config file. */
export const MAX_CONDITION_DEPTH = 8;

/** Safety bound on how many triggers may MATCH (and therefore, later in #92, act on) a single
 * incoming StreamEvent — protects against a large/misconfigured trigger list producing an
 * unbounded burst of matches for one event. Doubles as this issue's "max triggers/actions per
 * event" cap; #92 (not yet implemented) is what actually dispatches an action per match. */
export const DEFAULT_MAX_MATCHES_PER_EVENT = 5;

export const CONDITION_GROUP_KEYS = Object.freeze(["all", "any"]);
export const LEAF_CONDITION_KEYS = Object.freeze(["field", "operator", "value"]);

/** Structured issue shape, mirroring src/stream-events/contract.js's / src/config/
 * config-contract.js's own `issue()` one-for-one for consistency across this repo's schema/
 * validation layers. */
export const issue = (path, code, message, { severity = "error", meta = {} } = {}) =>
  Object.freeze({
    path: Object.freeze(Array.isArray(path) ? [...path] : String(path).split(".").filter(Boolean)),
    code,
    message,
    severity,
    meta: Object.freeze({ ...meta }),
  });

export const successResult = (config, issues = []) => Object.freeze({ ok: true, config, issues: Object.freeze([...issues]) });
export const failureResult = (issues, input = null) => Object.freeze({ ok: false, issues: Object.freeze([...issues]), input });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True for a `{ all: [...] }` or `{ any: [...] }` condition-GROUP node shape (presence check
 * only — does not verify it isn't ALSO carrying the other key; trigger-validation.js rejects that
 * ambiguous shape explicitly). Shared identically by trigger-validation.js and
 * event-trigger-matcher.js so both walk the same tree shape the same way. */
export function isConditionGroupNode(node) {
  return isPlainObject(node) && (Array.isArray(node.all) || Array.isArray(node.any));
}

/** True for a `{ field, operator, value }` condition-LEAF node shape (shape-only check — does NOT
 * verify `field`/`operator`/`value` are actually registered/type-matched; that is
 * trigger-validation.js's job, using event-field-registry.js). */
export function isConditionLeafNode(node) {
  return isPlainObject(node) && typeof node.field === "string" && typeof node.operator === "string" && "value" in node;
}

/** Builds an EventTriggerConfig with this schema's defaults applied — mirrors src/config/
 * config-defaults.js's own "spread partial over defaults" style. Performs NO validation; pair
 * with trigger-validation.js's validateEventTriggerConfig() before persisting/matching. */
export function createEventTriggerConfig(partial = {}) {
  return {
    id: partial.id,
    enabled: partial.enabled ?? DEFAULT_ENABLED,
    eventTypes: Array.isArray(partial.eventTypes) ? [...partial.eventTypes] : [],
    priority: partial.priority ?? DEFAULT_PRIORITY,
    stopPropagation: partial.stopPropagation ?? DEFAULT_STOP_PROPAGATION,
    condition: partial.condition ?? { all: [] },
  };
}
