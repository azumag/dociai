// Issue #90: the documented `event timestamp -> message timestamp -> receivedAt` fallback chain
// for a StreamEvent's own `timestamp` field.
//
// Only ONE of these 5 subscription types documents a per-event timestamp field at all
// (`channel.channel_points_custom_reward_redemption.add`'s `redeemed_at` — cheer/subscribe/
// subscription.message/subscription.gift carry no timestamp of their own in Twitch's documented
// event body). For those 4, `eventTimestamp` is simply never passed in and this always falls
// through to the 2nd link: the EventSub message envelope's own `message_timestamp`
// (`metadata.message_timestamp` — see electron/main/services/twitch/eventsub/eventsub-message-
// parser.ts's `EventSubMetadata`), which Twitch populates on every notification. The 3rd link
// (local receipt time) exists purely as a last-resort so a StreamEvent's `timestamp` field is
// ALWAYS a valid ISO-8601 string, never dependent on Twitch having sent anything parseable at all
// — it can never itself be malformed, since it is derived from this process's own clock.
//
// A malformed candidate at an EARLIER link in the chain is never allowed to produce an Invalid
// Date on the resulting StreamEvent — it is flagged (a `warning` NormalizeIssue) and the chain
// simply moves to the next link, rather than either throwing or silently emitting a broken
// timestamp string that would then fail #89's `validateStreamEvent()` downstream.
import type { NormalizeIssue } from "./event-validation";
import { fieldIssue } from "./event-validation";

export type TimestampSource = "event" | "message" | "receivedAt";

export type NormalizedTimestamp = {
  timestamp: string;
  source: TimestampSource;
  issues: NormalizeIssue[];
};

// `Date.parse()` alone is NOT sufficient to recognize "a real timestamp": V8's legacy
// (non-ISO-8601) date-parsing fallback happily accepts bare short numeric strings like "12345" or
// "123456" as a parseable (year-only-ish) date, producing a wildly wrong-but-finite result (e.g.
// `Date.parse("12345")` -> a date in the year 12344) rather than `NaN`. Twitch's real
// `message_timestamp`/`redeemed_at` values are always full RFC3339 strings (e.g.
// "2019-11-16T10:11:12.634234626Z"), so requiring an ISO-8601-shaped `YYYY-MM-DDT` prefix before
// ever calling `Date.parse()` rejects that numeric-string quirk while still accepting every
// legitimate Twitch timestamp.
const ISO_8601_DATE_TIME_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

/** Validates AND converts in one step, deliberately returning the ISO string it computed from the
 * TRIMMED candidate — never re-parses the original untrimmed value a second time. Doing those two
 * steps separately (validate the trimmed string, then separately hand the ORIGINAL untrimmed
 * string to `new Date(...)`) is a real footgun: `new Date(" 2019-11-16T10:11:12Z ")` (note the
 * padding) THROWS `RangeError: Invalid time value` even though `Date.parse()` on the trimmed
 * version is perfectly valid — V8's ISO-8601 fast path is stricter about leading/trailing
 * whitespace than its own `Date.parse()` pre-check. Wrapped in try/catch as defense-in-depth on
 * top of the ISO-prefix + `Number.isFinite` gates above (this function must NEVER throw). */
function parseTimestampCandidate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !ISO_8601_DATE_TIME_PREFIX.test(trimmed) || !Number.isFinite(Date.parse(trimmed))) return null;
  try {
    return new Date(trimmed).toISOString();
  } catch {
    return null;
  }
}

export type NormalizeEventTimestampInput = {
  /** The raw Twitch event's own timestamp field, if this subscription type documents one (only
   * reward-redemption's `redeemed_at` does — every other normalizer omits this entirely). */
  eventTimestamp?: unknown;
  /** The EventSub message envelope's `metadata.message_timestamp` — always present on a real
   * notification, but still treated as untrusted input here (defensive against a malformed/
   * fixture-constructed envelope). */
  messageTimestamp?: unknown;
  /** Local receipt clock (ms since epoch) — the guaranteed-valid last resort. */
  receivedAtMs: number;
};

/** Walks the fallback chain and returns the first valid candidate, in `event -> message ->
 * receivedAt` order. Never throws, and the returned `timestamp` is always a valid ISO-8601
 * string. */
export function normalizeEventTimestamp(input: NormalizeEventTimestampInput): NormalizedTimestamp {
  const issues: NormalizeIssue[] = [];

  if (input.eventTimestamp !== undefined && input.eventTimestamp !== null) {
    const parsed = parseTimestampCandidate(input.eventTimestamp);
    if (parsed !== null) return { timestamp: parsed, source: "event", issues };
    issues.push(
      fieldIssue(
        "timestamp",
        "type.malformedTimestamp",
        "the event's own timestamp field is present but malformed; falling back to the EventSub message envelope's message_timestamp",
        "warning",
      ),
    );
  }

  if (input.messageTimestamp !== undefined && input.messageTimestamp !== null) {
    const parsed = parseTimestampCandidate(input.messageTimestamp);
    if (parsed !== null) return { timestamp: parsed, source: "message", issues };
    issues.push(
      fieldIssue(
        "timestamp",
        "type.malformedTimestamp",
        "the EventSub message envelope's message_timestamp is present but malformed; falling back to local receipt time",
        "warning",
      ),
    );
  }

  // The guaranteed-valid last resort — but `receivedAtMs` is still a value the public
  // `NormalizeInput` type lets a caller pass directly (not always the `Date.now()` default every
  // current normalizer call site happens to use), so it is validated too rather than handed
  // straight to `new Date(...)`: `new Date(NaN).toISOString()` throws, which would break this
  // function's own "never throws" contract for a caller that passed e.g. `receivedAtMs: NaN`.
  const receivedAtMs = Number.isFinite(input.receivedAtMs) ? input.receivedAtMs : Date.now();
  return { timestamp: new Date(receivedAtMs).toISOString(), source: "receivedAt", issues };
}
