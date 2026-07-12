// Issue #87: pure key-generation + snapshot diffing for EventSub subscriptions. No I/O, no
// timers — mirrors eventsub-state.ts's role for #86 (pure state shapes) and twitch-scope-
// registry.ts's role for #85 (pure feature->scope mapping): the only thing that drives real
// Helix create/list/delete calls is subscription-reconciler.ts/eventsub-subscription-client.ts,
// but the STABLE KEY definition and the desired/actual diff algorithm both live here, framework-
// free, so every other module (tests included) shares exactly one definition of "same logical
// subscription".
//
// Twitch guarantees at most one ENABLED subscription per (type, version, condition) combination —
// creating a second one for the same triple returns 409 (see eventsub-subscription-client.ts).
// That makes (type, version, condition) the natural identity for "this is the subscription we
// mean", independent of which subscription id Twitch assigned it or which WebSocket session it is
// currently attached to. subscriptionKey() below encodes that identity as a single stable string.

export type SubscriptionCondition = Readonly<Record<string, string>>;

export type SubscriptionDescriptor = {
  readonly type: string;
  readonly version: string;
  readonly condition: SubscriptionCondition;
};

/** "type/version/sorted conditionからstable subscription keyを生成" (issue #87's TODO) —
 * `${type}@${version}:${sortedConditionEntries}`, condition keys sorted before joining so
 * `{a,b}` and `{b,a}` (same logical condition, different object key insertion order — e.g. object
 * literals built by different call sites) always produce the identical key. Deliberately never
 * includes the subscription id (Twitch assigns a new one per create call; it is never part of the
 * logical identity) or transport (a websocket session_id is a delivery detail, not part of "what
 * this subscription is about"). */
export function subscriptionKey(descriptor: SubscriptionDescriptor): string {
  const entries = Object.keys(descriptor.condition)
    .sort()
    .map((conditionKey) => `${conditionKey}=${descriptor.condition[conditionKey]}`)
    .join(",");
  return `${descriptor.type}@${descriptor.version}:${entries}`;
}

/** Actual Twitch-reported state for one subscription, as returned by `GET /helix/eventsub/
 * subscriptions` or `POST /helix/eventsub/subscriptions` (see eventsub-subscription-client.ts).
 * `status` is kept as a raw string (not narrowed to a union) since Twitch may add new status
 * values at any time — mirrors eventsub-message-parser.ts's "never treat today's known set as
 * exhaustive-forever" stance (see revocation-handler.ts for the revocation-specific subset). */
export type ActualSubscription = {
  readonly id: string;
  readonly type: string;
  readonly version: string;
  readonly condition: SubscriptionCondition;
  readonly status: string;
};

/** Builds a `key -> ActualSubscription` lookup from a raw list response — this is what makes
 * desired (desired-subscriptions.ts's output) and actual comparable at all: both are keyed by the
 * exact same subscriptionKey() function. */
export function indexActualSubscriptions(subscriptions: readonly ActualSubscription[]): Map<string, ActualSubscription> {
  const index = new Map<string, ActualSubscription>();
  for (const subscription of subscriptions) index.set(subscriptionKey(subscription), subscription);
  return index;
}

export type SubscriptionDiff = {
  /** Desired keys with no corresponding *active* actual entry — need a create call. */
  missing: string[];
  /** Actual keys the current desired set no longer wants (e.g. a feature was just disabled) —
   * candidates for the reconciler's own delete() housekeeping. */
  extra: string[];
  /** Desired keys already satisfied by an existing active actual subscription — nothing to do. */
  satisfied: string[];
};

/** "config変更時にdesired/actual差分を算出" — a pure 3-way set diff over subscription keys.
 * `isActive(actual)` lets the caller decide what counts as "already satisfies desired" (default:
 * `status === "enabled"`); an actual entry that fails that predicate (e.g. one Twitch already
 * reported as revoked) is treated as NOT satisfying desired, so it still shows up in `missing`
 * rather than `satisfied`. */
export function diffSubscriptions(
  desiredKeys: readonly string[],
  actual: ReadonlyMap<string, ActualSubscription>,
  isActive: (subscription: ActualSubscription) => boolean = (subscription) => subscription.status === "enabled",
): SubscriptionDiff {
  const desiredSet = new Set(desiredKeys);
  const missing: string[] = [];
  const satisfied: string[] = [];
  for (const key of desiredSet) {
    const found = actual.get(key);
    if (found && isActive(found)) satisfied.push(key);
    else missing.push(key);
  }
  const extra: string[] = [];
  for (const key of actual.keys()) if (!desiredSet.has(key)) extra.push(key);
  return { missing, extra, satisfied };
}
