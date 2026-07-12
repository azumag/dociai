// Hand-maintained type declaration for the pure-JS runtime module contract.js. There is no
// separate declaration BUILD step (same stance as src/config/*.js's own "no separate declaration
// build" comment) — this file is maintained by hand alongside contract.js's exports.
//
// Why this file exists at all (rather than following config-core's `@ts-expect-error` +
// implicit-any pattern): issue #89 explicitly requires a *compile-time* guard against a
// `rawPayload`/`raw`/etc. escape-hatch field reaching the bus, in addition to the runtime guard
// in contract.js. That is only possible if electron/main/services/stream-events/stream-event-
// bus.ts sees a real `StreamEvent` type (so TS's excess-property check can catch a literal like
// `{ ...validEvent, rawPayload: {...} }` at the call site). A colocated `contract.d.ts` next to
// `contract.js` is resolved by TypeScript for a `"./contract.js"` specifier under
// `moduleResolution: "Bundler"` even with `allowJs` off (verified empirically against this repo's
// own tsconfig.electron.json before committing to this structure) — esbuild still bundles the
// real contract.js at runtime/build time (see scripts/electron/build.mjs), so this file only ever
// affects `tsc --noEmit`, never runtime behavior.

export type StreamEventKind = "cheer" | "subscription" | "resub" | "gift-subscription" | "reward-redemption";

export type SubscriptionTier = "1000" | "2000" | "3000" | "prime";

export declare const CURRENT_SCHEMA_VERSION: number;
export declare const STREAM_EVENT_KINDS: readonly StreamEventKind[];
export declare const SUBSCRIPTION_TIERS: readonly SubscriptionTier[];

/** Who did it. `id` is nullable only when `isAnonymous` is true (e.g. an anonymous cheer). */
export type StreamEventActor = {
  id: string | null;
  displayName: string;
  isAnonymous: boolean;
};

/** Which broadcaster's channel the event happened on. */
export type StreamEventChannel = {
  id: string;
  displayName: string;
};

/** Opaque bag for platform-specific extra data — display/trigger logic is NOT required to
 * understand anything in here. Deliberately untyped beyond "plain object": the one thing it must
 * never contain is a field shaped like Twitch's own raw payload (enforced by
 * findRawPayloadLeaks()/isForbiddenRawPayloadKey() at runtime, and by this type never declaring a
 * `raw`/`rawPayload`/`payload`-named field anywhere in the StreamEvent shape). */
export type StreamEventSourceMetadata = Record<string, unknown>;

export type StreamEventBase = {
  schemaVersion: number;
  id: string;
  timestamp: string;
  actor: StreamEventActor;
  channel: StreamEventChannel;
  sourceMetadata?: StreamEventSourceMetadata;
};

export type CheerEventData = { bits: number; message?: string };
export type SubscriptionEventData = { tier: SubscriptionTier; isGift?: boolean };
export type ResubEventData = { tier: SubscriptionTier; cumulativeMonths: number; streakMonths?: number; message?: string };
export type GiftSubscriptionEventData = { tier: SubscriptionTier; count: number; cumulativeTotal?: number };
export type RewardRedemptionEventData = { rewardId: string; rewardTitle: string; cost: number; userInput?: string; status?: "fulfilled" | "unfulfilled" | "canceled" };

export type CheerStreamEvent = StreamEventBase & { kind: "cheer"; data: CheerEventData };
export type SubscriptionStreamEvent = StreamEventBase & { kind: "subscription"; data: SubscriptionEventData };
export type ResubStreamEvent = StreamEventBase & { kind: "resub"; data: ResubEventData };
export type GiftSubscriptionStreamEvent = StreamEventBase & { kind: "gift-subscription"; data: GiftSubscriptionEventData };
export type RewardRedemptionStreamEvent = StreamEventBase & { kind: "reward-redemption"; data: RewardRedemptionEventData };

/** The discriminated union — discriminant is `kind`. Deliberately has no `rawPayload`/`raw`/
 * similar field on any member: that omission IS the compile-time half of the raw-payload guard. */
export type StreamEvent =
  | CheerStreamEvent
  | SubscriptionStreamEvent
  | ResubStreamEvent
  | GiftSubscriptionStreamEvent
  | RewardRedemptionStreamEvent;

export type StreamEventIssueSeverity = "error" | "warning";

export type StreamEventIssue = {
  path: ReadonlyArray<string | number>;
  code: string;
  message: string;
  severity: StreamEventIssueSeverity;
  meta: Record<string, unknown>;
};

export declare function issue(
  path: string | Array<string | number>,
  code: string,
  message: string,
  options?: { severity?: StreamEventIssueSeverity; meta?: Record<string, unknown> },
): StreamEventIssue;

export declare function successResult(event: StreamEvent, issues?: StreamEventIssue[]): { ok: true; event: StreamEvent; issues: readonly StreamEventIssue[] };
export declare function failureResult(issues: StreamEventIssue[], input?: unknown): { ok: false; issues: readonly StreamEventIssue[]; input: unknown };

export declare function isForbiddenRawPayloadKey(key: string): boolean;
export declare function findRawPayloadLeaks(value: unknown, path?: Array<string | number>, depth?: number): string[];
