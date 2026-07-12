// Issue #85: the top-level Main-process-internal orchestrator every future Twitch service module
// (EventSub #86-88, Twitch IRC, health) is expected to depend on instead of talking to #83's
// DeviceCodeFlow / #84's TwitchTokenProvider directly. It composes both of those (exposed as public
// readonly fields below — see AuthRequestRegistry.runtime/TwitchChatService.runtime for the same
// "expose the composed sub-object" precedent) and adds the account/scope/revoke pieces this issue
// introduces on top:
//
//  - twitch-scope-registry.ts: feature -> required-scope resolution + current/granted/missing diff.
//  - twitch-account-service.ts: confirms which real Twitch account a token belongs to (Helix Users)
//    and hard-stops on a broadcaster/account mismatch.
//  - twitch-revoke-client.ts: best-effort access-token revoke, used by logout()/switchAccount().
//
// Every newly obtained Device Code Grant token (initial login, scope upgrade, or account switch)
// flows through this file's #handleTokenObtained — wired as DeviceCodeFlow's onTokenObtained —
// which verifies the account BEFORE ever calling TwitchTokenProvider.handleTokenObtained() (the
// step that actually persists/commits it). A broadcaster mismatch or an unconfirmable account
// therefore never touches the previous token/session: "新認可完了まで旧session/tokenを保持" and
// "broadcasterと認可accountの不一致を拒否する" both fall out of that ordering by construction.
import type { RetryPolicy } from "../../retry-policy";
import type { SecretStore } from "../../../../shared/secret-contract";
import { parseSecretKey } from "../../../secrets/secret-keys";
import { DeviceCodeFlow } from "./device-code-flow";
import type { DeviceCodeFlowDeps, TwitchAuthTokenHandoff } from "./device-code-flow";
import { TwitchTokenProvider, TWITCH_ACCESS_TOKEN_SECRET_KEY } from "./twitch-token-provider";
import type { TwitchTokenProviderStatus } from "./twitch-token-provider";
import type { TwitchOAuthClient } from "./twitch-oauth-client";
import { normalizeScopes } from "./twitch-auth-state";
import { diffScopes, requiredScopesFor, isTwitchFeature } from "./twitch-scope-registry";
import type { TwitchFeature } from "./twitch-scope-registry";
import { TwitchAccountService } from "./twitch-account-service";
import { TwitchRevokeClient } from "./twitch-revoke-client";
import type { TwitchAuthAccount } from "./auth-metadata-repository";
import type { TwitchAuthPublicState } from "../../../../shared/twitch/auth-contract";

const ACCESS_TOKEN_KEY = parseSecretKey(TWITCH_ACCESS_TOKEN_SECRET_KEY);

/** Why an in-flight session/subscription is being torn down — passed to the injectable
 * `stopSessions` hook so a future EventSub/IRC wiring point can log/branch on it if useful. Scope
 * upgrades deliberately do NOT appear here: per issue #85's design, the old session/token stays up
 * untouched throughout a scope upgrade (see startScopeUpgrade()'s doc comment) and is only ever
 * superseded on success, never torn down proactively. */
export type TwitchSessionStopReason = "account-switch" | "logout";

export type TwitchAuthCoordinatorEvent = { generation: number; status: TwitchTokenProviderStatus; account: TwitchAuthAccount | null };

export type TwitchScopeCheckResult =
  | { status: "ok"; required: string[] }
  /** "scope不足時はEventSub開始前にscope_missingへ遷移" (issue #85) — a future EventSub module must
   * check this (via checkScopesForFeatures()/scopeStatus) before starting any subscription and
   * treat it as "do not start" until startScopeUpgrade() resolves it. */
  | { status: "scope_missing"; required: string[]; missing: string[] }
  /** No valid token at all yet — distinct from scope_missing so a caller can tell "needs an
   * initial login" apart from "already logged in, just needs one more scope". */
  | { status: "unauthenticated"; required: string[] };

export type TwitchBroadcasterMismatch = { expectedBroadcasterId: string; observedUserId: string; observedLogin: string };

