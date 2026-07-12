// Issue #90: sanitizes free-text fields carried on a Twitch EventSub event (cheer/resub messages,
// channel-points reward titles, redemption `user_input`) before they become part of a published
// StreamEvent.
//
// Deliberately NARROW in scope — this is NOT an HTML escaper and NOT a content/profanity filter.
// Escaping for a specific rendering context (innerHTML vs textContent vs a chat-TTS queue vs a
// future LLM prompt builder) is that CONSUMER's job and differs per consumer (src/stream-events/
// display.js already builds plain Japanese template strings from this text with no HTML rendering
// involved at all). Escaping here would only ever be wrong for at least one consumer: a TTS
// reader or a raw-JSON forwarder would end up reading/emitting literal HTML entities instead of
// the characters the viewer actually typed. So HTML-shaped text (e.g. a literal script tag) passes
// through UNCHANGED as inert data — the issue's own acceptance criterion is that untrusted text is
// retained in a form that does NOT ITSELF break a DOM/prompt when a later consumer handles it
// correctly, not that this module pre-guesses every future consumer's escaping rules.
//
// What THIS module DOES guard against — things that are unsafe regardless of which consumer reads
// the text next:
//   - C0/C1 control characters, including the NUL byte — these can corrupt terminal/log
//     rendering outright (e.g. by moving the cursor or duplicating the last log line) no matter
//     what eventually reads the text.
//   - The legacy Unicode bidi EMBEDDING/OVERRIDE control characters at codepoints 0x202A-0x202E
//     (LRE, RLE, PDF, LRO, RLO). LRO/RLO in particular can make surrounding text visually render
//     in an order that does NOT match its actual character order — the same class of trick
//     historically used to disguise a malicious file's real extension (e.g. "gnp.exe" rendering as
//     "exe.png"). Stripped unconditionally, regardless of consumer.
//   - Unicode bidi ISOLATE characters (codepoints 0x2066-0x2069: LRI/RLI/FSI/PDI) and directional
//     MARKS (0x200E LRM, 0x200F RLM, 0x061C ALM) are deliberately left ALONE. These are the
//     modern, Unicode-Bidi-Algorithm-recommended-safe way to mix RTL/LTR text (an isolate's
//     reordering effect never escapes its own span, unlike an override) — stripping them would
//     mangle entirely legitimate Arabic/Hebrew/Persian/Urdu chat text for no safety benefit.
//   - Excessive consecutive newlines (collapsed to a single blank line, not stripped outright) and
//     an overall length cap (code-point-safe, so a surrogate-pair emoji is never split in half).
//
// Deliberately does NOT run a blanket Unicode NFKC normalization: NFKC folds e.g. full-width forms
// and various compatibility characters into different codepoints, which can silently mangle
// legitimate emoji sequences and CJK/compatibility text a viewer actually typed. Normalizing
// case/width/compatibility variants is a display-layer concern, not a safety one — doing it here
// would be actively destructive to legitimate Unicode/emoji text, which is exactly what issue #90
// itself warns against.
//
// Implementation note: every control-character/bidi-override codepoint range below is built at
// RUNTIME from plain decimal/hex numbers via String.fromCodePoint() rather than written as a
// literal regex character class or a `\u`-escape string in this file's own source text — that
// keeps the .ts source itself 100% plain, unambiguous ASCII (no raw control bytes and no escape
// sequence for a text-processing/transport layer to possibly mis-decode) while the resulting
// RegExp still matches exactly the intended codepoints at runtime.
import type { NormalizeIssue } from "./event-validation";
import { fieldIssue } from "./event-validation";

/** Twitch's own chat/cheer message and channel-points prompt/user_input limits all sit at or
 * under a few hundred characters. 500 is a generous defensive cap of our own (not a number Twitch
 * documents) — large enough that a legitimate message is never truncated in practice, while still
 * bounding how much text a single malformed/malicious payload can push through the pipeline (log
 * lines, UI cards, a future prompt-building consumer). */
export const MAX_TEXT_LENGTH = 500;

function codePointRange(startCodePoint: number, endCodePoint: number): string {
  let out = "";
  for (let codePoint = startCodePoint; codePoint <= endCodePoint; codePoint += 1) out += String.fromCodePoint(codePoint);
  return out;
}

// C0 controls 0x00-0x09 and 0x0B-0x1F (0x0A == LF is intentionally excluded — newlines are handled
// separately below, collapsed rather than stripped, so a legitimate multi-line message survives),
// plus DEL (0x7F) and the C1 control range (0x80-0x9F). \r (0x0D) is normalized away by the
// CRLF/CR -> LF pass before this pattern ever runs, so it never needs special-casing here either.
const CONTROL_CHARS_EXCEPT_LF_PATTERN = codePointRange(0x00, 0x09) + codePointRange(0x0b, 0x1f) + codePointRange(0x7f, 0x9f);
const CONTROL_CHARS_EXCEPT_LF = new RegExp(`[${CONTROL_CHARS_EXCEPT_LF_PATTERN}]`, "g");

