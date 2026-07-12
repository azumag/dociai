// Issue #90: `channel.subscription.message@1` -> StreamEvent(kind: "resub").
//
// Real Twitch field names verified verbatim against dev.twitch.tv/docs/eventsub/eventsub-
// subscription-types/'s own documented "Channel Subscription Message Event" example JSON (`event`
// object):
//   user_id, user_login, user_name, broadcaster_user_id, broadcaster_user_login,
//   broadcaster_user_name, tier, message: { text, emotes: [{ begin, end, id }] },
//   cumulative_months, streak_months, duration_months.
// Cross-checked against the independent twitch-rs crate's `ChannelSubscriptionMessageV1Payload`
// (same field list) — see ../twitch-event-normalizer.ts's own module doc comment for the full
// source list.
//
// `streak_months` is documented as nullable — streak-sharing is an opt-in viewer setting, so
// `null` here is a normal, expected shape (NOT an anomaly worth a warning), handled by
// event-validation.ts's `optionalInteger()` treating `null` exactly like `undefined`.
//
// `duration_months` (how many months this single message/purchase covers, e.g. a multi-month gift
// applied at once) has no corresponding slot on StreamEvent's `ResubEventData` (`{ tier,
// cumulativeMonths, streakMonths?, message? }` — see src/stream-events/contract.d.ts) — kept as
// `sourceMetadata.durationMonths` instead of being silently dropped, since it is useful platform
// context even though it isn't part of the generic domain shape.
import { CURRENT_SCHEMA_VERSION, SUBSCRIPTION_TIERS } from "../../../../../../src/stream-events/contract.js";
import type { StreamEvent } from "../../../../../../src/stream-events/contract.js";
import { optionalInteger, requireEnum, requireInteger } from "../event-validation";
import type { NormalizeIssue } from "../event-validation";
import { sanitizeOptionalText } from "../text-sanitizer";
import { asRecord, buildActor, buildChannel, resolveTimestamp } from "./shared";
import type { NormalizeInput } from "../twitch-event-normalizer";

export function normalizeSubscriptionMessage(input: NormalizeInput): { event: StreamEvent | null; issues: NormalizeIssue[] } {
  const issues: NormalizeIssue[] = [];
  const raw = asRecord(input.event);

  const actor = buildActor({ id: raw.user_id, login: raw.user_login, name: raw.user_name }, false, issues);
  const channel = buildChannel({ id: raw.broadcaster_user_id, login: raw.broadcaster_user_login, name: raw.broadcaster_user_name }, issues);
  const tier = requireEnum(raw.tier, "data.tier", SUBSCRIPTION_TIERS, issues);
  const cumulativeMonths = requireInteger(raw.cumulative_months, "data.cumulativeMonths", issues, { min: 1 });

  if (!actor || !channel || tier === null || cumulativeMonths === null) return { event: null, issues };

  // subscription.message carries no top-level timestamp field of its own — always falls through
  // to the message envelope's message_timestamp (or, failing that, receivedAt).
  const timestamp = resolveTimestamp(input, issues);

  const streakMonths = optionalInteger(raw.streak_months, "data.streakMonths", issues, { min: 0 });
  const messageText = sanitizeOptionalText(asRecord(raw.message).text, "data.message", issues);
  const durationMonths = optionalInteger(raw.duration_months, "sourceMetadata.durationMonths", issues, { min: 1 });

  const event: StreamEvent = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: input.messageId,
    kind: "resub",
    timestamp,
    actor,
    channel,
    sourceMetadata: {
      subscriptionType: "channel.subscription.message",
      subscriptionVersion: "1",
      ...(durationMonths !== undefined ? { durationMonths } : {}),
    },
    data: {
      tier,
      cumulativeMonths,
      ...(streakMonths !== undefined ? { streakMonths } : {}),
      ...(messageText !== undefined ? { message: messageText } : {}),
    },
  };
  return { event, issues };
}