export type TwitchAuthCoordinatorDeps = {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  openVerificationUri?: (url: string) => Promise<{ opened: boolean }>;
  emitAuthProgress?: DeviceCodeFlowDeps["emitProgress"];
  validateIntervalMs?: number;
  retryPolicy?: RetryPolicy;
  /** Called (and awaited) BEFORE tearing down the old identity for an account switch or a logout —
   * i.e. before any new token is committed and before the old token/metadata is cleared. Lets a
   * future EventSub/IRC wiring point stop every subscription/connection tied to the OLD identity
   * first. Errors are logged and otherwise swallowed: a broken session-stop hook must never block
   * logout/switchAccount from clearing local auth state. */
  stopSessions?: (reason: TwitchSessionStopReason) => Promise<void> | void;
  /** "feature無効化時に不要subscriptionを停止" (issue #85) — called once per feature that
   * transitions from enabled to disabled via setEnabledFeatures(), so a future EventSub module can
   * stop just that feature's subscription without tearing down the whole session. Same
   * log-and-swallow error handling as stopSessions. */
  onFeatureDisabled?: (feature: TwitchFeature, reason: string) => Promise<void> | void;
};

function normalizeFeatures(features: readonly string[]): TwitchFeature[] {
  return [...new Set(features.filter(isTwitchFeature))].sort();
}

export class TwitchAuthCoordinator {
  /** Owns the Device Code Grant handshake (start/poll/cancel/reload) — see device-code-flow.ts.
   * Exposed directly (not re-wrapped) so callers can read publicState/registrySize or call
   * cancel()/openVerificationUri() without this file needing a passthrough for every method. */
  readonly deviceCodeFlow: DeviceCodeFlow;
  /** Owns the obtained token's whole post-acquisition lifecycle (persist/validate/refresh/rotate)
   * — see twitch-token-provider.ts. Exposed directly for the same reason as deviceCodeFlow above. */
  readonly tokenProvider: TwitchTokenProvider;

  readonly #accountService: TwitchAccountService;
  readonly #revokeClient: TwitchRevokeClient;
  readonly #secretStore: SecretStore;
  readonly #clientId: string;
  readonly #controller = new AbortController();
  readonly #listeners = new Set<(event: TwitchAuthCoordinatorEvent) => void>();
  readonly #stopSessionsDep: (reason: TwitchSessionStopReason) => Promise<void> | void;
  readonly #onFeatureDisabledDep: (feature: TwitchFeature, reason: string) => Promise<void> | void;
  /** requestId -> what kind of flow started it, so #handleTokenObtained (fired later, potentially
   * after a *different* start() has already begun — see device-code-flow.ts's own #transitionFor
   * comment for why requestId, never mutable instance state, is the safe way to correlate this)
   * knows whether to capture/revoke the outgoing token (switchAccount only). */
  readonly #pendingRequestKinds = new Map<string, "initial" | "upgrade" | "switch">();
  #enabledFeatures: TwitchFeature[] = [];
  #scopeStatus: TwitchScopeCheckResult = { status: "unauthenticated", required: [] };
  #expectedBroadcasterId: string | null;
  #lastBroadcasterMismatch: TwitchBroadcasterMismatch | null = null;
  #pendingHandoff: Promise<void> | undefined;

