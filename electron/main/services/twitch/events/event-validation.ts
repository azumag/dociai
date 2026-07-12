// Issue #90: numeric/string field validation shared by every normalizer under ./normalizers/*.ts.
//
// Distinguishes CRITICAL fields (missing/invalid => the whole event fails to normalize, an
// `error`-severity NormalizeIssue) from OPTIONAL fields (missing/invalid => the field is simply
// omitted from the resulting StreamEvent, a `warning`-severity NormalizeIssue records why, but
// normalization still succeeds) — this is issue #90's own "critical/optional fieldごとの
// failure/warning方針". A normalizer decides which bucket a given raw Twitch field falls into
// (e.g. `bits`/`tier`/`rewardId` are critical; `message`/`streakMonths`/`cumulativeTotal` are
// optional) by calling the matching `require*`/`optional*` helper below; every helper pushes onto
// the caller-owned `issues` array rather than throwing, mirroring src/stream-events/contract.js's
// own `issue()` + issues-array convention (#89) one level down, before a value ever becomes part
// of a candidate StreamEvent.
//
// `NaN`/`+Infinity`/`-Infinity` are rejected by construction: `Number.isFinite()` is false for all
// three, and every numeric helper here routes through it before any range check runs.

export type FieldSeverity = "error" | "warning";

export type NormalizeIssue = { field: string; code: string; message: string; severity: FieldSeverity };

export function fieldIssue(field: string, code: string, message: string, severity: FieldSeverity = "error"): NormalizeIssue {
  return { field, code, message, severity };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export type IntegerOptions = { min?: number; max?: number };

/** A CRITICAL integer field. Missing, non-numeric, `NaN`/`Infinity`, a non-integer (e.g. `1.5`),
 * or outside `[min, max]` all push an `error` NormalizeIssue and return `null` — the caller (a
 * normalizer) must treat a `null` return as "this event cannot be normalized" and bail out. */
export function requireInteger(value: unknown, field: string, issues: NormalizeIssue[], options: IntegerOptions = {}): number | null {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    issues.push(fieldIssue(field, "type.integer", `${field} must be a finite integer`, "error"));
    return null;
  }
  if (options.min !== undefined && value < options.min) {
    issues.push(fieldIssue(field, "range.min", `${field} must be >= ${options.min}`, "error"));
    return null;
  }
  if (options.max !== undefined && value > options.max) {
    issues.push(fieldIssue(field, "range.max", `${field} must be <= ${options.max}`, "error"));
    return null;
  }
  return value;
}

/** An OPTIONAL integer field. `undefined`/`null` (Twitch's own documented "not shared" shape for
 * e.g. `streak_months`/`cumulative_total`) is silently fine and returns `undefined` — that is the
 * expected, non-anomalous shape, not something worth a warning. A value that IS present but
 * non-numeric/`NaN`/`Infinity`/non-integer/out-of-range degrades to a `warning` and the field is
 * omitted (`undefined`) rather than failing the whole event. */
export function optionalInteger(value: unknown, field: string, issues: NormalizeIssue[], options: IntegerOptions = {}): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    issues.push(fieldIssue(field, "type.integer", `${field} is present but not a finite integer; omitting it`, "warning"));
    return undefined;
  }
  if (options.min !== undefined && value < options.min) {
    issues.push(fieldIssue(field, "range.min", `${field} is present but below the minimum (${options.min}); omitting it`, "warning"));
    return undefined;
  }
  if (options.max !== undefined && value > options.max) {
    issues.push(fieldIssue(field, "range.max", `${field} is present but above the maximum (${options.max}); omitting it`, "warning"));
    return undefined;
  }
  return value;
}

/** A CRITICAL non-empty-string field (e.g. an id). */
export function requireNonEmptyString(value: unknown, field: string, issues: NormalizeIssue[]): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(fieldIssue(field, "required", `${field} is required`, "error"));
    return null;
  }
  return value;
}

/** An OPTIONAL non-empty-string field (e.g. a diagnostic-only id we'd like to keep in
 * `sourceMetadata` when present, but is not itself required for the event to normalize). */
export function optionalNonEmptyString(value: unknown, field: string, issues: NormalizeIssue[]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(fieldIssue(field, "type.string", `${field} is present but not a non-empty string; omitting it`, "warning"));
    return undefined;
  }
  return value;
}

/** An OPTIONAL boolean field (e.g. `is_gift`) — present-but-wrong-type degrades to a warning and
 * omission rather than failing the event. */
export function optionalBoolean(value: unknown, field: string, issues: NormalizeIssue[]): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    issues.push(fieldIssue(field, "type.boolean", `${field} is present but not a boolean; omitting it`, "warning"));
    return undefined;
  }
  return value;
}

/** A CRITICAL enum field (e.g. `tier`) — required, and must be one of `allowed`. */
export function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], issues: NormalizeIssue[]): T | null {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issues.push(fieldIssue(field, "enum", `${field} must be one of: ${allowed.join(", ")}`, "error"));
    return null;
  }
  return value as T;
}

/** An OPTIONAL enum field — an unrecognized/invalid value degrades to a warning + omission rather
 * than failing the event. This matters concretely for reward-redemption `status`: Twitch's own
 * `RedemptionStatus` includes an `unknown` value that is NOT one of StreamEvent's documented
 * `fulfilled | unfulfilled | canceled` — that must not fail normalization, just drop the field. */
export function optionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], issues: NormalizeIssue[]): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issues.push(fieldIssue(field, "enum", `${field} is present but not one of: ${allowed.join(", ")}; omitting it`, "warning"));
    return undefined;
  }
  return value as T;
}
