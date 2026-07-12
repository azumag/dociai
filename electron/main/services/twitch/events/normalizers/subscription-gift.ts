// Issue #90: `channel.subscription.gift@1` -> StreamEvent(kind: "gift-subscription").
//
// Real Twitch field names verified verbatim against dev.twitch.tv/docs/eventsub/eventsub-
// subscription-types/'s own documented "Channel Subscription Gift Event" example JSON (`event`
// object):
//   user_id, user_login, user_name, broadcaster_user_id, broadcaster_user_login,
//   broadcaster_user_name, total, tier, cumulative_total, is_anonymous.
// Cross-checked against the independent twitch-rs crate's `ChannelSubscriptionGiftV1Payload`
// (same field list) — see ../twitch-event-normalizer.ts's own module doc comment for the full
// source list.
//
// `is_anonymous: true` nulls out the gifter's `user_id`/`user_login`/`user_name` on Twitch's own
// side — same rule as cheer.ts, never recovered/guessed here (see ./shared.ts's `buildActor()`).
// `cumulative_total` (the gifter's lifetime gifting total) is documented nullable — a gifter can
// opt out of sharing it — handled by `optionalInteger()` treating `null` like `undefined`, no
// warning.
//
// `total` (this gift BATCH's count, e.g. "gifted 5 subs at once") maps to StreamEvent's
// `GiftSubscriptionEventData.count` — note this is intentionally NOT the same Twitch field as
// subscription.message's `duration_months` (a different axis: how many subs in this batch, vs how
// many months a single sub covers).
import { CURRENT_SCHEMA_VERSION, SUBSCRIPTION_TIERS } from "../../../../../../src/stream-events/contract.js";
import type { StreamEvent } from "../../../../../../src/stream-events/contract.js";
import { optionalInteger, requireEnum, requireInteger } from "../event-validation";
import type { NormalizeIssue } from "../event-validation";
import { asRecord, buildActor, buildChannel, resolveTimestamp } from "./shared";
import type { NormalizeInput } from "../twitch-event-normalizer";

export function normalizeSubscriptionGift(input: NormalizeInput): { event: StreamEvent | null; issues: NormalizeIssue[] } {
  const issues: NormalizeIssue[] = [];
  const raw = asRecord(input.event);
  const isAnonymous = raw.is_anonymous === true;

  const actor = buildActor({ id: raw.user_id, login: raw.user_login, name: raw.user_name }, isAnonymous, issues);
  const channel = buildChannel({ id: raw.broadcaster_user_id, login: raw.broadcaster_user_login, name: raw.broadcaster_user_name }, issues);
  const tier = requireEnum(raw.tier, "data.tier", SUBSCRIPTION_TIERS, issues);
  // Twitch's own minimum gift batch size is 1 — a "gift" of 0 subscriptions is not a real shape.
  const count = requireInteger(raw.total, "data.count", issues, { min: 1 });

  if (!actor || !channel || tier === null || count === null) return { event: null, issues };

  // subscription.gift carries no timestamp field of its own — always falls through to the
  // message envelope's message_timestamp (or, failing that, receivedAt).
  const timestamp = resolveTimestamp(input, issues);

  const cumulativeTotal = optionalInteger(raw.cumulative_total, "data.cumulativeTotal", issues, { min: 0 });

  const event: StreamEvent = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: input.messageId,
    kind: "gift-subscription",
    timestamp,
    actor,
    channel,
    sourceMetadata: { subscriptionType: "channel.subscription.gift", subscriptionVersion: "1" },
    data: { tier, count, ...(cumulativeTotal !== undefined ? { cumulativeTotal } : {}) },
  };
  return { event, issues };
}
