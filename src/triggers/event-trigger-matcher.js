// Issue #91: runtime matcher — decides WHICH EventTriggerConfigs match a single incoming
// StreamEvent, and WHY (or why not). Applies, in order: a coarse enabled/eventType pre-filter,
// priority-descending + stable config-order sort, full `all`/`any` condition-tree evaluation with
// per-leaf failed-reason collection, `stopPropagation`, and a `maxMatchesPerEvent` safety cap.
//
// Deliberately standalone: this module is never imported by src/trigger-engine.js (the EXISTING
// keyword/hotkey/interval/random/manual dispatcher, issue #7) and never imports it either — no
// branching is added to that file's `handleComment()`/`fire()`/`start()` dispatch logic. #92 (a
// later, not-yet-implemented issue) is what wires a StreamEvent trigger match into the actual
// response/action pipeline; this module only decides match/skip + reasons, and is fully testable
// in isolation from both the existing engine and any future action dispatcher.
import { getFieldDefinition, resolveFieldValue } from "./event-field-registry.js";
import { DEFAULT_MAX_MATCHES_PER_EVENT, DEFAULT_PRIORITY, isConditionGroupNode, isConditionLeafNode } from "./event-trigger-schema.js";

function compareValues(operator, actual, expected) {
  switch (operator) {
    case "eq":
      return actual === expected;
    case "gt":
      return typeof actual === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && actual <= expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "between":
      return typeof actual === "number" && Array.isArray(expected) && expected.length === 2 && actual >= expected[0] && actual <= expected[1];
    case "contains":
      return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    default:
      return false;
  }
}

/** Evaluates one `{ field, operator, value }` leaf against `event`, returning a full diagnostic
 * detail (not just a boolean) for the trace. A field that isn't registered for `event.kind` (e.g.
 * a `data.bits` leaf inside an `any` group, evaluated against a `subscription` event) is a normal
 * non-match — "field-not-applicable" — not an error; save-time validation (trigger-validation.js)
 * already guarantees the field is valid for AT LEAST ONE of the trigger's configured eventTypes,
 * which is enough to support a leaf that only applies to some of them (an intentional
 * cross-kind-OR pattern). A missing/null actual value (an unset optional field, e.g.
 * `data.message`) is also a normal non-match, distinguished as "value-missing" so a trace can tell
 * "field doesn't apply to this event" apart from "field applies but has no value" apart from
 * "field has a value that just didn't match". */
function evaluateLeaf(node, event) {
  const definition = getFieldDefinition(node.field);
  const base = { field: node.field, operator: node.operator, expected: node.value };
  if (!definition || !definition.kinds.includes(event?.kind)) {
    return { ...base, passed: false, actual: undefined, reason: "field-not-applicable" };
  }
  const actual = resolveFieldValue(node.field, event);
  if (actual === undefined || actual === null) {
    return { ...base, passed: false, actual, reason: "value-missing" };
  }
  const passed = compareValues(node.operator, actual, node.value);
  return { ...base, passed, actual, reason: passed ? undefined : "value-mismatch" };
}

/** Recursively evaluates a condition node against `event`. Returns `{ passed, details }` where
 * `details` is a FLAT array of every leaf evaluation encountered anywhere in the tree (both
 * passing and failing) — the matcher folds this into a MatchResult's failed-reason trace. Never
 * throws: a malformed node (shouldn't happen after save-time validation, but the matcher is
 * defensive regardless) evaluates to `passed:false` with a synthetic detail instead of crashing. */
export function evaluateCondition(node, event) {
  if (isConditionGroupNode(node)) {
    const key = Array.isArray(node.all) ? "all" : "any";
    const children = node[key] ?? [];
    const results = children.map((child) => evaluateCondition(child, event));
    const details = results.flatMap((entry) => entry.details);
    const passed = key === "all" ? results.every((entry) => entry.passed) : results.some((entry) => entry.passed);
    return { passed, details };
  }
  if (isConditionLeafNode(node)) {
    const detail = evaluateLeaf(node, event);
    return { passed: detail.passed, details: [detail] };
  }
  return { passed: false, details: [{ field: null, operator: null, expected: undefined, actual: undefined, passed: false, reason: "invalid-condition-shape" }] };
}

