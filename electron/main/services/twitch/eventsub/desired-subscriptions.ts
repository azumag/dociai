// Issue #87: pure function turning (enabledFeatures, broadcasterUserId) into the desired EventSub
// subscription set — one descriptor per one of the 5 subscription types this sub-epic targets (see
// #90's normalizer file list — normalizers/{cheer,subscription,subscription-message,subscription-
// gift,reward-redemption}.ts — which is what pins down these 5 as the real target set).
//
// Cross-checked against Twitch's own EventSub Subscription Types reference
// (https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/) and the Twitch4J
// EventSubSubscriptionStatus catalog while implementing this issue:
//
//   type                                                     version  condition              scope
//   channel.cheer                                                 1   broadcaster_user_id    bits:read
//   channel.subscribe                                             1   broadcaster_user_id    channel:read:subscriptions
//   channel.subscription.message                                  1   broadcaster_user_id    channel:read:subscriptions
//   channel.subscription.gift                                     1   broadcaster_user_id    channel:read:subscriptions
//   channel.channel_points_custom_reward_redemption.add           1   broadcaster_user_id    channel:read:redemptions
//
// (`channel.subscription.message`/`channel.subscription.gift` use "subscription", not "subscribe",
// and a dot separator — easy to mistype as `channel.subscribe_message`/`channel.subscribe_gift`;
// verified against two independent sources before hardcoding.) None of these 5 documented
// condition schemas need `moderator_user_id` (that's for subscription types outside this app's
// scope, e.g. channel.moderate) — every one of them accepts, and for this app's purposes only ever
// needs, a single `broadcaster_user_id` condition field. `channel.channel_points_custom_reward_
// redemption.add` additionally documents an OPTIONAL `reward_id` condition (filter to one specific
// reward) which this app deliberately never sets — the app wants every redemption on the channel,
// not just one reward.
//
// Reuses twitch-scope-registry.ts's feature -> scope mapping (issue #85) rather than redefining
// which scope each feature needs a second time.
import { FEATURE_SCOPES, isTwitchFeature } from "../auth/twitch-scope-registry";
import type { TwitchFeature } from "../auth/twitch-scope-registry";
import { subscriptionKey } from "./subscription-registry";
import type { SubscriptionCondition, SubscriptionDescriptor } from "./subscription-registry";

export type DesiredSubscription = SubscriptionDescriptor & {
  readonly key: string;
  readonly feature: TwitchFeature;
  readonly requiredScopes: readonly string[];
};

type EventDefinition = { readonly type: string; readonly version: string; readonly feature: TwitchFeature };

/** The 5 real, version-checked Twitch EventSub subscription type strings this sub-epic targets —
 * see the module doc comment for where each was cross-checked. Order here is stable but not
 * semantically meaningful; desiredSubscriptions() below always returns them in this order. */
export const EVENT_DEFINITIONS: readonly EventDefinition[] = Object.freeze([
  Object.freeze({ type: "channel.cheer", version: "1", feature: "bits" as const }),
  Object.freeze({ type: "channel.subscribe", version: "1", feature: "subscriptions" as const }),
  Object.freeze({ type: "channel.subscription.message", version: "1", feature: "subscriptions" as const }),
  Object.freeze({ type: "channel.subscription.gift", version: "1", feature: "subscriptions" as const }),
  Object.freeze({ type: "channel.channel_points_custom_reward_redemption.add", version: "1", feature: "redemptions" as const }),
]);

/** "current broadcaster/authからdesired setを算出" — a pure projection with no knowledge of WHERE
 * the broadcaster id or enabled-feature set come from (twitch-auth-coordinator.ts's account/
 * setEnabledFeatures, in production). An empty/falsy `broadcasterUserId` (not yet known — e.g.
 * before the very first successful Helix Users lookup) always yields an empty desired set, the
 * same "nothing to do yet" semantic eventsub-service.ts's own desired_empty status uses. Unknown
 * feature names are silently ignored (mirrors requiredScopesFor()'s own stance — this function's
 * job is the feature -> subscription mapping, not validating the caller's feature-toggle input). */
export function desiredSubscriptions(enabledFeatures: readonly string[], broadcasterUserId: string | null | undefined): DesiredSubscription[] {
  if (!broadcasterUserId) return [];
  const features = new Set(enabledFeatures.filter(isTwitchFeature));
  const result: DesiredSubscription[] = [];
  for (const definition of EVENT_DEFINITIONS) {
    if (!features.has(definition.feature)) continue;
    const condition: SubscriptionCondition = Object.freeze({ broadcaster_user_id: broadcasterUserId });
    const descriptor: SubscriptionDescriptor = { type: definition.type, version: definition.version, condition };
    result.push({ ...descriptor, key: subscriptionKey(descriptor), feature: definition.feature, requiredScopes: FEATURE_SCOPES[definition.feature] });
  }
  return result;
}

/** Every scope desiredSubscriptions() could ever require for the given list, deduped+sorted — lets
 * the reconciler call getValidAccessToken(requiredScopes) once for a whole batch rather than once
 * per descriptor (mirrors requiredScopesFor()'s own dedupe/sort convention in twitch-scope-
 * registry.ts). */
export function requiredScopesForDesired(desired: readonly DesiredSubscription[]): string[] {
  return [...new Set(desired.flatMap((entry) => entry.requiredScopes))].sort();
}