// The 5 legacy bidi embedding/override control characters: 0x202A LRE, 0x202B RLE, 0x202C PDF,
// 0x202D LRO, 0x202E RLO — see the module doc comment above for why these are stripped but the
// isolate/mark characters are not.
const BIDI_EMBEDDING_OVERRIDE_PATTERN = codePointRange(0x202a, 0x202e);
const BIDI_EMBEDDING_OVERRIDE = new RegExp(`[${BIDI_EMBEDDING_OVERRIDE_PATTERN}]`, "g");

export type SanitizeTextResult = {
  text: string;
  truncated: boolean;
  hadControlChars: boolean;
  hadBidiOverride: boolean;
  hadExcessiveNewlines: boolean;
};

/** Pure `(raw) -> {text, ...flags}` — never throws, no issue-list side effects (that is
 * `sanitizeOptionalText()`/`sanitizeRequiredText()`'s job below). A non-string `raw` yields an
 * empty, all-false result; this module has no opinion on whether an absent/non-string field is
 * itself a problem — event-validation.ts's required-vs-optional policy owns that decision. */
export function sanitizeText(raw: unknown): SanitizeTextResult {
  if (typeof raw !== "string") {
    return { text: "", truncated: false, hadControlChars: false, hadBidiOverride: false, hadExcessiveNewlines: false };
  }

  let text = raw.replace(/\r\n?/g, "\n");

  const hadBidiOverride = BIDI_EMBEDDING_OVERRIDE.test(text);
  BIDI_EMBEDDING_OVERRIDE.lastIndex = 0;
  text = text.replace(BIDI_EMBEDDING_OVERRIDE, "");

  const hadControlChars = CONTROL_CHARS_EXCEPT_LF.test(text);
  CONTROL_CHARS_EXCEPT_LF.lastIndex = 0;
  text = text.replace(CONTROL_CHARS_EXCEPT_LF, "");

  const collapsed = text.replace(/\n{3,}/g, "\n\n");
  const hadExcessiveNewlines = collapsed !== text;
  text = collapsed.trim();

  // Split by Unicode code point (not UTF-16 code unit) so a truncation can never land inside a
  // surrogate pair and corrupt an emoji/astral character. This does not protect multi-codepoint
  // ZWJ emoji sequences (e.g. a family emoji built from several joined codepoints) from being cut
  // between codepoints — a full grapheme-cluster-safe truncation would need Intl.Segmenter, which
  // is deliberately not pulled in here for a length cap this generous relative to realistic chat
  // text; a very rare truncated ZWJ sequence at the tail is a cosmetic edge case, not a safety one.
  const codePoints = Array.from(text);
  const truncated = codePoints.length > MAX_TEXT_LENGTH;
  if (truncated) text = codePoints.slice(0, MAX_TEXT_LENGTH).join("");

  return { text, truncated, hadControlChars, hadBidiOverride, hadExcessiveNewlines };
}

function recordSanitizeIssues(result: SanitizeTextResult, field: string, issues: NormalizeIssue[]): void {
  if (result.truncated) issues.push(fieldIssue(field, "text.truncated", `${field} exceeded ${MAX_TEXT_LENGTH} characters and was truncated`, "warning"));
  if (result.hadControlChars) issues.push(fieldIssue(field, "text.controlChars", `${field} contained control characters that were removed`, "warning"));
  if (result.hadBidiOverride) issues.push(fieldIssue(field, "text.bidiOverride", `${field} contained a Unicode bidi embedding/override character that was removed`, "warning"));
  if (result.hadExcessiveNewlines) issues.push(fieldIssue(field, "text.excessiveNewlines", `${field} had excessive consecutive line breaks that were collapsed`, "warning"));
}

/** An OPTIONAL free-text field (cheer/resub message, redemption user_input, reward title/prompt
 * when used optionally): sanitizes and records a `warning` NormalizeIssue for anything notable
 * (truncation/control chars/bidi override/newline collapsing) — sanitization itself never fails
 * the event. `undefined`/`null`/non-string input, or input that sanitizes down to nothing (e.g.
 * text that was ENTIRELY control characters), returns `undefined` so the field is simply omitted
 * from `data` rather than appearing as a misleading empty string. */
export function sanitizeOptionalText(raw: unknown, field: string, issues: NormalizeIssue[]): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    issues.push(fieldIssue(field, "type.string", `${field} is present but not a string; omitting it`, "warning"));
    return undefined;
  }
  const result = sanitizeText(raw);
  recordSanitizeIssues(result, field, issues);
  return result.text.length > 0 ? result.text : undefined;
}

/** A REQUIRED free-text field (e.g. reward title) — missing/blank input is an `error` (same as
 * event-validation.ts's `requireNonEmptyString`), and so is a value that sanitizes down to nothing
 * (e.g. a title that, per the raw payload, was non-empty only because it consisted entirely of
 * control characters/bidi overrides) — a required field can never legitimately end up empty, so
 * that case fails normalization rather than silently omitting a field the StreamEvent contract
 * requires to be present. */
export function sanitizeRequiredText(raw: unknown, field: string, issues: NormalizeIssue[]): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    issues.push(fieldIssue(field, "required", `${field} is required`, "error"));
    return null;
  }
  const result = sanitizeText(raw);
  recordSanitizeIssues(result, field, issues);
  if (result.text.length === 0) {
    issues.push(fieldIssue(field, "text.emptyAfterSanitize", `${field} became empty after removing unsafe characters`, "error"));
    return null;
  }
  return result.text;
}
