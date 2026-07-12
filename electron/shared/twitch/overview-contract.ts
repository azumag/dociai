// Renderer/IPC-facing contract for issue #94's Twitch overview screen — combines #83-85's Device
// Code Grant auth surface, #86-88's EventSub connection surface, and #87's subscription reconciler
// surface into three renderer-safe snapshot shapes, each carrying its own monotonic `generation`
// (bumped by electron/main/services/twitch/twitch-composition.ts on every underlying change, for
// BOTH the initial status() read and every subsequent push) so the Renderer reducer
// (src/twitch-ui/twitch-ui-reducer.js) can always discard a stale/out-of-order snapshot with a
// simple `incoming.generation >= current.generation` guard, regardless of whether the initial
// snapshot fetch or a later push event happens to resolve/arrive first.
//
// SAFETY INVARIANT (mirrors auth-contract.ts's own): none of these types may ever carry a raw
// access/refresh token, the raw device_code, or an internal-only URL (the EventSub WebSocket URL,
// a Twitch-specified `reconnect_url`). `userCode`/`verificationUri` (both inside `flow`, via
// TwitchAuthPublicState) are the only two auth-flow values this contract deliberately allows
// through, per auth-contract.ts's own established design — see
// scripts/test/twitch-ui-security.test.mjs for the standing DOM/clipboard scan that guards this.
import type { TwitchAuthPublicState } from "./auth-contract";

export type TwitchAuthTokenStatus = "unauthenticated" | "valid" | "reauth_required";
export type TwitchAuthScopeState = "unauthenticated" | "ok" | "scope_missing";

export type TwitchAuthAccountSummary = { userId: string; login: string };
export type TwitchBroadcasterMismatchSummary = { expectedBroadcasterId: string; observedUserId: string; observedLogin: string };

/** Everything the overview/authorization views need to render "signed out / awaiting user / ready
 * / scope missing / reauth" plus the account/scope/broadcaster panels — and nothing more. */
export type TwitchAuthOverview = {
  generation: number;
  /** Preflight check #1: was a Twitch OAuth client id ever configured for this build/install (see
   * twitch-composition.ts — sourced from `TWITCH_CLIENT_ID`, never user-entered secret config). A
   * false here means every other auth action is a no-op; the UI should show this as the first,
   * blocking preflight failure. */
  clientIdConfigured: boolean;
  /** The Device Code Grant state machine's own public state (#83) — signed_out/starting/
   * awaiting_user/exchanging/ready/error, plus userCode/verificationUri/expiresAt/intervalSeconds
   * for the Device Code UI. */
  flow: TwitchAuthPublicState;
  /** The token's post-acquisition trust state (#84) — independent of `flow` because a `ready` flow
   * transitions into an idle/no-flow state once the token is committed; `tokenStatus` is what
   * persists across app restarts (see twitch-token-provider.ts's own state machine). */
  tokenStatus: TwitchAuthTokenStatus;
  account: TwitchAuthAccountSummary | null;
  scopeState: TwitchAuthScopeState;
  requiredScopes: string[];
  grantedScopes: string[];
  missingScopes: string[];
  broadcasterUserId: string | null;
  broadcasterMismatch: TwitchBroadcasterMismatchSummary | null;
  enabledFeatures: string[];
  /** "対象channelのBits/サブスク利用可否（affiliate/partner）の注意表示" (issue #94's 追加TODO) —
   * #85's Helix Users lookup (twitch-account-service.ts) does not return an affiliate/partner
   * broadcaster-type field (Helix's `broadcaster_type` is only present on `GET /helix/users` when
   * looking up a channel BY id/login as a third party — Twitch omits it from the "the token's own
   * account" call this app already makes, and adding a second Helix call/scope just for this badge
   * is out of scope for this issue). This is therefore always a static, non-account-derived
   * informational flag the UI shows as a fixed note near the Bits/Subscriptions rows — never a real
   * capability check. See twitch-composition.ts's doc comment for this same reasoning.
   */
  affiliatePartnerNoteApplicable: boolean;
  updatedAtMs: number;
};

