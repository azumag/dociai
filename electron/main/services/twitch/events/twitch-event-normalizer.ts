// Issue #90: `type@version` -> normalizer dispatch table, plus the `NormalizeResult` envelope
// every normalizer under ./normalizers/*.ts effectively produces (each returns the narrower
// `{ event, issues }` shape; this module wraps that into the full result with diagnostics).
// Mirrors src/stream-events/contract.js's own `issue()`/`successResult()`/`failureResult()`
// structured-result shape (#89) one level up the pipeline, so a caller already familiar with the
// StreamEvent contract recognizes this shape immediately.
//
// An unrecognized `type@version` (a Twitch subscription type/version this build has no normalizer
// for — either a genuinely new Twitch type, or a version bump like `channel.cheer@2`) is NEVER a
// silent drop (issue #90's own "unknown event/versionをdiagnosticへ保持し無言dropしない"):
// `normalizeTwitchEvent()` always returns a `NormalizeResult` a caller can log/diagnose —
// `ok: false` with an `error`-severity `unknown_subscription` issue — rather than returning
// null/throwing/doing nothing.
//
// Real Twitch EventSub payload field names for the 5 supported type@version pairs below were
// verified against dev.twitch.tv/docs/eventsub/eventsub-subscription-types/'s own documented
// example JSON (verbatim for cheer/subscribe/subscription.message/subscription.gift) and, for
// channel_points_custom_reward_redemption.add (whose docs page did not surface a full JSON
// example through automated fetching), twitchdev's own official `twitch-cli` mock-event source
// (github.com/twitchdev/twitch-cli — internal/models/redemption.go's `RedemptionEventSubEvent`/
// `RedemptionReward` struct json tags), cross-checked against the independent twitch-rs crate's
// `ChannelPointsCustomRewardRedemptionAddV1Payload` — see each ./normalizers/*.ts file's own doc
// comment for the exact field list that normalizer targets.
import type { StreamEvent } from "../../../../../src/stream-events/contract.js";
import type { NormalizeIssue } from "./event-validation";
import { fieldIssue } from "./event-validation";
import { normalizeCheer } from "./normalizers/cheer";
import { normalizeSubscription } from "./normalizers/subscription";
import { normalizeSubscriptionMessage } from "./normalizers/subscription-message";
import { normalizeSubscriptionGift } from "./normalizers/subscription-gift";
import { normalizeRewardRedemption } from "./normalizers/reward-redemption";

export type { NormalizeIssue } from "./event-validation";

/** The raw inputs a normalizer function needs — deliberately NOT "the whole EventSub envelope"
 * (electron/main/services/twitch/eventsub/eventsub-message-parser.ts's `EventSubEnvelope`) passed
 * straight through, so a normalizer stays trivial to unit-test directly off a fixture's plain
 * `event` object without constructing a full envelope every time, and so this whole directory
 * stays usable fixture-driven without #86/#87 actually wired up (per issue #90's own framing). */
export type NormalizeInput = {
  /** `payload.event` — the raw Twitch event body, still fully untrusted. */
  event: unknown;
  /** The EventSub message envelope's own `metadata.message_id`. Twitch guarantees this unique per
   * delivery (the same guarantee electron/main/services/twitch/eventsub/notification-dedupe.ts's
   * own dedupe cache already keys on) — it becomes this StreamEvent's `id` directly, so a
   * downstream StreamEventBus dedupes a redelivered notification for free. CRITICAL: a missing/
   * blank messageId fails normalization outright, regardless of subscription type. */
  messageId: string;
  /** The EventSub message envelope's own `metadata.message_timestamp` — the timestamp fallback
   * chain's 2nd link; see timestamp-normalizer.ts. */
  messageTimestamp?: string;
  /** Local receipt clock (ms since epoch) — the timestamp fallback chain's last resort. Defaults
   * to `Date.now()` so callers never have to thread a clock through just to normalize one event,
   * but is overridable for deterministic tests. */
  receivedAtMs?: number;
  /** Opt-in only (default: false/off) — see `boundedRedactedRawPayload()` below for exactly what
   * "opt-in/bounded/redacted" means here. */
  keepRawPayload?: boolean;
};

export type NormalizeDiagnostics = {
  type: string;
  version: string;
  messageId: string;
  /** Present ONLY when the caller opted in via `keepRawPayload: true`. This NEVER lives inside the
   * returned `StreamEvent` itself — it is a sibling field on `NormalizeResult`, a
   * diagnostics-only return value a caller may log/inspect and then discard, never merged into
   * `sourceMetadata` (which would trip #89's raw-payload-leak guard — see contract.js's
   * `isForbiddenRawPayloadKey()`/`findRawPayloadLeaks()`) and never published onto the
   * StreamEventBus. */
  rawPayload?: unknown;
};

export type NormalizeResult =
  | { ok: true; event: StreamEvent; issues: readonly NormalizeIssue[]; diagnostics: NormalizeDiagnostics }
  | { ok: false; issues: readonly NormalizeIssue[]; diagnostics: NormalizeDiagnostics };

