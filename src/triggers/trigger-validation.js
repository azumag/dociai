// Issue #91: SAVE-TIME validation for EventTriggerConfig — the gate that runs before a trigger is
// persisted/registered, never at match time. Rejects (never silently coerces):
//   - an unregistered/arbitrary `field` path (event-field-registry.js's fixed allow-list is the
//     only source of truth; there is no dot-path traversal to walk here in the first place — see
//     that module's own header comment)
//   - a `field` that isn't valid for ANY of the trigger's configured `eventTypes`
//   - an `operator` not valid for the field's registered value type
//   - a `value` whose type doesn't match the field (number/string/boolean mismatch)
//   - a malformed `all`/`any` condition-group shape, or a tree deeper than MAX_CONDITION_DEPTH
//
// Regex support: NOT implemented in this first version. The issue's own test list is fully
// covered by eq/contains/in/gt/gte/lt/lte/between, and skipping regex entirely avoids having to
// defend a user-editable (config-file-sourced) pattern against ReDoS via a length/flag-restricted
// regex engine. A `regex`-family operator is explicitly rejected below with a clear error rather
// than silently ignored, so a future issue that DOES add regex support has one obvious place to
// change (and per this file's own rationale, must add a length cap + restricted flag set when it
// does).
import { STREAM_EVENT_KINDS } from "../stream-events/contract.js";
import { getFieldDefinition, isFieldValidForAnyKind, operatorsForField } from "./event-field-registry.js";
import { MAX_CONDITION_DEPTH, failureResult, isConditionLeafNode, issue, successResult } from "./event-trigger-schema.js";
import { validateActionConfig } from "../actions/action-schema.js";

/** Operator names that look like a regex-family match — rejected outright per this file's own
 * header comment, rather than silently ignored or coerced. */