/** Sorts by `priority` descending; ties are broken by ORIGINAL array index (stable), never left to
 * whatever ordering guarantee `Array.prototype.sort` happens to make for equal comparator results
 * — an explicit index tiebreak, so equal-priority entries always evaluate in config-array order
 * regardless of engine/array-size internals. */
function stableSortByPriorityDesc(triggers) {
  return triggers
    .map((trigger, index) => ({ trigger, index }))
    .sort((a, b) => (b.trigger?.priority ?? DEFAULT_PRIORITY) - (a.trigger?.priority ?? DEFAULT_PRIORITY) || a.index - b.index)
    .map((entry) => entry.trigger);
}

/** Coarse "enabled/source/type" pre-filter, applied before any condition-tree evaluation (cheap
 * check before expensive check). `event.kind` stands in for "source/type" here: the current
 * StreamEvent contract (#89) has no separate platform-source field yet, so a trigger coarse-passes
 * only when the event's `kind` is one of the trigger's own configured `eventTypes`. */
function coarsePasses(trigger, event) {
  if (trigger?.enabled !== true) return false;
  if (!Array.isArray(trigger?.eventTypes) || !trigger.eventTypes.includes(event?.kind)) return false;
  return true;
}

function buildResult(trigger, event, matched, reason, details = []) {
  return Object.freeze({
    triggerId: trigger?.id ?? null,
    eventId: event?.id ?? null,
    eventKind: event?.kind ?? null,
    matched,
    reason: reason ?? null,
    priority: trigger?.priority ?? DEFAULT_PRIORITY,
    stopPropagation: trigger?.stopPropagation === true,
    details: Object.freeze(details.map((entry) => Object.freeze({ ...entry }))),
  });
}

/**
 * Matches `event` against `triggers` (an array of EventTriggerConfig; expected to already be
 * save-time-valid per trigger-validation.js — this function is defensive, not a re-validator).
 *
 * Returns `{ matches, skipped, truncated }`:
 *   - `matches`: MatchResults whose full condition tree evaluated true, in evaluation
 *     (priority-descending, stable) order.
 *   - `skipped`: every other trigger considered, each carrying a `reason` (`"disabled"`,
 *     `"event-type-mismatch"`, `"condition-not-met"`, `"max-matches-reached"`, or
 *     `"stopped-by-higher-priority"`).
 *   - `truncated`: true if `maxMatchesPerEvent` was hit before every trigger was evaluated.
 *
 * A `stopPropagation: true` match prevents every LOWER-priority trigger's condition tree from
 * being evaluated at all (they are recorded in `skipped` with reason
 * `"stopped-by-higher-priority"`, for trace completeness, but their conditions are never touched).
 *
 * Pass `trace` (a trigger-trace.js `TriggerTraceBuffer`) to also record every result (matched and
 * skipped) into its bounded history.
 */
export function matchEvent(triggers, event, { maxMatchesPerEvent = DEFAULT_MAX_MATCHES_PER_EVENT, trace = null } = {}) {
  const effectiveMax = Number.isInteger(maxMatchesPerEvent) && maxMatchesPerEvent > 0 ? maxMatchesPerEvent : DEFAULT_MAX_MATCHES_PER_EVENT;
  const ordered = stableSortByPriorityDesc(Array.isArray(triggers) ? triggers : []);
  const matches = [];
  const skipped = [];
  let truncated = false;
  let stoppedByPropagation = false;

  for (const trigger of ordered) {
    if (stoppedByPropagation) {
      skipped.push(buildResult(trigger, event, false, "stopped-by-higher-priority"));
      continue;
    }
    if (matches.length >= effectiveMax) {
      truncated = true;
      skipped.push(buildResult(trigger, event, false, "max-matches-reached"));
      continue;
    }
    if (!coarsePasses(trigger, event)) {
      const reason = trigger?.enabled !== true ? "disabled" : "event-type-mismatch";
      skipped.push(buildResult(trigger, event, false, reason));
      continue;
    }
    const { passed, details } = evaluateCondition(trigger.condition, event);
    const result = buildResult(trigger, event, passed, passed ? undefined : "condition-not-met", details);
    if (passed) {
      matches.push(result);
      if (trigger.stopPropagation === true) stoppedByPropagation = true;
    } else {
      skipped.push(result);
    }
  }

  if (trace) for (const entry of [...matches, ...skipped]) trace.record(entry);

  return { matches, skipped, truncated };
}
