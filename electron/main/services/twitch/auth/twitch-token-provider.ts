// Issue #84: the single Main-process-internal chokepoint every future Twitch service module
// (EventSub, Helix, #52/#66) is expected to call before making an authenticated request —
// `getValidAccessToken(requiredScopes)`. Owns the token's whole post-acquisition lifecycle that
// #83's device-code-flow.ts deliberately stops short of: persisting the token pair into #42's
// SecretStore, validating it (on the token handoff itself, at startup, hourly while a session is
// "ready", immediately after suspend/resume, and reactively on a caller-reported 401), refreshing
// it through #68's retry-policy.ts with bounded transient retries, and rotating to Twitch's
// always-new refresh_token on every successful refresh. Never itself talks over IPC or writes
// anything Renderer-visible — see twitch-token-provider.test.mjs's assertNoSecretLeak for the
// standing invariant.
//
// State machine (deliberately smaller than device-code-flow.ts's — there is only ever "do we have
// a token that Twitch currently accepts" to track, not a multi-step handshake):
//   unauthenticated -> valid -> reauth_required
//        ^                            |
//        +----------------------------+   (only a fresh Device Code Grant's onTokenObtained can
//                                           bring the provider back out of reauth_required)
//
// Coalescing: TWO independent single-flight joins keep concurrent callers from ever triggering
// more than one validate or one refresh HTTP call — `#pendingValidate` (this file) for concurrent
// validate triggers, and TokenRefreshMutex (token-refresh-mutex.ts) for concurrent refresh
// triggers. Both rely on the same "assign the in-flight Promise before any `await`" idiom (see
// token-refresh-mutex.ts's doc comment) — never a boolean flag with a race window.
import { ServiceError, normalizeServiceError } from "../../service-error";
import type { RetryPolicy } from "../../retry-policy";
import { createStructuredLogContext } from "../../structured-log-context";
import { parseSecretKey } from "../../../secrets/secret-keys";
import type { SecretStore } from "../../../../shared/secret-contract";
import type { RequestContext } from "../../../../shared/services/service-contract";
import type { TwitchOAuthClient } from "./twitch-oauth-client";
import type { TwitchAuthTokenHandoff } from "./device-code-flow";
import { validateTwitchToken } from "./twitch-token-validator";
import type { TokenValidationOutcome } from "./twitch-token-validator";
import { refreshTwitchToken } from "./twitch-token-refresher";
import { AuthMetadataRepository } from "./auth-metadata-repository";
import type { TwitchAuthMetadata } from "./auth-metadata-repository";
import { TokenRefreshMutex } from "./token-refresh-mutex";

const SERVICE_ID = "twitch:auth:token";
/** "1時間ごと" per issue #84's TODO list. */
const DEFAULT_VALIDATE_INTERVAL_MS = 60 * 60 * 1000;

/** #42's SecretStore keys this provider owns exclusively — nothing else in the app should ever
 * read/write these directly (mirrors HUGGING_FACE_TOKEN_SECRET_KEY's precedent in
 * model-download-service.ts: the constant lives next to the code that owns it, not in a shared
 * enum). */
export const TWITCH_ACCESS_TOKEN_SECRET_KEY = "twitch.access-token";
export const TWITCH_REFRESH_TOKEN_SECRET_KEY = "twitch.refresh-token";
const ACCESS_TOKEN_KEY = parseSecretKey(TWITCH_ACCESS_TOKEN_SECRET_KEY);
const REFRESH_TOKEN_KEY = parseSecretKey(TWITCH_REFRESH_TOKEN_SECRET_KEY);

export type TwitchTokenProviderStatus = "unauthenticated" | "valid" | "reauth_required";

export type TwitchTokenProviderErrorReason = "unauthenticated" | "insufficient_scope" | "reauth_required" | "disposed" | "transient";

/** Thrown by getValidAccessToken() — callers (future Twitch service modules) are expected to
 * catch this and branch on `.reason`: `reauth_required`/`unauthenticated` mean "stop and surface a
 * reauthorize prompt"; `insufficient_scope` means "this specific call needs a scope the current
 * grant doesn't have" (only a fresh Device Code Grant with that scope added can fix it — refresh
 * never grants new scopes). */
export class TwitchTokenProviderError extends Error {
  constructor(readonly reason: TwitchTokenProviderErrorReason, message: string) {
    super(message);
    this.name = "TwitchTokenProviderError";
  }
}

