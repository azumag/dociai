// Issue #93: renders a `template-speech` ActionConfig's fixed/templated string against a StreamEvent
// — no AI call, cheaper than `ai-response`, used as the overflow-policy target from #92's
// `"template-only"` policy (src/actions/action-rate-limiter.js's OVERFLOW_POLICIES) or for simple
// redemptions that don't need a generated response.
//
// Placeholder resolution mirrors src/triggers/event-field-registry.js's own "fixed allow-list,
// hardcoded getter closures, NO dynamic dot-path-string-walking helper" stance one-for-one — a
// `{{__proto__.polluted}}`-shaped placeholder simply isn't a key in PLACEHOLDER_RESOLVERS and
// resolves to nothing, exactly like an unregistered event-field-registry.js key.
import { DEFAULT_INLINE_TEXT_MAX_CHARS, sanitizeInlineText } from "./action-schema.js";

const PLACEHOLDER_RESOLVERS = new Map(
  Object.entries({
    "actor.displayName": (event) => event?.actor?.displayName,
    "actor.isAnonymous": (event) => event?.actor?.isAnonymous,
    "channel.displayName": (event) => event?.channel?.displayName,
    "data.bits": (event) => event?.data?.bits,
    "data.tier": (event) => event?.data?.tier,
    "data.isGift": (event) => event?.data?.isGift,
    "data.cumulativeMonths": (event) => event?.data?.cumulativeMonths,
    "data.streakMonths": (event) => event?.data?.streakMonths,
    "data.count": (event) => event?.data?.count,
    "data.cumulativeTotal": (event) => event?.data?.cumulativeTotal,
    "data.rewardId": (event) => event?.data?.rewardId,
    "data.rewardTitle": (event) => event?.data?.rewardTitle,
    "data.cost": (event) => event?.data?.cost,
    // Both explicitly UNTRUSTED per the issue body (bits/sub/redemption "message"/reward "user
    // input" text typed directly by a Twitch viewer) — still substitutable here (a streamer may
    // deliberately want a template that reads a redemption's typed input aloud), but every
    // substituted value is escaped/length-capped below exactly like every other placeholder, so it
    // can never break the template's OWN structure.
    "data.userInput": (event) => event?.data?.userInput,
    "data.message": (event) => event?.data?.message,
  }),
);

export const PLACEHOLDER_KEYS = Object.freeze([...PLACEHOLDER_RESOLVERS.keys()]);

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export const DEFAULT_MAX_TEMPLATE_CHARS = 300;
export const DEFAULT_MAX_PLACEHOLDER_CHARS = 120;

/** Escapes a LITERAL `{{`/`}}` sequence appearing INSIDE a substituted value so a viewer-controlled
 * value (e.g. `data.userInput` containing the text `{{data.cost}}`) can never be mistaken for a
 * second, attacker-controlled placeholder — defense in depth: a single `String.replace(regex, fn)`
 * pass never re-scans its own replacement text, so this is not exploitable today, but the escaping
 * keeps that true even if a future caller ever re-renders a template's OUTPUT through this function
 * a second time. */
function neutralizeBraces(text) {
  return text.replaceAll("{{", "｛｛").replaceAll("}}", "｝｝");
}

function resolvePlaceholder(key, event) {
  const getter = PLACEHOLDER_RESOLVERS.get(key);
  if (!getter) return null;
  try {
    return getter(event);
  } catch {
    return null;
  }
}

/**
 * Renders `template` (a plain string with `{{field.path}}` placeholders drawn from
 * PLACEHOLDER_KEYS) against `event`. Every substituted value is run through
 * action-schema.js's shared `sanitizeInlineText` (control-char strip + per-value length cap) AND
 * brace-neutralized before insertion; the final rendered string is additionally capped at
 * `maxChars` total. An unresolved/unknown placeholder is replaced with an empty string (never
 * throws, never leaves the literal `{{...}}` syntax in spoken output) and reported in
 * `unresolvedPlaceholders` for diagnostics.
 */
export function renderTemplateSpeech(template, event, { maxChars = DEFAULT_MAX_TEMPLATE_CHARS, maxPlaceholderChars = DEFAULT_MAX_PLACEHOLDER_CHARS } = {}) {
  const source = typeof template === "string" ? template : "";
  const unresolvedPlaceholders = [];

  let rendered = source.replace(PLACEHOLDER_RE, (_full, key) => {
    const value = resolvePlaceholder(key, event);
    if (value === null || value === undefined) {
      unresolvedPlaceholders.push(key);
      return "";
    }
    return sanitizeInlineText(neutralizeBraces(String(value)), { maxChars: maxPlaceholderChars });
  });

  rendered = sanitizeInlineText(rendered, { maxChars: Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_INLINE_TEXT_MAX_CHARS });

  return Object.freeze({ text: rendered, unresolvedPlaceholders: Object.freeze(unresolvedPlaceholders) });
}
