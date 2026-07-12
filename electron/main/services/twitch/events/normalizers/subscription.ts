// Issue #90: `channel.subscribe@1` -> StreamEvent(kind: "subscription").
//
// Real Twitch field names verified verbatim against dev.twitch.tv/docs/eventsub/eventsub-
// subscription-types/'s own documented "Channel Subscribe Event" example JSON (`event` object):
//   user_id, user_login, user_name, broadcaster_user_id, broadcaster_user_login,
//   broadcaster_user_name, tier, is_gift.
// Cross-checked against the independent twitch-rs crate's `ChannelSubscribeV1Payload` (same field
// list) — see ../twitch-event-normalizer.ts's own module doc comment for the full source list.
//
// Unlike cheer/subscription.gift, `channel.subscribe` documents no `is_anonymous` field at all —
// a (non-gift) subscription is never anonymous from Twitch's own EventSub perspective, so this
// normalizer always builds a named actor.
import { CURRENT_SCHEMA_VERSION, SUBSCRIPTION_TIERS } from "../../../../../../src/stream-events/contract.js";
import type { StreamEvent } from "../../../../../../src/stream-events/contract.js";
import { optionalBoolean, requireEnum } from "../event-validation";
import type { NormalizeIssue } from "../event-validation";
import { asRecord, buildActor, buildChannel, resolveTimestamp } from "./shared";
import type { NormalizeInput } from "../twitch-event-normalizer";

export function normalizeSubscription(input: NormalizeInput): { event: StreamEvent | null; issues: NormalizeIssue[] } {
  const issues: NormalizeIssue[] = [];
  const raw = asRecord(input.event);

  const actor = buildActor({ id: raw.user_id, login: raw.user_login, name: raw.user_name }, false, issues);
  const channel = buildChannel({ id: raw.broadcaster_user_id, login: raw.broadcaster_user_login, name: raw.broadcaster_user_name }, issues);
  const tier = requireEnum(raw.tier, "data.tier", SUBSCRIPTION_TIERS, issues);

  if (!actor || !channel || tier === null) return { event: null, issues };

  // channel.subscribe carries no timestamp field of its own — always falls through to the
  // message envelope's message_timestamp (or, failing that, receivedAt).
  const timestamp = resolveTimestamp(input, issues);

  const isGift = optionalBoolean(raw.is_gift, "data.isGift", issues);

  const event: StreamEvent = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: input.messageId,
    kind: "subscription",
    timestamp,
    actor,
    channel,
    sourceMetadata: { subscriptionType: "channel.subscribe", subscriptionVersion: "1" },
    data: { tier, ...(isGift !== undefined ? { isGift } : {}) },
  };
  return { event, issues };
}