export type TwitchConnectionStatus = "idle" | "connecting" | "reconnect_pending" | "specified_reconnect" | "running" | "auth_not_ready" | "stopped";
export type TwitchConnectionSessionState = "connecting" | "awaiting_welcome" | "connected" | "closed";
export type TwitchConnectionCloseCategory = "normal" | "auth" | "explicit_stop";

export type TwitchConnectionSessionSummary = {
  sessionId: string | null;
  state: TwitchConnectionSessionState;
  keepaliveTimeoutSeconds: number | null;
  lastMessageAtMs: number | null;
  closeReason: string | null;
  closeCategory: TwitchConnectionCloseCategory | null;
};

export type TwitchConnectionDedupeStats = { size: number; duplicates: number; evictedByTtl: number; evictedByLimit: number };

export type TwitchConnectionOverview = {
  generation: number;
  status: TwitchConnectionStatus;
  attempt: number;
  online: boolean;
  session: TwitchConnectionSessionSummary | null;
  pendingRetryAtMs: number | null;
  dedupe: TwitchConnectionDedupeStats;
  updatedAtMs: number;
};

/** A single reconnect-lifecycle "moment" (#88's ReconnectDiagnosticEvent, stripped of the raw
 * `reconnectUrl`/`messageId` fields — neither is needed for the UI and `reconnectUrl` in particular
 * must never reach the DOM). The Renderer reducer coalesces consecutive `retry_scheduled` pushes
 * into a single in-place notice instead of stacking a toast per attempt — "transient reconnect
 * notificationをdedupe" (issue #94). */
export type TwitchReconnectDiagnosticEvent =
  | { type: "retry_scheduled"; attempt: number; delayMs: number; retryAtMs: number }
  | { type: "specified_reconnect_started" }
  | { type: "specified_reconnect_succeeded" }
  | { type: "specified_reconnect_fallback"; reason: string }
  | { type: "event_gap_warning"; message: string }
  | { type: "duplicate_dropped" }
  | { type: "stopped"; reason: string };

export type TwitchReconnectDiagnosticPush = { generation: number; event: TwitchReconnectDiagnosticEvent; atMs: number };

export type TwitchSubscriptionFeature = "bits" | "subscriptions" | "redemptions";
export type TwitchSubscriptionEntryStatus = "pending" | "creating" | "active" | "missing_scope" | "unauthorized" | "error" | "suppressed" | "removed";

export type TwitchSubscriptionEntryOverview = {
  key: string;
  type: string;
  version: string;
  feature: TwitchSubscriptionFeature | null;
  subscriptionId: string | null;
  actualStatus: string | null;
  entryStatus: TwitchSubscriptionEntryStatus;
  lastError: { errorCode: string; status?: number; message: string } | null;
  revocation: { category: "auth" | "not_recoverable" | "recoverable" | "unknown"; actionable: boolean; message: string } | null;
  suppressedUntilMs: number | null;
  updatedAtMs: number;
};

export type TwitchSubscriptionsOverview = {
  generation: number;
  sessionId: string | null;
  welcomeAtMs: number | null;
  subscriptionDeadlineAtMs: number | null;
  deadlineMissed: boolean;
  entries: TwitchSubscriptionEntryOverview[];
  updatedAtMs: number;
};

/** `dociai.events.subscribe(type, listener)` (electron/preload/index.ts) discriminants — the same
 * generic `{type, event}` APP_EVENT bus every other push-event feature in this app already uses
 * (see electron/shared/services/stream-event-ipc-contract.ts's own doc comment for the mechanism). */
export const TWITCH_AUTH_EVENT_TYPE = "twitch:auth:event";
export const TWITCH_CONNECTION_EVENT_TYPE = "twitch:connection:event";
export const TWITCH_SUBSCRIPTIONS_EVENT_TYPE = "twitch:subscriptions:event";
export const TWITCH_RECONNECT_DIAGNOSTIC_EVENT_TYPE = "twitch:reconnect:diagnostic";
