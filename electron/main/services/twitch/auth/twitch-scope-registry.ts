// Issue #85: pure feature -> Twitch OAuth scope mapping for the app's currently-supported
// EventSub-observing features (bits/subscriptions/redemptions — see parent #51). No I/O, no
// state — twitch-auth-coordinator.ts computes every scope decision by calling the functions below,
// never by hardcoding a scope string itself.
//
// Deliberately READ-ONLY scopes: `bits:read` / `channel:read:subscriptions` /
// `channel:read:redemptions` are Twitch's own documented scope names
// (https://dev.twitch.tv/docs/authentication/scopes/) for *observing* the Bits, Subscription, and
// Channel-Points-Redemption EventSub topics respectively. None of this app's currently-supported
// features write/manage anything on the broadcaster's behalf, so the corresponding `:manage`
// variant (e.g. `channel:manage:redemptions`, needed only to create/update a Channel Points reward
// definition) must never appear here — see twitch-scope-registry.test's "never requires a :manage
// scope" assertion, which is the literal test for issue #85's "read scopeのみでmanage scopeを要求
// しない" requirement.
export type TwitchFeature = "bits" | "subscriptions" | "redemptions";

const ALL_FEATURES: readonly TwitchFeature[] = ["bits", "subscriptions", "redemptions"];

export const FEATURE_SCOPES: Readonly<Record<TwitchFeature, readonly string[]>> = Object.freeze({
  bits: Object.freeze(["bits:read"]),
  subscriptions: Object.freeze(["channel:read:subscriptions"]),
  redemptions: Object.freeze(["channel:read:redemptions"]),
});

export function isTwitchFeature(value: string): value is TwitchFeature {
  return (ALL_FEATURES as readonly string[]).includes(value);
}

/** Sorts + dedupes, mirroring twitch-auth-state.ts's normalizeScopes() so two callers requesting
 * the same effective feature set always get an identically-ordered scope list regardless of
 * feature-toggle order (both ultimately feed the same scopeFingerprint machinery in
 * twitch-auth-state.ts). Unrecognized feature names are silently ignored: this registry's only job
 * is the feature -> scope mapping, not validating that a caller-supplied feature toggle set is
 * well-formed. */
export function requiredScopesFor(enabledFeatures: readonly string[]): string[] {
  const scopes = new Set<string>();
  for (const feature of enabledFeatures) {
    if (!isTwitchFeature(feature)) continue;
    for (const scope of FEATURE_SCOPES[feature]) scopes.add(scope);
  }
  return [...scopes].sort();
}

export type ScopeDiff = { required: string[]; granted: string[]; missing: string[] };

/** "current/granted/required/missing scopeを算出" (issue #85's TODO) — a pure diff with no
 * knowledge of *why* scopes are required (requiredScopesFor's job) or what to do about a non-empty
 * `missing` (twitch-auth-coordinator.ts's checkScopesForFeatures()'s job). `grantedScopes` is
 * expected to be whatever Twitch's own /oauth2/validate most recently reported for the current
 * token (see auth-metadata-repository.ts's `scopes` field) — never the scopes that were merely
 * *requested* at authorization time, since Twitch is the sole source of truth for what a token
 * actually carries. */
export function diffScopes(requiredScopes: readonly string[], grantedScopes: readonly string[]): ScopeDiff {
  const granted = [...new Set(grantedScopes)].sort();
  const grantedSet = new Set(granted);
  const required = [...new Set(requiredScopes)].sort();
  const missing = required.filter((scope) => !grantedSet.has(scope));
  return { required, granted, missing };
}
