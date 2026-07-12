// Issue #93: "AI failure時のtemplate fallbackを実装" — if the AI connector errors, times out, is
// unavailable (missing/disabled persona or connector), or is cancelled-and-retried-elsewhere, this
// module builds a template-speech-SHAPED simple response instead of silently failing. Deliberately
// tiny and dependency-free (no connector call, no template placeholder engine) — it is the last-
// resort safety net, not a feature, so it must never itself be able to fail in a way that produces
// no output at all.
import { formatStreamEvent } from "../stream-events/display.js";
import { sanitizeInlineText } from "./action-schema.js";

export const DEFAULT_FALLBACK_TEXT = "ありがとうございます!";

const MAX_ACTOR_LABEL_CHARS = 40;

function actorLabel(event) {
  const raw = event?.actor?.isAnonymous ? "" : (event?.actor?.displayName ?? "");
  const name = sanitizeInlineText(raw, { maxChars: MAX_ACTOR_LABEL_CHARS });
  return name || (event?.actor?.isAnonymous ? "匿名の視聴者さん" : "視聴者さん");
}

const FALLBACK_BUILDERS = Object.freeze({
  cheer: (event) => `${actorLabel(event)}、Bitsありがとうございます!`,
  subscription: (event) => `${actorLabel(event)}、サブスクありがとうございます!`,
  resub: (event) => `${actorLabel(event)}、継続サブスクありがとうございます!`,
  "gift-subscription": (event) => `${actorLabel(event)}、ギフトサブスクありがとうございます!`,
  "reward-redemption": (event) => `${actorLabel(event)}、交換ありがとうございます!`,
});

/**
 * Builds a safe, non-AI fallback response for `event` — never throws, never returns an empty
 * string. `reason` (e.g. `"persona-unavailable"`, `"connector-unavailable"`, `"ai-error"`) is
 * carried through verbatim into the returned object purely for trace/diagnostic purposes; it does
 * not change WHAT text is produced (every reason gets the identical per-kind fallback template —
 * the point of a fallback is to be boringly predictable, not to explain itself to the viewer).
 */
export function buildFallbackSpeech({ event, action = null, reason = "fallback" } = {}) {
  const builder = FALLBACK_BUILDERS[event?.kind];
  const text = builder ? builder(event) : (action?.fallbackText ? sanitizeInlineText(action.fallbackText, { maxChars: 200 }) : DEFAULT_FALLBACK_TEXT);
  return Object.freeze({
    text,
    reason,
    summary: (() => {
      try {
        return formatStreamEvent(event)?.summary ?? null;
      } catch {
        return null;
      }
    })(),
  });
}
