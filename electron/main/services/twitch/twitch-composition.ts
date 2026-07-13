// Issue #94: the Main-process composition root that finally wires #83-85's Device Code Grant auth
// surface and #86-88's EventSub connection/subscription surface together and exposes them to
// electron/main/index.ts (which constructs one of these) and, from there, to the Renderer overview
// screen (src/twitch-ui/*) via electron/main/ipc/register.ts. None of the 6 dependency issues wired
// any of this into anything real — every one of their PRs said so explicitly — so this file is the
// first place a real TwitchAuthCoordinator/ReconnectCoordinator/SubscriptionReconciler graph gets
// constructed with production dependencies (SecretStore, a real `ws` socket factory, #41's safe
// external-URL-open capability).
//
// This module owns exactly one extra responsibility beyond wiring: projecting each service's own
// (already Renderer-safe) snapshot into the three overview shapes electron/shared/twitch/overview-
// contract.ts defines, each stamped with a monotonic per-category generation number bumped on every
// underlying change — see that file's doc comment for why a generation is attached to BOTH the
// initial snapshot getter and every subsequent push, and how that lets the Renderer reducer ignore
// a stale/out-of-order event with a single `>=` comparison.
//
// CLIENT ID: intentionally NOT a piece of user-editable config. Twitch's Device Code Grant is
// designed for public clients that ship a client_id in the built app (there is no client_secret to
// protect) — electron/main/index.ts sources it from `process.env.TWITCH_CLIENT_ID`, a build/deploy-
// time constant, never through #42's SecretStore or the config file. `clientIdConfigured` in the
// auth overview is `false` whenever that is unset, which the preflight checklist surfaces as the
// first, blocking check.
//
// BROADCASTER ID bootstrap: `broadcasterUserId` starts as whatever electron/main/index.ts loaded
// from `config.twitch.broadcasterUserId` (persisted across restarts). The FIRST successful login
// while it is still null bootstraps it from the authorized account (see #handleCoordinatorEvent) —
// exactly the "first-ever login" case twitch-auth-coordinator.ts's own doc comment describes — and
// `onBroadcasterConfirmed` is called so the caller can persist it forward. Every login/switch AFTER
// that is protected by twitch-auth-coordinator.ts's own broadcaster-mismatch hard stop.
//
// AFFILIATE/PARTNER NOTE: Twitch requires a channel to be Affiliate/Partner for Bits/Subscriptions
// to ever fire at all, and #85's Helix Users lookup (twitch-account-service.ts, `GET /helix/users`
// with no query params — "the token's own account") does not return a `broadcaster_type` field for
// that call shape (Twitch documents `broadcaster_type` as present when looking up a channel BY
// id/login, which this app has no other reason to call). Building a second Helix call/scope just to
// surface this one badge is out of scope for this issue per its own TODO wording ("if there's no
// clean signal available from what #85 already fetches, add a simple static informational note").
// `affiliatePartnerNoteApplicable` below is therefore a static, config-derived flag (true whenever
// bits/subscriptions is an enabled feature) — never a real per-account capability check.
import { ServiceError } from "../service-error";
import type { SecretStore } from "../../../shared/secret-contract";
import { TwitchOAuthClient } from "./auth/twitch-oauth-client";
import { TwitchAccountService } from "./auth/twitch-account-service";
import { TwitchRevokeClient } from "./auth/twitch-revoke-client";
import { TwitchAuthCoordinator } from "./auth/twitch-auth-coordinator";
import type { TwitchAuthCoordinatorEvent, TwitchSessionStopReason } from "./auth/twitch-auth-coordinator";
import { isTwitchFeature, FEATURE_SCOPES } from "./auth/twitch-scope-registry";
import type { TwitchFeature } from "./auth/twitch-scope-registry";
import { TwitchTokenProviderError } from "./auth/twitch-token-provider";
import { TwitchCustomRewardsClient } from "./custom-rewards-client";
import { EventSubSubscriptionClient } from "./eventsub/eventsub-subscription-client";
import { SubscriptionReconciler } from "./eventsub/subscription-reconciler";
import type { SubscriptionReconcilerSnapshot } from "./eventsub/subscription-reconciler";
import { ReconnectCoordinator, DEFAULT_EVENTSUB_WS_URL } from "./eventsub/reconnect-coordinator";
import type { ReconnectCoordinatorSnapshot, ReconnectDiagnosticEvent } from "./eventsub/reconnect-coordinator";
import type { EventSubSocketConstructor } from "./eventsub/eventsub-session";
import { systemClock } from "./eventsub/keepalive-watchdog";
import type { Clock } from "./eventsub/keepalive-watchdog";
import type {
  TwitchAuthOverview,
  TwitchConnectionOverview,
  TwitchCustomRewardsOverview,
  TwitchReconnectDiagnosticPush,
  TwitchSubscriptionsOverview,
} from "../../../shared/twitch/overview-contract";