export type NormalizerFn = (input: NormalizeInput) => { event: StreamEvent | null; issues: NormalizeIssue[] };

/** `type@version` -> normalizer. Uses the same `${type}@${version}` shape electron/main/services/
 * twitch/eventsub/subscription-registry.ts's `subscriptionKey()` encodes type/version as elsewhere
 * in this app, but does NOT reuse `subscriptionKey()` itself — that function also folds in
 * `condition`, which is irrelevant here; a normalizer is selected by type+version alone. */
const NORMALIZERS: Readonly<Record<string, NormalizerFn>> = Object.freeze({
  "channel.cheer@1": normalizeCheer,
  "channel.subscribe@1": normalizeSubscription,
  "channel.subscription.message@1": normalizeSubscriptionMessage,
  "channel.subscription.gift@1": normalizeSubscriptionGift,
  "channel.channel_points_custom_reward_redemption.add@1": normalizeRewardRedemption,
});

/** The exact 5 `type@version` strings this build has a normalizer for — exported so a caller
 * (e.g. a future eventsub-session.ts wiring, or a test) can check support without constructing a
 * throwaway `NormalizeInput`. */
export const SUPPORTED_TYPE_VERSIONS: readonly string[] = Object.freeze(Object.keys(NORMALIZERS));

/** Bounds how much of a raw payload's JSON an opt-in debug retention keeps, even for a single
 * pathological payload — never truly unbounded. */
const MAX_RAW_PAYLOAD_DEBUG_CHARS = 8000;

/** Twitch's own lowercase, unique account handle (`*_login`) is the one piece of identity info
 * present in these 5 raw payload shapes that is NOT already mirrored into the published
 * StreamEvent's own `actor`/`channel` (`id` + a `name`-derived `displayName` only — see
 * ./normalizers/shared.ts's `buildActor()`/`buildChannel()`). Redacted out of the opt-in debug
 * copy so it is never duplicated into a log beyond what the published event itself already
 * carries — issue #90's "not accidentally exposing more PII than necessary in a debug log". */
const LOGIN_KEY_PATTERN = /_login$/i;

function redactRawPayload(value: unknown, depth: number): unknown {
  if (!value || typeof value !== "object") return value;
  // Past the depth cap, an object/array subtree is replaced with a placeholder rather than passed
  // through unchanged — real Twitch payloads for these 5 types are only a couple of levels deep,
  // so this never fires in practice, but passing an unexamined subtree through here would mean a
  // `*_login`-suffixed key nested deeper than the cap could leak into the "redacted" debug copy
  // unredacted, silently contradicting this function's own guarantee.
  if (depth > 8) return "[maxDepthExceeded]";
  if (Array.isArray(value)) return value.map((item) => redactRawPayload(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = LOGIN_KEY_PATTERN.test(key) ? "[redacted]" : redactRawPayload(nested, depth + 1);
  }
  return out;
}

/** Redacts, then bounds the JSON size of, a debug-retained raw payload copy — issue #90's own
 * "raw payload debug retentionをopt-in/bounded/redactedにする". Only ever invoked when the caller
 * explicitly opted in via `keepRawPayload: true` (default: never called at all). */
function boundedRedactedRawPayload(event: unknown): unknown {
  const redacted = redactRawPayload(event, 0);
  let json: string;
  try {
    json = JSON.stringify(redacted) ?? "null";
  } catch {
    return "[unserializable]";
  }
  return json.length <= MAX_RAW_PAYLOAD_DEBUG_CHARS ? redacted : { truncated: true, preview: json.slice(0, MAX_RAW_PAYLOAD_DEBUG_CHARS) };
}

function buildDiagnostics(type: string, version: string, input: NormalizeInput): NormalizeDiagnostics {
  return {
    type,
    version,
    messageId: input.messageId,
    ...(input.keepRawPayload ? { rawPayload: boundedRedactedRawPayload(input.event) } : {}),
  };
}

/** Normalizes one raw Twitch EventSub `notification` event into a `StreamEvent`, dispatching on
 * `${type}@${version}`. Never throws. An unrecognized `type@version`, or a missing/blank
 * `messageId`, is reported via `ok: false` rather than silently dropped — see the module doc
 * comment above. */
export function normalizeTwitchEvent(type: string, version: string, input: NormalizeInput): NormalizeResult {
  const diagnostics = buildDiagnostics(type, version, input);

  if (typeof input.messageId !== "string" || input.messageId.trim().length === 0) {
    return {
      ok: false,
      issues: [fieldIssue("messageId", "required", "the EventSub message envelope's message_id is required to derive a stable StreamEvent id", "error")],
      diagnostics,
    };
  }

  const key = `${type}@${version}`;
  const normalizer = NORMALIZERS[key];
  if (!normalizer) {
    return {
      ok: false,
      issues: [fieldIssue("type", "unknown_subscription", `no normalizer registered for "${key}" — this Twitch EventSub type/version is unrecognized or not yet supported`, "error")],
      diagnostics,
    };
  }

  const { event, issues } = normalizer(input);
  if (!event) return { ok: false, issues, diagnostics };
  return { ok: true, event, issues, diagnostics };
}