export type TwitchTokenProviderDeps = {
  now?: () => number;
  /** Same shape as device-code-flow.ts's `sleep` dep — used for the hourly validate loop so tests
   * drive it with a fake clock instead of a real wall-clock wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  validateIntervalMs?: number;
  /** Forwarded to twitch-token-refresher.ts's retryWithPolicy call. */
  retryPolicy?: RetryPolicy;
  /** Fired synchronously whenever the provider transitions into reauth_required, in addition to
   * (not instead of) getValidAccessToken() throwing for any caller already waiting on a token —
   * lets a future wiring point (e.g. #52/#66's EventSub connection manager) proactively stop
   * itself and surface a reauthorize prompt without waiting for its next getValidAccessToken()
   * call to fail. */
  onReauthRequired?: (reason: string) => void;
  /** Issue #85: fired synchronously immediately after every successful
   * `#metadataRepository.bumpGeneration()` call (a brand-new Device Code Grant token via
   * handleTokenObtained(), a successful refresh rotation, or logout()) — the wiring point for
   * twitch-auth-coordinator.ts's own auth-generation-changed subscription, which future EventSub/
   * IRC/health modules use to know "your token/account just changed, drop your session".
   * Deliberately reuses AuthMetadataRepository.bumpGeneration() as the sole counter rather than
   * introducing a second one here — see that method's doc comment. */
  onGenerationChanged?: (generation: number) => void;
};

export class TwitchTokenProvider {
  readonly #metadataRepository = new AuthMetadataRepository();
  readonly #mutex = new TokenRefreshMutex();
  readonly #controller = new AbortController();
  #status: TwitchTokenProviderStatus = "unauthenticated";
  #accessToken: string | null = null;
  #refreshToken: string | null = null;
  #lastValidatedAtMs: number | null = null;
  #pendingValidate: Promise<void> | undefined;
  #hourlyController: AbortController | undefined;
  #disposed = false;
  #sequence = 0;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #validateIntervalMs: number;
  readonly #retryPolicy: RetryPolicy | undefined;
  readonly #onReauthRequired: (reason: string) => void;
  readonly #onGenerationChanged: (generation: number) => void;

  constructor(
    private readonly oauthClient: TwitchOAuthClient,
    private readonly clientId: string,
    private readonly secretStore: SecretStore,
    deps: TwitchTokenProviderDeps = {},
  ) {
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#validateIntervalMs = deps.validateIntervalMs ?? DEFAULT_VALIDATE_INTERVAL_MS;
    this.#retryPolicy = deps.retryPolicy;
    this.#onReauthRequired = deps.onReauthRequired ?? (() => {});
    this.#onGenerationChanged = deps.onGenerationChanged ?? (() => {});
  }

  get status(): TwitchTokenProviderStatus {
    return this.#status;
  }

  /** Read-only introspection for tests/future health-console wiring (#149) — never carries a
   * token, see auth-metadata-repository.ts. */
  getMetadataSnapshot(): TwitchAuthMetadata {
    return this.#metadataRepository.get();
  }

  get isRefreshing(): boolean {
    return this.#mutex.isRefreshing;
  }

  // -----------------------------------------------------------------------------------------
  // Lifecycle entry points (app起動時 / suspend-resume / app quit)
  // -----------------------------------------------------------------------------------------