export type TwitchCompositionDeps = {
  clientId: string;
  secretStore: SecretStore;
  broadcasterUserId?: string | null;
  enabledFeatures?: readonly string[];
  socketFactory: EventSubSocketConstructor;
  fetchImpl?: typeof fetch;
  idBaseUrl?: string;
  helixBaseUrl?: string;
  webSocketUrl?: string;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  clock?: Clock;
  random?: () => number;
  /** Should be `(url) => openAllowedExternalUrl(url).then(() => ({ opened: true }))` in production
   * (electron/main/security/navigation.ts, issue #41) — see device-code-flow.ts's own identical dep
   * for why this is injectable and safe to leave unset. */
  openVerificationUri?: (url: string) => Promise<{ opened: boolean }>;
  onAuthEvent?: (overview: TwitchAuthOverview) => void;
  onConnectionEvent?: (overview: TwitchConnectionOverview) => void;
  onSubscriptionsEvent?: (overview: TwitchSubscriptionsOverview) => void;
  onReconnectDiagnostic?: (push: TwitchReconnectDiagnosticPush) => void;
  /** Fired (fire-and-forget from this module's perspective) the first time a broadcaster id is
   * bootstrapped from a fresh login — the caller is expected to persist it (config.twitch.
   * broadcasterUserId) so a future app restart keeps the same broadcaster-mismatch protection. */
  onBroadcasterConfirmed?: (broadcasterUserId: string) => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

function normalizeFeatureList(features: readonly string[] | undefined): TwitchFeature[] {
  return [...new Set((features ?? []).filter(isTwitchFeature))].sort();
}

export class TwitchComposition {
  readonly coordinator: TwitchAuthCoordinator;
  readonly reconciler: SubscriptionReconciler;
  readonly reconnectCoordinator: ReconnectCoordinator;
  readonly #rewardsClient: TwitchCustomRewardsClient;

  readonly #clientId: string;
  readonly #onAuthEvent: (overview: TwitchAuthOverview) => void;
  readonly #onConnectionEvent: (overview: TwitchConnectionOverview) => void;
  readonly #onSubscriptionsEvent: (overview: TwitchSubscriptionsOverview) => void;
  readonly #onReconnectDiagnostic: (push: TwitchReconnectDiagnosticPush) => void;
  readonly #onBroadcasterConfirmed: (broadcasterUserId: string) => void;
  readonly #now: () => number;
  readonly #unsubscribeCoordinator: () => void;

  #enabledFeatures: TwitchFeature[];
  #broadcasterUserId: string | null;
  #authGeneration = 0;
  #authOverview: TwitchAuthOverview;
  #connectionGeneration = 0;
  #connectionOverview: TwitchConnectionOverview;
  #subscriptionsGeneration = 0;
  #subscriptionsOverview: TwitchSubscriptionsOverview;
  #disposed = false;

  constructor(deps: TwitchCompositionDeps) {
    this.#clientId = deps.clientId ?? "";
    this.#broadcasterUserId = deps.broadcasterUserId ?? null;
    this.#enabledFeatures = normalizeFeatureList(deps.enabledFeatures);
    this.#now = deps.now ?? (() => Date.now());
    this.#onAuthEvent = deps.onAuthEvent ?? (() => {});
    this.#onConnectionEvent = deps.onConnectionEvent ?? (() => {});
    this.#onSubscriptionsEvent = deps.onSubscriptionsEvent ?? (() => {});
    this.#onReconnectDiagnostic = deps.onReconnectDiagnostic ?? (() => {});
    this.#onBroadcasterConfirmed = deps.onBroadcasterConfirmed ?? (() => {});
    const log = deps.log ?? (() => {});

    const oauthClient = new TwitchOAuthClient({ fetchImpl: deps.fetchImpl, baseUrl: deps.idBaseUrl });
    const accountService = new TwitchAccountService({ fetchImpl: deps.fetchImpl, baseUrl: deps.helixBaseUrl });
    const revokeClient = new TwitchRevokeClient({ fetchImpl: deps.fetchImpl, baseUrl: deps.idBaseUrl });

    this.coordinator = new TwitchAuthCoordinator(oauthClient, accountService, revokeClient, this.#clientId, deps.secretStore, this.#broadcasterUserId, {
      now: deps.now,
      sleep: deps.sleep,
      openVerificationUri: deps.openVerificationUri,
      emitAuthProgress: () => this.#refreshAuth(),
      stopSessions: (reason: TwitchSessionStopReason) => { log("stopping EventSub session", { reason }); this.reconnectCoordinator.stop(); },
      onFeatureDisabled: () => this.#refreshAuth(),
    });
    this.#unsubscribeCoordinator = this.coordinator.subscribe((event) => this.#handleCoordinatorEvent(event));

    this.#rewardsClient = new TwitchCustomRewardsClient({ fetchImpl: deps.fetchImpl, baseUrl: deps.helixBaseUrl });

    const subscriptionClient = new EventSubSubscriptionClient({ fetchImpl: deps.fetchImpl, baseUrl: deps.helixBaseUrl });
    this.reconciler = new SubscriptionReconciler(subscriptionClient, this.coordinator, this.#clientId, {
      clock: deps.clock,
      onSnapshotChange: (snapshot) => this.#handleSubscriptionsSnapshot(snapshot),
      onAuthProblem: () => this.#refreshAuth(),
      log,
    });

    this.reconnectCoordinator = new ReconnectCoordinator(deps.socketFactory, this.coordinator, {
      webSocketUrl: deps.webSocketUrl ?? DEFAULT_EVENTSUB_WS_URL,
      clock: deps.clock ?? systemClock,
      random: deps.random,
      subscriptionSink: this.reconciler,
      onEvent: (snapshot) => this.#handleConnectionSnapshot(snapshot),
      onDiagnostic: (event) => this.#handleReconnectDiagnostic(event),
      log,
    });

    this.#authOverview = this.#buildAuthOverview();
    this.#connectionOverview = this.#buildConnectionOverview(this.reconnectCoordinator.snapshot);
    this.#subscriptionsOverview = this.#buildSubscriptionsOverview(this.reconciler.snapshot);
  }

  // -----------------------------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------------------------

  /** App startup: loads/validates whatever token survived a previous run, primes the reconciler's
   * desired set, and (only if the token is already valid and a broadcaster/feature set is already
   * known) best-effort auto-reconnects — a restart with an already-authorized session should not
   * force the user back through "manual connect" every time. Every other path leaves the connection
   * idle for the overview screen's manual connect action. */
  async initialize(): Promise<void> {
    await this.coordinator.initialize();
    await this.reconciler.setEnabledFeatures(this.#enabledFeatures);
    if (this.#broadcasterUserId) await this.reconciler.setBroadcasterUserId(this.#broadcasterUserId);
    this.#refreshAuth();
    if (this.coordinator.status === "valid" && this.#broadcasterUserId && this.#enabledFeatures.length > 0) {
      await this.connect().catch((error) => { /* best-effort — the overview screen's manual connect remains available */ void error; });
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeCoordinator();
    this.reconnectCoordinator.dispose();
    this.reconciler.dispose();
    this.coordinator.dispose();
  }

  // -----------------------------------------------------------------------------------------
  // Snapshots
  // -----------------------------------------------------------------------------------------

  get authOverview(): TwitchAuthOverview { return this.#authOverview; }
  get connectionOverview(): TwitchConnectionOverview { return this.#connectionOverview; }
  get subscriptionsOverview(): TwitchSubscriptionsOverview { return this.#subscriptionsOverview; }

  // -----------------------------------------------------------------------------------------
  // Auth actions
  // -----------------------------------------------------------------------------------------

  #assertClientConfigured(): void {
    if (!this.#clientId) throw new ServiceError("BAD_REQUEST", "Twitch client idが設定されていません (TWITCH_CLIENT_ID)", { serviceId: "twitch:composition", retryable: false });
  }

  async startInitialAuth(features?: readonly string[]): Promise<TwitchAuthOverview> {
    this.#assertClientConfigured();
    if (features && features.length > 0) this.#enabledFeatures = normalizeFeatureList(features);
    await this.reconciler.setEnabledFeatures(this.#enabledFeatures);
    await this.coordinator.startInitialAuth(this.#enabledFeatures);
    this.#refreshAuth();
    return this.#authOverview;
  }

  async cancelAuth(): Promise<TwitchAuthOverview> {
    this.coordinator.deviceCodeFlow.cancel("cancelled");
    this.#refreshAuth();
    return this.#authOverview;
  }

  async startScopeUpgrade(): Promise<TwitchAuthOverview> {
    this.#assertClientConfigured();
    const status = this.coordinator.checkScopesForFeatures(this.#enabledFeatures);
    const missing = status.status === "scope_missing" ? status.missing : [];
    if (missing.length === 0) throw new ServiceError("BAD_REQUEST", "追加が必要なscopeがありません", { serviceId: "twitch:composition", retryable: false });
    await this.coordinator.startScopeUpgrade(missing);
    this.#refreshAuth();
    return this.#authOverview;
  }

  async openVerificationUri(): Promise<{ opened: boolean }> {
    return this.coordinator.deviceCodeFlow.openVerificationUri();
  }

  async switchAccount(features?: readonly string[]): Promise<TwitchAuthOverview> {
    this.#assertClientConfigured();
    if (features && features.length > 0) this.#enabledFeatures = normalizeFeatureList(features);
    await this.coordinator.switchAccount(this.#enabledFeatures);
    this.#refreshAuth();
    return this.#authOverview;
  }

  async logout(): Promise<{ revoked: boolean }> {
    const result = await this.coordinator.logout();
    this.#refreshAuth();
    return result;
  }

  // -----------------------------------------------------------------------------------------
  // EventSub connection actions ("manual connect/reconnect/stop actionを実装")
  // -----------------------------------------------------------------------------------------

  async connect(): Promise<TwitchConnectionOverview> {
    await this.reconnectCoordinator.start();
    return this.#connectionOverview;
  }

  async reconnect(): Promise<TwitchConnectionOverview> {
    await this.reconnectCoordinator.start();
    return this.#connectionOverview;
  }

  stop(): TwitchConnectionOverview {
    this.reconnectCoordinator.stop();
    return this.#connectionOverview;
  }

  // -----------------------------------------------------------------------------------------
  // Custom Rewards (issue #95: reward selector for the Event Rule editor)
  // -----------------------------------------------------------------------------------------

  /** GET Custom Rewards for the configured broadcaster — populates
   * src/twitch-ui/rules/reward-selector.js. Never throws for an ordinary auth/scope/Helix failure
   * (returns `{ ok: false, errorCode, message }` instead, per this issue's own "reward scope不足・
   * fetch失敗へactionを表示" requirement — the caller must show a clear error state, never a silently
   * empty list). `getValidAccessToken(FEATURE_SCOPES.redemptions)` rejects with
   * `insufficient_scope` BEFORE any network call at all when the current grant lacks
   * `channel:read:redemptions` (see twitch-token-provider.ts), which is exactly the fast, no-network
   * "scope不足" path this method surfaces as `errorCode: "missing_scope"`. */
  async listCustomRewards(): Promise<TwitchCustomRewardsOverview> {
    if (!this.#clientId) return { ok: false, errorCode: "unauthorized", message: "Twitch client idが設定されていません (TWITCH_CLIENT_ID)", updatedAtMs: this.#now() };
    if (!this.#broadcasterUserId) return { ok: false, errorCode: "wrong_broadcaster", message: "broadcasterが未確定です。先にTwitchへログインしてください", updatedAtMs: this.#now() };

    let accessToken: string;
    try {
      accessToken = await this.coordinator.tokenProvider.getValidAccessToken([...FEATURE_SCOPES.redemptions]);
    } catch (error) {
      if (error instanceof TwitchTokenProviderError) {
        const errorCode = error.reason === "insufficient_scope" ? "missing_scope" : "unauthorized";
        return { ok: false, errorCode, message: error.message, updatedAtMs: this.#now() };
      }
      return { ok: false, errorCode: "unknown", message: error instanceof Error ? error.message : String(error), updatedAtMs: this.#now() };
    }

    const result = await this.#rewardsClient.list({ accessToken, clientId: this.#clientId, broadcasterUserId: this.#broadcasterUserId });
    if (!result.ok) return { ok: false, errorCode: result.errorCode, message: result.message, updatedAtMs: this.#now() };
    return { ok: true, rewards: result.rewards, updatedAtMs: this.#now() };
  }

  // -----------------------------------------------------------------------------------------
  // Internal: event handlers -> overview projection
  // -----------------------------------------------------------------------------------------

  #handleCoordinatorEvent(event: TwitchAuthCoordinatorEvent): void {
    // "first-ever login bootstraps the broadcaster id" — see this module's own doc comment.
    if (event.account && !this.#broadcasterUserId) {
      this.#broadcasterUserId = event.account.userId;
      this.coordinator.setExpectedBroadcasterId(this.#broadcasterUserId);
      void this.reconciler.setBroadcasterUserId(this.#broadcasterUserId);
      this.#onBroadcasterConfirmed(this.#broadcasterUserId);
    }
    this.#refreshAuth();
  }

  #refreshAuth(): void {
    this.#authGeneration += 1;
    this.#authOverview = this.#buildAuthOverview();
    this.#onAuthEvent(this.#authOverview);
  }

  #buildAuthOverview(): TwitchAuthOverview {
    const scopeStatus = this.coordinator.checkScopesForFeatures(this.#enabledFeatures);
    const metadata = this.coordinator.tokenProvider.getMetadataSnapshot();
    const mismatch = this.coordinator.lastBroadcasterMismatch;
    return {
      generation: this.#authGeneration,
      clientIdConfigured: Boolean(this.#clientId),
      flow: this.coordinator.deviceCodeFlow.publicState,
      tokenStatus: this.coordinator.status,
      account: this.coordinator.account ? { userId: this.coordinator.account.userId, login: this.coordinator.account.login } : null,
      scopeState: scopeStatus.status,
      requiredScopes: scopeStatus.required,
      grantedScopes: metadata.scopes,
      missingScopes: scopeStatus.status === "scope_missing" ? scopeStatus.missing : [],
      broadcasterUserId: this.#broadcasterUserId,
      broadcasterMismatch: mismatch ? { ...mismatch } : null,
      enabledFeatures: [...this.#enabledFeatures],
      affiliatePartnerNoteApplicable: this.#enabledFeatures.includes("bits") || this.#enabledFeatures.includes("subscriptions"),
      updatedAtMs: this.#now(),
    };
  }

  #handleConnectionSnapshot(snapshot: ReconnectCoordinatorSnapshot): void {
    this.#connectionGeneration += 1;
    this.#connectionOverview = this.#buildConnectionOverview(snapshot);
    this.#onConnectionEvent(this.#connectionOverview);
  }

  #buildConnectionOverview(snapshot: ReconnectCoordinatorSnapshot): TwitchConnectionOverview {
    return {
      generation: this.#connectionGeneration,
      status: snapshot.status,
      attempt: snapshot.attempt,
      online: snapshot.online,
      session: snapshot.session
        ? { sessionId: snapshot.session.sessionId, state: snapshot.session.state, keepaliveTimeoutSeconds: snapshot.session.keepaliveTimeoutSeconds, lastMessageAtMs: snapshot.session.lastMessageAtMs, closeReason: snapshot.session.closeReason, closeCategory: snapshot.session.closeCategory }
        : null,
      pendingRetryAtMs: snapshot.pendingRetryAtMs,
      dedupe: { size: snapshot.dedupe.size, duplicates: snapshot.dedupe.duplicates, evictedByTtl: snapshot.dedupe.evictedByTtl, evictedByLimit: snapshot.dedupe.evictedByLimit },
      updatedAtMs: snapshot.updatedAtMs,
    };
  }

  #handleReconnectDiagnostic(event: ReconnectDiagnosticEvent): void {
    // Never forward `reconnectUrl`/`messageId` — see overview-contract.ts's TwitchReconnectDiagnosticEvent doc comment.
    let sanitized: TwitchReconnectDiagnosticPush["event"];
    switch (event.type) {
      case "retry_scheduled":
        sanitized = { type: "retry_scheduled", attempt: event.attempt, delayMs: event.delayMs, retryAtMs: event.retryAtMs };
        break;
      case "specified_reconnect_started":
        sanitized = { type: "specified_reconnect_started" };
        break;
      case "specified_reconnect_succeeded":
        sanitized = { type: "specified_reconnect_succeeded" };
        break;
      case "specified_reconnect_fallback":
        sanitized = { type: "specified_reconnect_fallback", reason: event.reason };
        break;
      case "event_gap_warning":
        sanitized = { type: "event_gap_warning", message: event.message };
        break;
      case "duplicate_dropped":
        sanitized = { type: "duplicate_dropped" };
        break;
      case "stopped":
        sanitized = { type: "stopped", reason: event.reason };
        break;
      default:
        return;
    }
    this.#onReconnectDiagnostic({ generation: this.#connectionGeneration, event: sanitized, atMs: this.#now() });
  }

  #handleSubscriptionsSnapshot(snapshot: SubscriptionReconcilerSnapshot): void {
    this.#subscriptionsGeneration += 1;
    this.#subscriptionsOverview = this.#buildSubscriptionsOverview(snapshot);
    this.#onSubscriptionsEvent(this.#subscriptionsOverview);
  }

  #buildSubscriptionsOverview(snapshot: SubscriptionReconcilerSnapshot): TwitchSubscriptionsOverview {
    return {
      generation: this.#subscriptionsGeneration,
      sessionId: snapshot.sessionId,
      welcomeAtMs: snapshot.welcomeAtMs,
      subscriptionDeadlineAtMs: snapshot.subscriptionDeadlineAtMs,
      deadlineMissed: snapshot.deadlineMissed,
      entries: snapshot.entries.map((entry) => ({
        key: entry.key,
        type: entry.type,
        version: entry.version,
        feature: entry.feature,
        subscriptionId: entry.subscriptionId,
        actualStatus: entry.actualStatus,
        entryStatus: entry.entryStatus,
        lastError: entry.lastError ? { ...entry.lastError } : null,
        revocation: entry.revocation ? { category: entry.revocation.category, actionable: entry.revocation.actionable, message: entry.revocation.message } : null,
        suppressedUntilMs: entry.suppressedUntilMs,
        updatedAtMs: entry.updatedAtMs,
      })),
      updatedAtMs: snapshot.updatedAtMs,
    };
  }
}
