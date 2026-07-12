// Issue #90: `channel.cheer@1` -> StreamEvent(kind: "cheer").
//
// Real Twitch field names verified verbatim against dev.twitch.tv/docs/eventsub/eventsub-
// subscription-types/'s own documented "Channel Cheer Event" example JSON (`event` object):
//   is_anonymous, user_id, user_login, user_name, broadcaster_user_id, broadcaster_user_login,
//   broadcaster_user_name, message, bits.
// Cross-checked against the independent twitch-rs crate's `ChannelCheerV1Payload` (same field
// list) — see ../twitch-event-normalizer.ts's own module doc comment for the full source list.
//
// `is_anonymous: true` nulls out `user_id`/`user_login`/`user_name` on Twitch's own side — this
// normalizer NEVER attempts to recover an identity in that case (see ./shared.ts's `buildActor()`
// doc comment for why).
import { CURRENT_SCHEMA_VERSION } from "../../../../../../src/stream-events/contract.js";
import type { StreamEvent } from "../../../../../../src/stream-events/contract.js";
import { requireInteger } from "../event-validation";
import type { NormalizeIssue } from "../event-validation";
import { sanitizeOptionalText } from "../text-sanitizer";
import { asRecord, buildActor, buildChannel, resolveTimestamp } from "./shared";
import type { NormalizeInput } from "../twitch-event-normalizer";

export function normalizeCheer(input: NormalizeInput): { event: StreamEvent | null; issues: NormalizeIssue[] } {
  const issues: NormalizeIssue[] = [];
  const raw = asRecord(input.event);
  const isAnonymous = raw.is_anonymous === true;

  const actor = buildActor({ id: raw.user_id, login: raw.user_login, name: raw.user_name }, isAnonymous, issues);
  const channel = buildChannel({ id: raw.broadcaster_user_id, login: raw.broadcaster_user_login, name: raw.broadcaster_user_name }, issues);
  // Twitch's own bits minimum is 1 — a cheer of 0 (or negative) bits is not a real event shape.
  const bits = requireInteger(raw.bits, "data.bits", issues, { min: 1 });

  if (!actor || !channel || bits === null) return { event: null, issues };

  // Cheer events carry no timestamp field of their own in Twitch's documented payload — always
  // falls through to the message envelope's message_timestamp (or, failing that, receivedAt).
  const timestamp = resolveTimestamp(input, issues);

  const message = sanitizeOptionalText(raw.message, "data.message", issues);

  const event: StreamEvent = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: input.messageId,
    kind: "cheer",
    timestamp,
    actor,
    channel,
    sourceMetadata: { subscriptionType: "channel.cheer", subscriptionVersion: "1" },
    data: { bits, ...(message !== undefined ? { message } : {}) },
  };
  return { event, issues };
}