  /** "app起動時validateを実装" — loads whatever token pair survived from a previous run out of
   * #42's SecretStore and validates it before anything may trust it. Call once at app startup,
   * before any getValidAccessToken() caller could plausibly run. A missing/partial token pair
   * (fresh install, or a previous run that never completed auth) is `unauthenticated`, not an
   * error. */
  async initialize(): Promise<void> {
    if (this.#disposed) return;
    this.#accessToken = await this.secretStore.getForService(ACCESS_TOKEN_KEY);
    this.#refreshToken = await this.secretStore.getForService(REFRESH_TOKEN_KEY);
    if (!this.#accessToken || !this.#refreshToken) {
      this.#status = "unauthenticated";
      return;
    }
    await this.#validateCoalesced("startup");
  }

  /** Main-process-internal handoff for #83's DeviceCodeFlow — wire as (a wrapper around)
   * `DeviceCodeFlowDeps.onTokenObtained`. That callback's own signature is synchronous
   * fire-and-forget (`(token) => void`), so the wiring point is expected to be
   * `onTokenObtained: (token) => { void provider.handleTokenObtained(token).catch(...); }`.
   *
   * Order matches issue #84's TODO list precisely: validate the brand-new token FIRST (checking
   * client_id — user_id has nothing to compare against yet, this call is what establishes it) —
   * only once that succeeds does anything get written to SecretStore. A token that fails its very
   * first validation is never persisted; there is nothing to roll back. */
  async handleTokenObtained(handoff: TwitchAuthTokenHandoff): Promise<void> {
    if (this.#disposed) return;
    let outcome: TokenValidationOutcome;
    try {
      outcome = await validateTwitchToken(this.oauthClient, { accessToken: handoff.accessToken, expectedClientId: this.clientId, expectedUserId: null, now: this.#now }, this.#controller.signal);
    } catch (error) {
      if (this.#isCancelled(error)) return;
      await this.#enterReauthRequired("validating the newly obtained token failed unexpectedly");
      return;
    }
    if (outcome.status === "transient") {
      // A network blip / 429 / 5xx confirming a brand-new token is not evidence the token is
      // bad (same semantic the main validate loop already applies) — nothing has been persisted
      // yet, so there is no trust state to protect, but forcing reauth_required here would be
      // misleading (it specifically means "the grant itself is dead, redo Device Code Flow") and
      // would fire the reauth-required callback needlessly. Surface it as a distinct, retryable
      // failure instead so the caller (the Device Code Flow completion handler) can decide to
      // retry rather than restart the whole authorization from scratch.
      throw new TwitchTokenProviderError("transient", `could not confirm the newly obtained token (${outcome.message})`);
    }
    if (outcome.status !== "valid") {
      await this.#enterReauthRequired(`newly obtained token failed validation (${outcome.status})`);
      return;
    }
    await this.#persistToken(handoff.accessToken, handoff.refreshToken);
    // A brand-new Device Code Grant supersedes whatever account/scopes were previously recorded
    // (including a stale one left over from a prior reauth_required) — never let a previous
    // grant's scopes linger against the new token's identity.
    this.#metadataRepository.resetIdentity();
    const generation = this.#metadataRepository.bumpGeneration();
    // #applyValidated() flips `#status` to "valid" — onGenerationChanged must fire AFTER that, not
    // before, so a listener reading `status` synchronously from within its callback (issue #85's
    // twitch-auth-coordinator.ts does exactly this) observes the already-updated status rather than
    // a stale "unauthenticated"/"reauth_required" left over from before this token was obtained.
    this.#applyValidated(outcome);
    this.#onGenerationChanged(generation);
  }

  /** "suspend/resume後の即時validateを実装" — wire to Electron's `powerMonitor.on("resume", ...)`.
   * Fire-and-forget by design (powerMonitor's event has no way to await a handler); errors are
   * swallowed here the same way the hourly loop swallows them — a failed opportunistic validate
   * just means the next trigger (next hourly tick, next reactive 401) gets another chance. */
  onSystemResume(): void {
    if (this.#disposed) return;
    void this.#validateCoalesced("resume").catch(() => {});
  }

  /** Issue #85: user-initiated logout — NOT the same as dispose() (app quit). Clears the token
   * pair from #42's SecretStore and memory, stops the hourly validate timer, and resets
   * account/scope metadata back to empty while keeping authGeneration monotonic (the same
   * resetIdentity()+bumpGeneration() idiom handleTokenObtained() already uses for "a new identity
   * supersedes whatever was recorded before" — here the new identity is "none"). The provider
   * itself remains usable afterward: a subsequent initialize()/handleTokenObtained() for a fresh
   * login both still work normally, unlike dispose() which is terminal.
   *
   * Waits for any in-flight validate/refresh to settle FIRST (via waitForIdle()) so a
   * late-resolving validate/refresh triggered before logout() was called can never resurrect a
   * status this call is about to clear. */
  async logout(): Promise<void> {
    if (this.#disposed) return;
    await this.waitForIdle();
    if (this.#disposed) return;
    this.#stopHourlyTimer();
    await this.secretStore.remove(ACCESS_TOKEN_KEY).catch(() => {});
    await this.secretStore.remove(REFRESH_TOKEN_KEY).catch(() => {});
    this.#accessToken = null;
    this.#refreshToken = null;
    this.#lastValidatedAtMs = null;
    this.#status = "unauthenticated";
    this.#metadataRepository.resetIdentity();
    this.#onGenerationChanged(this.#metadataRepository.bumpGeneration());
  }

  /** App quit: stops the hourly loop immediately and aborts any in-flight validate/refresh HTTP
   * call. Safe to call multiple times. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopHourlyTimer();
    this.#controller.abort();
  }

  /** Test/cleanup seam: resolves once any in-flight validate and/or refresh this instance started
   * has settled — mirrors DeviceCodeFlow's waitForSettled(). */
  async waitForIdle(): Promise<void> {
    await this.#pendingValidate?.catch(() => {});
    await this.#mutex.waitForIdle();
  }

  // -----------------------------------------------------------------------------------------
  // The chokepoint
  // -----------------------------------------------------------------------------------------

  /** Returns a currently-valid access token, or throws TwitchTokenProviderError. `requiredScopes`
   * defaults to none (any valid token satisfies an empty requirement). Concurrent callers during
   * an in-flight validate or refresh all resolve/reject together off the SAME underlying attempt —
   * see the module doc comment. */
  async getValidAccessToken(requiredScopes: string[] = []): Promise<string> {
    this.#assertNotDisposed();

    // Join whatever refresh is already in flight (e.g. triggered a moment ago by another caller's
    // reportUnauthorized()) instead of racing a cached token that may be rotated out from under
    // this call before it returns.
    if (this.#mutex.current) await this.#mutex.current.catch(() => {});
    this.#assertNotDisposed(); // dispose() may have settled the in-flight refresh via cancellation while this call was waiting on it

    this.#assertUsable();
    this.#assertScopes(requiredScopes);

    const isStale = this.#lastValidatedAtMs === null || this.#now() - this.#lastValidatedAtMs >= this.#validateIntervalMs;
    if (isStale) await this.#validateCoalesced("on-demand");
    this.#assertNotDisposed();

    this.#assertUsable();
    this.#assertScopes(requiredScopes);
    if (!this.#accessToken) throw new TwitchTokenProviderError("unauthenticated", "Twitch is not yet authorized");
    return this.#accessToken;
  }

  /** "service 401時のreactive refreshを実装" — a Twitch service module (EventSub/Helix caller)
   * calls this after its own request comes back 401. `usedAccessToken` guards against a stale
   * report about a token this provider has already rotated away from (e.g. two services shared
   * the old token, one reports 401 after the other already triggered — and completed — a refresh)
   * triggering a redundant second refresh. */
  async reportUnauthorized(usedAccessToken: string): Promise<void> {
    if (this.#disposed || this.#status === "reauth_required") return;
    if (this.#accessToken !== usedAccessToken) return;
    await this.#refreshAndRevalidate("reactive-401");
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new TwitchTokenProviderError("disposed", "Twitch token provider has been disposed");
  }

  #assertUsable(): void {
    if (this.#status === "reauth_required") throw new TwitchTokenProviderError("reauth_required", "Twitch authorization is no longer valid; reauthorization is required");
    if (this.#status === "unauthenticated") throw new TwitchTokenProviderError("unauthenticated", "Twitch is not yet authorized");
  }

  #assertScopes(requiredScopes: string[]): void {
    if (requiredScopes.length === 0) return;
    const granted = this.#metadataRepository.get().scopes;
    const missing = requiredScopes.filter((scope) => !granted.includes(scope));
    // A refresh never grants a scope the original grant didn't have (Twitch preserves the
    // original scope set on refresh) — insufficient_scope can only be resolved by a fresh Device
    // Code Grant requesting the missing scope(s), so this never triggers a validate/refresh
    // attempt of its own.
    if (missing.length > 0) throw new TwitchTokenProviderError("insufficient_scope", `missing required Twitch scope(s): ${missing.join(", ")}`);
  }

  // -----------------------------------------------------------------------------------------
  // Validate
  // -----------------------------------------------------------------------------------------

  /** Single-flight wrapper around #validateNow — see the module doc comment. */
  async #validateCoalesced(reason: string): Promise<void> {
    if (this.#pendingValidate) return this.#pendingValidate;
    const promise = this.#validateNow(reason).finally(() => {
      if (this.#pendingValidate === promise) this.#pendingValidate = undefined;
    });
    this.#pendingValidate = promise;
    return promise;
  }

  async #validateNow(reason: string): Promise<void> {
    if (this.#disposed || !this.#accessToken) {
      if (!this.#disposed) this.#status = "unauthenticated";
      return;
    }
    let outcome: TokenValidationOutcome;
    try {
      outcome = await validateTwitchToken(this.oauthClient, { accessToken: this.#accessToken, expectedClientId: this.clientId, expectedUserId: this.#metadataRepository.get().account?.userId ?? null, now: this.#now }, this.#controller.signal);
    } catch (error) {
      // Cancellation (dispose() mid-validate) and any other unexpected local failure both leave
      // the current trust state untouched — neither is proof the token itself is bad.
      if (!this.#isCancelled(error)) this.#log("validate failed unexpectedly", { reason, errorName: error instanceof Error ? error.name : typeof error });
      return;
    }
    switch (outcome.status) {
      case "valid":
        this.#applyValidated(outcome);
        return;
      case "invalid":
        await this.#refreshAndRevalidate(reason);
        return;
      case "client_mismatch":
      case "user_mismatch":
        await this.#enterReauthRequired(`${outcome.status} observed during ${reason} validate`);
        return;
      case "transient":
        return;
    }
  }

  #applyValidated(outcome: Extract<TokenValidationOutcome, { status: "valid" }>): void {
    this.#metadataRepository.recordValidated({ account: outcome.account, clientId: outcome.clientId, scopes: outcome.scopes, expiresAt: outcome.expiresAt, validatedAt: this.#iso() });
    this.#status = "valid";
    this.#lastValidatedAtMs = this.#now();
    this.#startHourlyTimer();
  }

  // -----------------------------------------------------------------------------------------
  // Refresh
  // -----------------------------------------------------------------------------------------

  async #refreshAndRevalidate(reason: string): Promise<void> {
    if (this.#disposed) return;
    if (!this.#refreshToken) {
      await this.#enterReauthRequired(`no refresh token available (${reason})`);
      return;
    }
    await this.#mutex.run(async () => {
      if (this.#disposed || !this.#refreshToken) return;
      let outcome;
      try {
        outcome = await refreshTwitchToken(this.oauthClient, { clientId: this.clientId, refreshToken: this.#refreshToken }, { signal: this.#controller.signal, requestContext: this.#requestContext("twitch-token-refresh"), retryPolicy: this.#retryPolicy, sleep: this.#sleep });
      } catch (error) {
        if (!this.#isCancelled(error)) this.#log("refresh failed unexpectedly", { reason, errorName: error instanceof Error ? error.name : typeof error });
        return;
      }
      if (outcome.status === "refreshed") {
        // Twitch always rotates refresh_token on a successful call — persisting the new pair
        // together (before either is trusted) means the old refresh_token is never written back
        // and never reused for a subsequent refresh attempt.
        await this.#persistToken(outcome.token.accessToken, outcome.token.refreshToken);
        const generation = this.#metadataRepository.bumpGeneration();
        // Same ordering rationale as handleTokenObtained(): fire onGenerationChanged only after
        // #validateAfterRefresh() has settled `#status` to its final value (valid/reauth_required/
        // unchanged-on-transient), never before. Skipped entirely when that lands in
        // reauth_required — #enterReauthRequired() (called from inside #validateAfterRefresh) has
        // already invoked onReauthRequired for that same transition, so firing onGenerationChanged
        // too would double-notify subscribers about one logical event.
        await this.#validateAfterRefresh();
        if (this.#status !== "reauth_required") this.#onGenerationChanged(generation);
        return;
      }
      if (outcome.status === "reauth_required") {
        await this.#enterReauthRequired(outcome.message);
        return;
      }
      // transient_failure: bounded retries already ran inside refreshTwitchToken (retry-policy.ts)
      // — leave the current token/status untouched so the next trigger gets another chance rather
      // than forcing a reauth over what may just be a network hiccup.
    });
  }

  /** "refresh成功後に再validate" — confirms the rotated token is actually live before trusting it,
   * and re-establishes metadata (scopes/expiry) from Twitch's own authoritative response rather
   * than assuming the refresh response's shape implies anything about validity. A rejection here
   * (extremely unusual — a token Twitch itself just issued failing its own validate) goes straight
   * to reauth_required rather than looping back into another refresh with the same, presumably
   * still-good, freshly-rotated refresh_token. */
  async #validateAfterRefresh(): Promise<void> {
    if (this.#disposed || !this.#accessToken) return;
    let outcome: TokenValidationOutcome;
    try {
      outcome = await validateTwitchToken(this.oauthClient, { accessToken: this.#accessToken, expectedClientId: this.clientId, expectedUserId: this.#metadataRepository.get().account?.userId ?? null, now: this.#now }, this.#controller.signal);
    } catch (error) {
      if (this.#isCancelled(error)) return;
      await this.#enterReauthRequired("post-refresh validate failed unexpectedly");
      return;
    }
    if (outcome.status === "valid") {
      this.#applyValidated(outcome);
      return;
    }
    if (outcome.status === "transient") {
      // Same "leave trust state alone" semantic as the main validate loop's transient case
      // (twitch-token-provider.ts's `#validate` switch below) — the new access/refresh pair is
      // already persisted by #refreshAndRevalidate before this method runs, so a network blip /
      // 429 / 5xx here must not discard freshly-rotated, presumably-good credentials. The next
      // validate trigger (hourly timer, reactive 401, resume) gets another chance to confirm it.
      this.#log("post-refresh validate was transient; keeping rotated token, will re-validate later", { message: outcome.message });
      return;
    }
    await this.#enterReauthRequired(`post-refresh validate rejected the rotated token (${outcome.status})`);
  }

  // -----------------------------------------------------------------------------------------
  // Terminal transition + persistence
  // -----------------------------------------------------------------------------------------

  async #enterReauthRequired(reason: string): Promise<void> {
    this.#log("entering reauth_required", { reason });
    this.#status = "reauth_required";
    this.#accessToken = null;
    this.#refreshToken = null;
    this.#stopHourlyTimer();
    // Wipe both entries from #42's SecretStore too — a dead refresh_token (invalid_grant) or an
    // identity mismatch means neither value should ever be handed out again, including after an
    // app restart before a fresh Device Code Grant completes. remove() failures are swallowed
    // (best-effort; the in-memory state above is already authoritative for this run).
    await this.secretStore.remove(ACCESS_TOKEN_KEY).catch(() => {});
    await this.secretStore.remove(REFRESH_TOKEN_KEY).catch(() => {});
    this.#onReauthRequired(reason);
  }

  async #persistToken(accessToken: string, refreshToken: string): Promise<void> {
    await this.secretStore.set(ACCESS_TOKEN_KEY, accessToken);
    await this.secretStore.set(REFRESH_TOKEN_KEY, refreshToken);
    this.#accessToken = accessToken;
    this.#refreshToken = refreshToken;
  }

  // -----------------------------------------------------------------------------------------
  // Hourly validate loop ("ready session中1時間ごとのvalidate timer")
  // -----------------------------------------------------------------------------------------

  #startHourlyTimer(): void {
    if (this.#disposed || this.#hourlyController) return;
    const controller = new AbortController();
    this.#hourlyController = controller;
    void this.#hourlyLoop(controller.signal);
  }

  #stopHourlyTimer(): void {
    this.#hourlyController?.abort();
    this.#hourlyController = undefined;
  }

  async #hourlyLoop(signal: AbortSignal): Promise<void> {
    try {
      for (;;) {
        try {
          await this.#sleep(this.#validateIntervalMs, signal);
        } catch {
          return; // aborted: dispose() or #enterReauthRequired() stopped the timer
        }
        if (this.#disposed || signal.aborted || this.#status !== "valid") return;
        await this.#validateCoalesced("hourly").catch(() => {});
      }
    } finally {
      // Only clear if this loop still owns #hourlyController — a #stopHourlyTimer() followed
      // immediately by a #startHourlyTimer() (e.g. reauth then a fast reauth-completing retry)
      // may already have installed a newer controller by the time this runs.
      if (this.#hourlyController?.signal === signal) this.#hourlyController = undefined;
    }
  }

  // -----------------------------------------------------------------------------------------

  #isCancelled(error: unknown): boolean {
    return normalizeServiceError(error, { serviceId: SERVICE_ID, signal: this.#controller.signal }).code === "CANCELLED";
  }

  /** Routes every diagnostic line through structured-log-context.ts's redaction idiom — see that
   * file's SECRET_KEY regex. `fields` here is deliberately restricted by every call site
   * above to non-secret data (reason strings, error *names*, status codes): this call never even
   * receives an accessToken/refreshToken-shaped field to redact in the first place. */
  #log(message: string, fields: Record<string, unknown> = {}): void {
    console.error(`[dociai:twitch-token] ${message}`, createStructuredLogContext({ serviceId: SERVICE_ID, fields }));
  }

  #requestContext(ownerId: string): RequestContext {
    this.#sequence += 1;
    return { requestId: `${SERVICE_ID}-${ownerId}-${this.#now()}-${this.#sequence}`, serviceId: SERVICE_ID, generation: 0, ownerId, signal: this.#controller.signal, startedAt: this.#now() };
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false }));
    }, { once: true });
  });
}
