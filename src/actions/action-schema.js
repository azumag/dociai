// Issue #93: pure-JS contract for an StreamEvent (#89) ActionConfig + the runtime ActionPlan built
// from it. Mirrors src/stream-events/contract.js's / src/triggers/event-trigger-schema.js's own
// split (this file = constants + structured-issue/result helpers + shape predicates; a real
// save-time validator lives here too since there is no separate "action-validation.js" in this
// issue's file list — action-planner.js is the runtime layer, this file is contract+validation,
// same "contract vs runtime" layering already established for src/stream-events/* and
// src/triggers/*).
//
// An ActionConfig is attached to a matched EventTriggerConfig (#91). The trigger validation layer
// delegates each `trigger.actions` entry back to validateActionConfig() so action-specific issue
// paths compose cleanly with `eventTriggers.<id>.actions.<index>`. Supported kinds are:
//   - "ai-response": build a prompt (src/context/stream-event-context.js), call the AI connector,
//     speak the result.
//   - "template-speech": a fixed/templated string with placeholders filled from event data, no AI
//     call — cheaper, used as an overflow-policy target from #92 or for simple redemptions.
//   - "overlay-cue": a persisted visual/audio cue contract; actual playback belongs to later
//     runtime issues.

import { validateOverlayCueConfig } from "../overlay/overlay-cue-validation.js";

export const ACTION_KINDS = Object.freeze(["ai-response", "template-speech", "overlay-cue"]);
const OVERLAY_ACTION_FIELDS = Object.freeze(["id", "kind", "priority", "cue"]);
const OVERLAY_ACTION_RUNTIME_FIELDS = new Set(["schemaVersion", "cueInstanceId", "planId", "eventId", "triggerId", "generation", "issuedAt", "expiresAt", "assetHandle", "mimeType", "durationMs", "url", "path"]);
const OVERLAY_ACTION_PROHIBITED_FIELDS = new Set(["css", "js", "keyframes", "style"]);

export const DEFAULT_ACTION_PRIORITY = 0;

/** Structured issue shape, mirroring contract.js's / event-trigger-schema.js's own `issue()`
 * one-for-one for consistency across this repo's schema/validation layers. */
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Save-time-shaped validation for a single ActionConfig — never throws; `ok:false` iff at least one
 * `severity:"error"` issue. Deliberately permissive about extra/unknown fields (same "plain object,
 * no closed-schema rejection" stance event-trigger-schema.js takes), since a persona/connector/voice
 * override or a `rateLimit`/`task`/`maxTokens` tuning field may legitimately vary per action kind.
 */
export function validateActionConfig(candidate) {
  const issues = [];
  if (!isPlainObject(candidate)) return failureResult([issue([], "type.object", "action config must be an object")], candidate);

  if (!isNonEmptyString(candidate.id)) issues.push(issue(["id"], "required", "id is required"));
  if (!ACTION_KINDS.includes(candidate.kind)) {
    issues.push(issue(["kind"], "enum", `kind must be one of ${ACTION_KINDS.join("/")}`, { meta: { options: ACTION_KINDS } }));
  }
  if (candidate.kind === "ai-response" && !isNonEmptyString(candidate.personaId)) {
    issues.push(issue(["personaId"], "required", 'ai-response actions require a non-empty "personaId"'));
  }
  if (candidate.kind === "template-speech" && !isNonEmptyString(candidate.template)) {
    issues.push(issue(["template"], "required", 'template-speech actions require a non-empty "template" string'));
  }
  if (candidate.kind === "overlay-cue") {
    for (const key of Object.keys(candidate)) {
      if (OVERLAY_ACTION_RUNTIME_FIELDS.has(key)) issues.push(issue([key], "runtime-field.persisted", `${key} is runtime-only and must not be persisted`));
      else if (OVERLAY_ACTION_PROHIBITED_FIELDS.has(key)) issues.push(issue([key], "field.prohibited", `${key} is not allowed in an overlay-cue action`));
      else if (!OVERLAY_ACTION_FIELDS.includes(key)) issues.push(issue([key], "unknown", `Unknown overlay-cue action field: ${key}`, { severity: "warning" }));
    }
    const result = validateOverlayCueConfig(candidate.cue);
    for (const entry of result.issues) issues.push(issue(["cue", ...entry.path], entry.code, entry.message, { severity: entry.severity, meta: entry.meta }));
  }
  if (candidate.priority !== undefined && typeof candidate.priority !== "number") {
    issues.push(issue(["priority"], "type.number", "priority must be a number when present"));
  } else if (candidate.kind === "overlay-cue" && candidate.priority !== undefined && !Number.isFinite(candidate.priority)) {
    issues.push(issue(["priority"], "type.number", "overlay-cue priority must be a finite number"));
  }
  if ((candidate.kind === "ai-response" || candidate.kind === "template-speech") && candidate.maxChars !== undefined && !(Number.isInteger(candidate.maxChars) && candidate.maxChars > 0)) {
    issues.push(issue(["maxChars"], "type.positiveInteger", "maxChars must be a positive integer when present"));
  }

  const errors = issues.filter((entry) => entry.severity === "error");
  return errors.length ? failureResult(issues, candidate) : successResult(candidate, issues);
}

/** Deterministic ActionPlan id from `(eventId, triggerId, actionIndex)` — stable across a
 * re-plan of the exact same match (e.g. a reconnect-window duplicate notification that slipped past
 * #88/#89's own event-id dedupe, or a config-reload replan), which is exactly what
 * action-runner.js's short-TTL dedupe keys off of. */
export function buildActionPlanId(eventId, triggerId, actionIndex) {
  return `${eventId ?? "unknown-event"}::${triggerId ?? "unknown-trigger"}::${actionIndex}`;
}

// -------------------------------------------------------------------------------------------
// Shared inline-text sanitizer — used by both the trusted/untrusted prompt builder
// (src/context/stream-event-context.js) and template placeholder substitution
// (template-speech-action.js) for the identical "strip control chars, cap length" hygiene pass.
// Deliberately NOT a general HTML/markup sanitizer: the output of this never gets interpreted as
// markup (it's consumed by an LLM prompt or a speech-queue string), so the only real risk here is
// control/escape characters (terminal/ANSI tricks, embedded NULs) and unbounded length, not HTML.
// -------------------------------------------------------------------------------------------

// Matches ASCII control/escape bytes (NUL..BS, VT, FF, SO..US, DEL) — deliberately excludes TAB/LF/CR
// (0x09/0x0A/0x0D), which are collapsed to a plain space by the \s+ pass right below instead.
const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

export const DEFAULT_INLINE_TEXT_MAX_CHARS = 500;

/** Strips control characters (keeps normal whitespace/newlines out on purpose too — collapses them
 * to a single space so a value can never fake multi-line structure) and caps length. Never throws;
 * a non-string input is coerced via `String()` first (so `undefined`/numbers/etc. are handled the
 * same as everywhere else in this repo's defensive style). */
export function sanitizeInlineText(value, { maxChars = DEFAULT_INLINE_TEXT_MAX_CHARS } = {}) {
  let text = String(value ?? "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return text;
}