  constructor(
    oauthClient: TwitchOAuthClient,
    accountService: TwitchAccountService,
    revokeClient: TwitchRevokeClient,
    clientId: string,
    secretStore: SecretStore,
    expectedBroadcasterId: string | null,
    deps: TwitchAuthCoordinatorDeps = {},
  ) {
    this.#accountService = accountService;
    this.#revokeClient = revokeClient;
    this.#secretStore = secretStore;
    this.#clientId = clientId;
    this.#expectedBroadcasterId = expectedBroadcasterId;
    this.#stopSessionsDep = deps.stopSessions ?? (() => {});
    this.#onFeatureDisabledDep = deps.onFeatureDisabled ?? (() => {});

    this.tokenProvider = new TwitchTokenProvider(oauthClient, clientId, secretStore, {
      now: deps.now,
      sleep: deps.sleep,
      validateIntervalMs: deps.validateIntervalMs,
      retryPolicy: deps.retryPolicy,
      onReauthRequired: () => this.#notify(),
      onGenerationChanged: () => this.#notify(),
    });
    this.deviceCodeFlow = new DeviceCodeFlow(oauthClient, clientId, {
      now: deps.now,
      sleep: deps.sleep,
      openVerificationUri: deps.openVerificationUri,
      emitProgress: deps.emitAuthProgress,
      onTokenObtained: (handoff) => {
        this.#pendingHandoff = this.#handleTokenObtained(handoff).catch((error) => {
          console.error("[dociai:twitch-auth-coordinator] unexpected failure applying a newly obtained token", error);
        });
      },
    });
  }

  // -----------------------------------------------------------------------------------------
  // Read-only surface
  // -----------------------------------------------------------------------------------------

  get status(): TwitchTokenProviderStatus {
    return this.tokenProvider.status;
  }

  get authGeneration(): number {
    return this.tokenProvider.getMetadataSnapshot().authGeneration;
  }

  get account(): TwitchAuthAccount | null {
    return this.tokenProvider.getMetadataSnapshot().account;
  }

  get scopeStatus(): TwitchScopeCheckResult {
    return this.#scopeStatus;
  }

  get lastBroadcasterMismatch(): TwitchBroadcasterMismatch | null {
    return this.#lastBroadcasterMismatch;
  }

  get expectedBroadcasterId(): string | null {
    return this.#expectedBroadcasterId;
  }

  /** Lets the caller update which broadcaster id future authorizations must match — e.g. right
   * before switchAccount() when the user is deliberately establishing a new broadcaster identity,
   * or once after a first-ever login has bootstrapped the initial value. */
  setExpectedBroadcasterId(broadcasterId: string | null): void {
    this.#expectedBroadcasterId = broadcasterId;
  }

  /** "auth generation変更をEventSub/Twitch IRC/healthへ通知" (issue #85) — subscribes to every
   * moment the coordinator considers the current session's identity to have materially changed:
   * a new token committed (initial login/scope upgrade/account switch/refresh rotation), a
   * transition into reauth_required, or a logout. Returns an unsubscribe function (same shape as
   * integration-health.ts's subscribe()). */
  subscribe(listener: (event: TwitchAuthCoordinatorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    const snapshot = this.tokenProvider.getMetadataSnapshot();
    const event: TwitchAuthCoordinatorEvent = { generation: snapshot.authGeneration, status: this.tokenProvider.status, account: snapshot.account };
    for (const listener of [...this.#listeners]) listener(event);
  }

  // -----------------------------------------------------------------------------------------
  // Lifecycle passthroughs
  // -----------------------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this.tokenProvider.initialize();
  }

  onSystemResume(): void {
    this.tokenProvider.onSystemResume();
  }

  async getValidAccessToken(requiredScopes: string[] = []): Promise<string> {
    return this.tokenProvider.getValidAccessToken(requiredScopes);
  }

  async reportUnauthorized(usedAccessToken: string): Promise<void> {
    return this.tokenProvider.reportUnauthorized(usedAccessToken);
  }

  dispose(): void {
    this.#controller.abort();
    this.deviceCodeFlow.dispose();
    this.tokenProvider.dispose();
    this.#listeners.clear();
    this.#pendingRequestKinds.clear();
  }

  /** Test/cleanup seam: resolves once the current Device Code Grant attempt (if any), this
   * coordinator's own post-handoff account-verification step, and any in-flight token-provider
   * validate/refresh have all settled. Mirrors DeviceCodeFlow.waitForSettled()/
   * TwitchTokenProvider.waitForIdle(). */
  async waitForIdle(): Promise<void> {
    await this.deviceCodeFlow.waitForSettled();
    await this.#pendingHandoff?.catch(() => {});
    await this.tokenProvider.waitForIdle();
  }

  // -----------------------------------------------------------------------------------------
  // Scope management ("bits/subscriptions/redemptionsのfeature→scope registryを実装" /
  // "current/granted/required/missing scopeを算出" / "scope不足時はEventSub開始前にscope_missing
  // へ遷移" / "feature無効化時に不要subscriptionを停止")
  // -----------------------------------------------------------------------------------------

  /** Computes (and records as `scopeStatus`) whether the currently-granted token covers every
   * scope `enabledFeatures` requires, WITHOUT changing which features are considered enabled — use
   * this for a read-only check (e.g. "can EventSub start now?"). Use setEnabledFeatures() when the
   * caller is actually changing the enabled-feature set (it also fires onFeatureDisabled for
   * anything that just got turned off). */
  checkScopesForFeatures(enabledFeatures: readonly string[]): TwitchScopeCheckResult {
    const result = this.#computeScopeStatus(enabledFeatures);
    this.#scopeStatus = result;
    return result;
  }

  #computeScopeStatus(enabledFeatures: readonly string[]): TwitchScopeCheckResult {
    const required = requiredScopesFor(enabledFeatures);
    if (this.tokenProvider.status !== "valid") return { status: "unauthenticated", required };
    const diff = diffScopes(required, this.tokenProvider.getMetadataSnapshot().scopes);
    if (diff.missing.length > 0) return { status: "scope_missing", required: diff.required, missing: diff.missing };
    return { status: "ok", required: diff.required };
  }

  /** Updates the tracked enabled-feature set, fires onFeatureDisabled for every feature that just
   * transitioned from enabled to disabled (best-effort; a hook failure is logged and swallowed —
   * never allowed to prevent the feature-set update itself), and returns the resulting scope
   * status (same shape as checkScopesForFeatures()). */
  setEnabledFeatures(features: readonly string[]): TwitchScopeCheckResult {
    const next = normalizeFeatures(features);
    const removed = this.#enabledFeatures.filter((feature) => !next.includes(feature));
    this.#enabledFeatures = next;
    for (const feature of removed) {
      try {
        void Promise.resolve(this.#onFeatureDisabledDep(feature, "feature-disabled")).catch((error) => {
          console.error(`[dociai:twitch-auth-coordinator] onFeatureDisabled hook failed for ${feature}`, error);
        });
      } catch (error) {
        console.error(`[dociai:twitch-auth-coordinator] onFeatureDisabled hook threw synchronously for ${feature}`, error);
      }
    }
    return this.checkScopesForFeatures(next);
  }

  // -----------------------------------------------------------------------------------------
  // Device Code Grant entry points ("scope追加用Device Code flowを開始" /
  // "新認可完了まで旧session/tokenを保持" / "account switch前に旧session/requestを停止")
  // -----------------------------------------------------------------------------------------

  /** First-ever login (or re-login after a logout) for the currently-enabled feature set. */
  async startInitialAuth(enabledFeatures: readonly string[]): Promise<TwitchAuthPublicState> {
    this.#enabledFeatures = normalizeFeatures(enabledFeatures);
    const scopes = requiredScopesFor(this.#enabledFeatures);
    const state = await this.deviceCodeFlow.start({ scopes });
    if (state.requestId) this.#pendingRequestKinds.set(state.requestId, "initial");
    return state;
  }

  /** "scope追加用Device Code flowを開始" — starts a NEW Device Code Grant requesting the union of
   * the currently-granted scopes plus `missingScopes`, so a re-authorization for one new feature
   * never silently drops a scope an already-running feature depends on. The OLD token/session
   * remains fully usable for the entire duration of this new attempt ("新認可完了まで旧
   * session/tokenを保持") — nothing here touches the previous token; #handleTokenObtained only
   * ever calls TwitchTokenProvider.handleTokenObtained() (which is what actually swaps the trusted
   * token) once the new grant has both completed AND passed the broadcaster-identity check below.
   * A user who abandons/denies this upgrade, or authorizes under the wrong account by mistake,
   * therefore never ends up logged out — exactly per this issue's design guidance. */
  async startScopeUpgrade(missingScopes: readonly string[]): Promise<TwitchAuthPublicState> {
    const currentScopes = this.tokenProvider.getMetadataSnapshot().scopes;
    const scopes = normalizeScopes([...currentScopes, ...missingScopes]);
    const state = await this.deviceCodeFlow.start({ scopes });
    if (state.requestId) this.#pendingRequestKinds.set(state.requestId, "upgrade");
    return state;
  }

  /** "account switch前に旧session/requestを停止" — stops every session tied to the CURRENT
   * identity up front (before even starting the new Device Code Grant), then starts a fresh
   * authorization for `enabledFeatures` (defaulting to whatever is currently enabled). Once that
   * authorization completes and passes the broadcaster check, #handleTokenObtained best-effort
   * revokes the outgoing token in addition to TwitchTokenProvider overwriting it in SecretStore —
   * "account切替後に旧token/session/eventが残らない". */
  async switchAccount(enabledFeatures: readonly string[] = this.#enabledFeatures): Promise<TwitchAuthPublicState> {
    await this.#runStopSessions("account-switch");
    this.#enabledFeatures = normalizeFeatures(enabledFeatures);
    const scopes = requiredScopesFor(this.#enabledFeatures);
    const state = await this.deviceCodeFlow.start({ scopes });
    if (state.requestId) this.#pendingRequestKinds.set(state.requestId, "switch");
    return state;
  }

  async #handleTokenObtained(handoff: TwitchAuthTokenHandoff): Promise<void> {
    const kind = this.#pendingRequestKinds.get(handoff.requestId) ?? "initial";
    this.#pendingRequestKinds.delete(handoff.requestId);

    // "Helix Users APIからaccount summaryを取得" — confirm the account BEFORE this token is ever
    // handed to TwitchTokenProvider (which is the step that actually persists/trusts it).
    const accountResult = await this.#accountService.fetchAuthenticatedAccount({ accessToken: handoff.accessToken, clientId: this.#clientId }, this.#controller.signal);
    if (!accountResult.ok) {
      console.error(`[dociai:twitch-auth-coordinator] could not confirm the Twitch account for a newly obtained token (${accountResult.errorCode}); leaving the previous session untouched`, { message: accountResult.message });
      return;
    }

    // "認可user IDをbroadcaster IDとして検証" / "broadcasterと認可accountの不一致を拒否する": a
    // hard stop that revokes the just-obtained (never-persisted) token and returns without ever
    // calling TwitchTokenProvider — the previous token/session is left completely untouched.
    if (this.#expectedBroadcasterId && accountResult.account.userId !== this.#expectedBroadcasterId) {
      this.#lastBroadcasterMismatch = { expectedBroadcasterId: this.#expectedBroadcasterId, observedUserId: accountResult.account.userId, observedLogin: accountResult.account.login };
      console.error(`[dociai:twitch-auth-coordinator] rejected Twitch account ${accountResult.account.login} (${accountResult.account.userId}): does not match configured broadcaster ${this.#expectedBroadcasterId}`);
      await this.#revokeClient.revoke({ clientId: this.#clientId, token: handoff.accessToken }, this.#controller.signal).catch(() => ({ ok: false as const, message: "revoke failed" }));
      return;
    }
    this.#lastBroadcasterMismatch = null;

    // Captured BEFORE handleTokenObtained() below overwrites SecretStore, so an account-switch can
    // still best-effort revoke the outgoing token afterward — see "revoke成否とlocal secret削除を
    // 分離" (the revoke's own success/failure never affects the commit that already happened).
    const outgoingAccessToken = kind === "switch" ? await this.#secretStore.getForService(ACCESS_TOKEN_KEY).catch(() => null) : null;

    await this.tokenProvider.handleTokenObtained(handoff);

    if (kind === "switch" && outgoingAccessToken && outgoingAccessToken !== handoff.accessToken) {
      // Awaited (not fire-and-forget): waitForIdle() must only resolve once this best-effort
      // revoke has actually been attempted, so a caller/test observing "the switch has settled"
      // can reliably assert on the outgoing token having been revoked.
      await this.#revokeClient.revoke({ clientId: this.#clientId, token: outgoingAccessToken }, this.#controller.signal).catch(() => ({ ok: false as const, message: "revoke failed" }));
    }
  }

  // -----------------------------------------------------------------------------------------
  // Logout ("access token revokeをbest effortで実行" / "revoke成否とlocal secret削除を分離" /
  // "logout時にtoken/metadata/timerをcleanup")
  // -----------------------------------------------------------------------------------------

  /** Stops every session tied to the current identity, best-effort revokes the current access
   * token, and ALWAYS clears local token/metadata/timer state afterward regardless of whether the
   * revoke call itself succeeded — "logoutがnetwork revoke失敗時もlocal状態を安全に消去できる" is
   * satisfied by construction: `revoked` only reports what happened over the network, it never
   * gates the local cleanup below (see the unconditional `await this.tokenProvider.logout()`). */
  async logout(): Promise<{ revoked: boolean }> {
    await this.#runStopSessions("logout");
    const accessToken = await this.#secretStore.getForService(ACCESS_TOKEN_KEY).catch(() => null);
    let revoked = false;
    if (accessToken) {
      const result = await this.#revokeClient.revoke({ clientId: this.#clientId, token: accessToken }, this.#controller.signal).catch((error) => ({ ok: false as const, message: error instanceof Error ? error.message : "revoke failed" }));
      revoked = result.ok === true;
    }
    await this.tokenProvider.logout();
    this.#enabledFeatures = [];
    this.#scopeStatus = { status: "unauthenticated", required: [] };
    this.#lastBroadcasterMismatch = null;
    return { revoked };
  }

  async #runStopSessions(reason: TwitchSessionStopReason): Promise<void> {
    try {
      await this.#stopSessionsDep(reason);
    } catch (error) {
      console.error(`[dociai:twitch-auth-coordinator] stopSessions hook failed during ${reason}`, error);
    }
  }
}