const UNSUPPORTED_OPERATORS = Object.freeze(["regex", "regexp", "matches", "match"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateValueForType(node, definition, path, issues) {
  const { operator, value } = node;
  const valuePath = [...path, "value"];
  if (definition.type === "boolean") {
    if (typeof value !== "boolean") issues.push(issue(valuePath, "type.boolean", `value must be a boolean for field "${node.field}"`));
    return;
  }
  if (definition.type === "number") {
    if (operator === "in") {
      if (!Array.isArray(value) || value.length === 0 || !value.every(isFiniteNumber)) issues.push(issue(valuePath, "type.numberArray", 'value must be a non-empty array of numbers for the "in" operator'));
      return;
    }
    if (operator === "between") {
      if (!Array.isArray(value) || value.length !== 2 || !value.every(isFiniteNumber) || value[0] > value[1]) issues.push(issue(valuePath, "type.numberRange", 'value must be a [min, max] pair of numbers (min <= max) for the "between" operator'));
      return;
    }
    if (!isFiniteNumber(value)) issues.push(issue(valuePath, "type.number", `value must be a number for field "${node.field}"`));
    return;
  }
  // string
  if (operator === "in") {
    if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string")) issues.push(issue(valuePath, "type.stringArray", 'value must be a non-empty array of strings for the "in" operator'));
    return;
  }
  if (typeof value !== "string") issues.push(issue(valuePath, "type.string", `value must be a string for field "${node.field}"`));
}

function validateLeaf(node, path, eventTypes, issues) {
  if (typeof node.field !== "string" || !node.field) {
    issues.push(issue([...path, "field"], "required", "condition.field is required"));
    return;
  }
  const definition = getFieldDefinition(node.field);
  if (!definition) {
    issues.push(issue([...path, "field"], "field.unknown", `"${node.field}" is not a registered condition field`));
    return;
  }
  if (!isFieldValidForAnyKind(node.field, eventTypes)) {
    issues.push(issue([...path, "field"], "field.notApplicable", `field "${node.field}" is not valid for any of this trigger's configured event types`, { meta: { allowedKinds: definition.kinds, eventTypes } }));
  }
  if (typeof node.operator !== "string" || !node.operator) {
    issues.push(issue([...path, "operator"], "required", "condition.operator is required"));
    return;
  }
  if (UNSUPPORTED_OPERATORS.includes(node.operator)) {
    issues.push(issue([...path, "operator"], "operator.unsupported", `operator "${node.operator}" is not supported (regex-family operators are not implemented — see trigger-validation.js's header comment)`));
    return;
  }
  const allowedOperators = operatorsForField(node.field);
  if (!allowedOperators.includes(node.operator)) {
    issues.push(issue([...path, "operator"], "operator.invalid", `operator "${node.operator}" is not valid for field "${node.field}" (type ${definition.type})`, { meta: { allowedOperators } }));
    return;
  }
  validateValueForType(node, definition, path, issues);
}

function validateConditionNode(node, path, eventTypes, issues, depth) {
  if (depth > MAX_CONDITION_DEPTH) {
    issues.push(issue(path, "condition.tooDeep", `condition tree exceeds max depth of ${MAX_CONDITION_DEPTH}`));
    return;
  }
  if (!isPlainObject(node)) {
    issues.push(issue(path, "type.object", 'condition node must be an object (an "all"/"any" group or a {field, operator, value} leaf)'));
    return;
  }
  const hasAll = Array.isArray(node.all);
  const hasAny = Array.isArray(node.any);
  if (hasAll && hasAny) {
    issues.push(issue(path, "condition.ambiguous", 'condition node must not declare both "all" and "any"'));
    return;
  }
  if (hasAll || hasAny) {
    const key = hasAll ? "all" : "any";
    const children = node[key];
    if (children.length === 0) {
      issues.push(issue([...path, key], "condition.empty", `"${key}" must contain at least one condition`));
      return;
    }
    children.forEach((child, index) => validateConditionNode(child, [...path, key, index], eventTypes, issues, depth + 1));
    return;
  }
  if (isConditionLeafNode(node)) {
    validateLeaf(node, path, eventTypes, issues);
    return;
  }
  issues.push(issue(path, "condition.invalidShape", 'condition node must be an "all"/"any" group or a {field, operator, value} leaf'));
}

/** Save-time validation for a single EventTriggerConfig. Never throws; always returns
 * `{ ok, issues, ... }` (issues may include warnings even when `ok:true`; `ok:false` iff at least
 * one issue has `severity: "error"`). */
export function validateEventTriggerConfig(candidate) {
  const issues = [];
  if (!isPlainObject(candidate)) return failureResult([issue([], "type.object", "event trigger config must be an object")], candidate);

  if (!isNonEmptyString(candidate.id)) issues.push(issue(["id"], "required", "id is required"));
  if (typeof candidate.enabled !== "boolean") issues.push(issue(["enabled"], "type.boolean", "enabled must be a boolean"));

  const eventTypes = Array.isArray(candidate.eventTypes) ? candidate.eventTypes : null;
  if (!eventTypes || eventTypes.length === 0) {
    issues.push(issue(["eventTypes"], "required", "eventTypes must be a non-empty array"));
  } else {
    for (const [index, kind] of eventTypes.entries()) {
      if (!STREAM_EVENT_KINDS.includes(kind)) issues.push(issue(["eventTypes", index], "enum", `"${kind}" is not a supported StreamEvent kind`, { meta: { options: STREAM_EVENT_KINDS } }));
    }
  }

  if (candidate.priority !== undefined && !isFiniteNumber(candidate.priority)) issues.push(issue(["priority"], "type.number", "priority must be a finite number"));
  if (candidate.stopPropagation !== undefined && typeof candidate.stopPropagation !== "boolean") issues.push(issue(["stopPropagation"], "type.boolean", "stopPropagation must be a boolean"));

  validateConditionNode(candidate.condition, ["condition"], eventTypes ?? [], issues, 0);
  if (candidate.actions !== undefined) {
    if (!Array.isArray(candidate.actions)) issues.push(issue(["actions"], "type.array", "actions must be an array"));
    else candidate.actions.forEach((action, index) => {
      const result = validateActionConfig(action);
      for (const entry of result.issues) issues.push(issue(["actions", index, ...entry.path], entry.code, entry.message, { severity: entry.severity, meta: entry.meta }));
    });
  }

  const errors = issues.filter((entry) => entry.severity === "error");
  return errors.length ? failureResult(issues, candidate) : successResult(candidate, issues);
}

/** Validates a whole `{ [id]: EventTriggerConfig }` config-section map, as stored under
 * `config.eventTriggers` — used standalone and by src/config/config-validation.js's registration
 * hook (see that file's own comment referencing this function; issue #91's "config migration/
 * validationを#64へ登録" item). `undefined` (the section simply absent) is valid — an empty/
 * missing eventTriggers section is not an error. */
export function validateEventTriggersConfig(eventTriggers) {
  const issues = [];
  if (eventTriggers === undefined) return successResult(eventTriggers, issues);
  if (!isPlainObject(eventTriggers)) return failureResult([issue(["eventTriggers"], "type.object", "eventTriggers must be an object keyed by trigger id")], eventTriggers);

  for (const [id, trigger] of Object.entries(eventTriggers)) {
    if (isPlainObject(trigger) && trigger.id !== undefined && trigger.id !== id) {
      issues.push(issue(["eventTriggers", id, "id"], "id.mismatch", `entry key "${id}" does not match trigger.id "${trigger.id}"`, { severity: "warning" }));
    }
    const result = validateEventTriggerConfig(trigger);
    for (const entry of result.issues) issues.push(issue(["eventTriggers", id, ...entry.path], entry.code, entry.message, { severity: entry.severity, meta: entry.meta }));
  }
  const errors = issues.filter((entry) => entry.severity === "error");
  return errors.length ? failureResult(issues, eventTriggers) : successResult(eventTriggers, issues);
}
