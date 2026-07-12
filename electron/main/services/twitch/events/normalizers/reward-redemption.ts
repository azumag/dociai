// Issue #90: `channel.channel_points_custom_reward_redemption.add@1` -> StreamEvent(kind:
// "reward-redemption").
//
// dev.twitch.tv/docs/eventsub/eventsub-subscription-types/'s own "Channel Points Custom Reward
// Redemption Add Event" section did not surface a full example JSON block through automated
// fetching (unlike the other 4 types, verified verbatim above it) — field names here were instead
// verified against TWO independent sources that agree exactly:
//   1. twitchdev's own official `twitch-cli` mock-event generator (github.com/twitchdev/
//      twitch-cli, internal/models/redemption.go): `RedemptionEventSubEvent` struct with json
//      tags `id, broadcaster_user_id, broadcaster_user_login, broadcaster_user_name, user_id,
//      user_login, user_name, user_input, status, reward, redeemed_at`, and the nested
//      `RedemptionReward` struct: `id, title, cost, prompt`.
//   2. The independent twitch-rs crate's `ChannelPointsCustomRewardRedemptionAddV1Payload` (same
//      field list) and its `RedemptionStatus` enum, which documents FOUR values: `unknown,
//      unfulfilled, fulfilled, canceled` — note `unknown` is a real Twitch-documented value that
//      is NOT one of StreamEvent's own `fulfilled | unfulfilled | canceled` (see
//      src/stream-events/schemas.js's private `REWARD_REDEMPTION_STATUSES`) — handled below via
//      `optionalEnum()`, which degrades an unrecognized status to a warning + field omission
//      rather than failing the whole event.
//
// `id` (this redemption INSTANCE's own id — distinct from `reward.id`, the reward DEFINITION's
// id) has no slot on StreamEvent's `RewardRedemptionEventData`; kept as
// `sourceMetadata.redemptionId` since a future moderation-action feature (mark fulfilled/
// canceled) would need exactly this id.
import { CURRENT_SCHEMA_VERSION } from "../../../../../../src/stream-events/contract.js";
import type { StreamEvent } from "../../../../../../src/stream-events/contract.js";
import { optionalEnum, optionalNonEmptyString, requireInteger, requireNonEmptyString } from "../event-validation";
import type { NormalizeIssue } from "../event-validation";
import { sanitizeOptionalText, sanitizeRequiredText } from "../text-sanitizer";
import { asRecord, buildActor, buildChannel, resolveTimestamp } from "./shared";
import type { NormalizeInput } from "../twitch-event-normalizer";

/** Must match src/stream-events/schemas.js's own (unexported) `REWARD_REDEMPTION_STATUSES`
 * exactly — duplicated here since that constant is private to the schema-validation module (see
 * this file's own doc comment for why Twitch's real 4th value, `unknown`, is deliberately NOT in
 * this list). */
const REWARD_REDEMPTION_STATUSES = ["fulfilled", "unfulfilled", "canceled"] as const;

export function normalizeRewardRedemption(input: NormalizeInput): { event: StreamEvent | null; issues: NormalizeIssue[] } {
  const issues: NormalizeIssue[] = [];
  const raw = asRecord(input.event);
  const reward = asRecord(raw.reward);

  const actor = buildActor({ id: raw.user_id, login: raw.user_login, name: raw.user_name }, false, issues);
  const channel = buildChannel({ id: raw.broadcaster_user_id, login: raw.broadcaster_user_login, name: raw.broadcaster_user_name }, issues);
  const rewardId = requireNonEmptyString(reward.id, "data.rewardId", issues);
  const cost = requireInteger(reward.cost, "data.cost", issues, { min: 0 });
  const rewardTitle = sanitizeRequiredText(reward.title, "data.rewardTitle", issues);

  if (!actor || !channel || rewardId === null || cost === null || rewardTitle === null) return { event: null, issues };

  // redeemed_at is the one field, among these 5 subscription types, this normalizer actually has
  // an event-level timestamp for — falls back to the message envelope's message_timestamp, then
  // receivedAt, if malformed/absent.
  const timestamp = resolveTimestamp(input, issues, raw.redeemed_at);

  const userInput = sanitizeOptionalText(raw.user_input, "data.userInput", issues);
  const status = optionalEnum(raw.status, "data.status", REWARD_REDEMPTION_STATUSES, issues);
  const redemptionId = optionalNonEmptyString(raw.id, "sourceMetadata.redemptionId", issues);

  const event: StreamEvent = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: input.messageId,
    kind: "reward-redemption",
    timestamp,
    actor,
    channel,
    sourceMetadata: {
      subscriptionType: "channel.channel_points_custom_reward_redemption.add",
      subscriptionVersion: "1",
      ...(redemptionId !== undefined ? { redemptionId } : {}),
    },
    data: {
      rewardId,
      rewardTitle,
      cost,
      ...(userInput !== undefined ? { userInput } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  };
  return { event, issues };
}
