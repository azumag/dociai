// Issue #87: the orchestrator that ties desired-subscriptions.ts, subscription-registry.ts,
// eventsub-subscription-client.ts, and revocation-handler.ts together. Owns exactly the mutable
// state this issue's TODO list asks for: the current desired set (enabled features + broadcaster
// id), the last-known actual state per subscription key, the welcome-derived subscription
// deadline, and per-key revocation suppression — and reconciles all of it against Helix on each
// externally-triggered pass (onWelcome / setEnabledFeatures / setBroadcasterUserId / explicit
// reconcile()).
//
// Deliberately never runs its own retry loop or background timer ("auth/scope不足で無限create
// retryしない"): every failure (auth, scope, conflict, rate-limit, server, network, unknown) is
// surfaced in the snapshot after exactly one attempt per reconcile() pass, and recovery only ever
// happens via the NEXT externally-triggered pass — the same "no automatic reconnection" discipline
// eventsub-service.ts/eventsub-session.ts already apply to the WebSocket connection itself (see
// eventsub-service.ts's module doc comment). This is uniform across every failure category, not
// just auth/scope, which is what keeps the "assert the mock server's request count stays bounded"
// test simple: a single reconcile() pass makes a small, fixed number of requests no matter what
// Helix returns.
//
// "WebSocket session IDをtransportへ設定" / "welcome受信時刻からsubscription deadlineを管理": per
// Twitch's own documented EventSub WebSocket behavior (https://dev.twitch.tv/docs/eventsub/
// handling-websocket-events/), a client has 10 seconds from receiving session_welcome to create at
// least one subscription before Twitch closes the connection (Twitch4J's EventSubSubscriptionStatus
// even names this WEBSOCKET_CONNECTION_UNUSED) — the same 10-second figure eventsub-session.ts's
// own DEFAULT_WELCOME_TIMEOUT_MS already uses for a DIFFERENT wait (time to RECEIVE welcome at
// all). DEFAULT_SUBSCRIPTION_DEADLINE_MS below is that second, distinct 10-second window.
import { FEATURE_SCOPES } from "../auth/twitch-scope-registry";
import type { TwitchFeature } from "../auth/twitch-scope-registry";
import type { EventSubEnvelope } from "./eventsub-message-parser";
import type { Clock } from "./keepalive-watchdog";
import { systemClock } from "./keepalive-watchdog";
import { desiredSubscriptions, requiredScopesForDesired } from "./desired-subscriptions";
import type { DesiredSubscription } from "./desired-subscriptions";
import { diffSubscriptions, indexActualSubscriptions, subscriptionKey } from "./subscription-registry";
import type { ActualSubscription, SubscriptionCondition } from "./subscription-registry";
import { EventSubSubscriptionClient } from "./eventsub-subscription-client";
import type { CreateSubscriptionResult, ListSubscriptionsResult } from "./eventsub-subscription-client";
import { RevocationHandler } from "./revocation-handler";
import type { RevocationCategory, RevocationClassification, RevocationOutcome } from "./revocation-handler";

/** Twitch's documented "create within 10 seconds of session_welcome, or the connection is closed"
 * window — see the module doc comment for where this was cross-checked. Our own choice would be
 * risky to invent; this is Twitch's own number, used as-is. */
export const DEFAULT_SUBSCRIPTION_DEADLINE_MS = 10_000;

/** "create requestの小規模並列実行を実装" — a small worker pool, never one huge `Promise.all`
 * blast. This app's own desired set is at most 5 entries, so this bound mostly exists to keep the
 * behavior deliberate (and easy to reason about under a mocked server) rather than because 5
 * concurrent requests would meaningfully stress Twitch's API. */
export const DEFAULT_CREATE_CONCURRENCY = 3;

async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  async function runner(): Promise<void> {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => runner()));
}

/** The subset of #85's TwitchTokenProvider (reached via TwitchAuthCoordinator) this reconciler
 * depends on, expressed structurally — the same "depend on the shape, not the class" seam
 * eventsub-service.ts's own EventSubAuthSource uses. */
export type SubscriptionReconcilerAuthSource = { getValidAccessToken(requiredScopes?: string[]): Promise<string> };

export type SubscriptionEntryStatus = "pending" | "creating" | "active" | "missing_scope" | "unauthorized" | "error" | "suppressed" | "removed";

export type SubscriptionEntryError = { errorCode: string; status?: number; message: string };

export type SubscriptionSnapshotEntry = {
  key: string;
  type: string;
  version: string;
  condition: SubscriptionCondition;
  /** null for an entry the reconciler discovered only via the actual list (a lingering/extra
   * subscription no currently-desired feature maps to) — see #ensureUntrackedEntry(). */
  feature: TwitchFeature | null;
  subscriptionId: string | null;
  /** Twitch's own reported status string once known ("enabled", or a revoked-with-reason value —
   * "actual subscription statusをsnapshotへ保持", issue #87's TODO). */
  actualStatus: string | null;
  entryStatus: SubscriptionEntryStatus;
  lastError: SubscriptionEntryError | null;
  revocation: RevocationClassification | null;
  suppressedUntilMs: number | null;
  updatedAtMs: number;
};

export type SubscriptionReconcilerSnapshot = {
  sessionId: string | null;
  welcomeAtMs: number | null;
  subscriptionDeadlineAtMs: number | null;
  /** True once `now() > subscriptionDeadlineAtMs` while at least one desired entry is still not
   * active (and not permanently blocked) — a diagnostic signal ("desired eventをwelcome期限内に
   * 購読できる" acceptance criterion), not something this reconciler acts on itself (it never owns
   * the WebSocket connection's lifecycle; eventsub-session.ts is the sole authority on whether the
   * connection itself survived). */
  deadlineMissed: boolean;
  entries: SubscriptionSnapshotEntry[];
  updatedAtMs: number;
};

/** "subscription resultを#55/#66へ通知" (issue #87's TODO) — fired on every observable state
 * change, the same "onEvent for a raw feed" half of the dual-delivery pattern eventsub-service.ts
 * already uses (`onEvent` + IntegrationHealth). #66's own HealthProvider adapter and #55's own UI
 * are future issues; this is the seam they are expected to subscribe through. */
export type SubscriptionReconcilerDeps = {
  clock?: Clock;
  concurrency?: number;
  subscriptionDeadlineMs?: number;
  revocationHandler?: RevocationHandler;
  onSnapshotChange?: (snapshot: SubscriptionReconcilerSnapshot) => void;
  /** "scope不足/401→auth coordination" — fired (never as a retry trigger of its own) whenever a
   * create/list call comes back 401/403, or a revocation is classified `auth`, or
   * getValidAccessToken() itself throws. `reason` distinguishes "the token itself is bad" from
   * "the token is fine but missing a scope" so the caller (twitch-auth-coordinator.ts, in a future
   * composition-root wiring) can decide between a reauth prompt and startScopeUpgrade(). */
  onAuthProblem?: (info: { key: string; requiredScopes: readonly string[]; reason: "unauthorized" | "forbidden" | "revoked" }) => void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

function authFailureReason(error: unknown): "unauthorized" | "forbidden" {
  const reason = error && typeof error === "object" && "reason" in error ? (error as { reason?: unknown }).reason : undefined;
  return reason === "insufficient_scope" ? "forbidden" : "unauthorized";
}

/** Maps a revocation's classification onto the entry status a snapshot consumer should see —
 * shared by onRevocation() (the moment a revocation arrives) and #markSuppressed() (every LATER
 * reconcile() pass that finds the key still suppressed/blocked). Keeping this in one place matters:
 * a permanently-blocked `auth`/`not_recoverable` key must keep showing its specific reason on every
 * subsequent pass, never regress to a generic "suppressed" that reads as "transient, will heal on
 * its own" (see #markSuppressed()'s doc comment). */
function entryStatusForRevocationCategory(category: RevocationCategory): SubscriptionEntryStatus {
  if (category === "auth") return "unauthorized";
  if (category === "not_recoverable") return "error";
  return "suppressed";
}

export class SubscriptionReconciler {
  readonly #client: EventSubSubscriptionClient;
  readonly #authSource: SubscriptionReconcilerAuthSource;
  readonly #clientId: string;
  readonly #clock: Clock;
  readonly #concurrency: number;
  readonly #subscriptionDeadlineMs: number;
  readonly #revocationHandler: RevocationHandler;
  readonly #onSnapshotChange: (snapshot: SubscriptionReconcilerSnapshot) => void;
  readonly #onAuthProblem: (info: { key: string; requiredScopes: readonly string[]; reason: "unauthorized" | "forbidden" | "revoked" }) => void;
  readonly #log: (message: string, fields?: Record<string, unknown>) => void;

  readonly #entries = new Map<string, SubscriptionSnapshotEntry>();
  #enabledFeatures: string[] = [];
  #broadcasterUserId: string | null = null;
  #sessionId: string | null = null;
  #welcomeAtMs: number | null = null;
  #subscriptionDeadlineAtMs: number | null = null;
  #deadlineMissed = false;
  #generation = 0;
  #disposed = false;

  constructor(client: EventSubSubscriptionClient, authSource: SubscriptionReconcilerAuthSource, clientId: string, deps: SubscriptionReconcilerDeps = {}) {
    this.#client = client;
    this.#authSource = authSource;
    this.#clientId = clientId;
    this.#clock = deps.clock ?? systemClock;
    this.#concurrency = deps.concurrency ?? DEFAULT_CREATE_CONCURRENCY;
    this.#subscriptionDeadlineMs = deps.subscriptionDeadlineMs ?? DEFAULT_SUBSCRIPTION_DEADLINE_MS;
    this.#revocationHandler = deps.revocationHandler ?? new RevocationHandler({ clock: this.#clock });
    this.#onSnapshotChange = deps.onSnapshotChange ?? (() => {});
    this.#onAuthProblem = deps.onAuthProblem ?? (() => {});
    this.#log = deps.log ?? (() => {});
  }

  get snapshot(): SubscriptionReconcilerSnapshot {
    return {
      sessionId: this.#sessionId,
      welcomeAtMs: this.#welcomeAtMs,
      subscriptionDeadlineAtMs: this.#subscriptionDeadlineAtMs,
      deadlineMissed: this.#deadlineMissed,
      entries: [...this.#entries.values()].map((entry) => ({ ...entry })),
      updatedAtMs: this.#now(),
    };
  }

  get revocationHandler(): RevocationHandler {
    return this.#revocationHandler;
  }

  // -----------------------------------------------------------------------------------------
  // Triggers ("config変更時にdesired/actual差分を算出" / "welcome受信時刻からsubscription
  // deadlineを管理")
  // -----------------------------------------------------------------------------------------

  /** Wire to EventSubService reaching status "running" with a fresh session id (i.e. the moment
   * session_welcome was processed — see eventsub-service.ts's onEvent/eventsub-session.ts's own
   * "connected" state). Starts the subscription deadline and immediately triggers a reconcile
   * pass. Returns the reconcile() promise so tests/callers that need to await completion can. */
  onWelcome(sessionId: string, atMs?: number): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const welcomeAtMs = atMs ?? this.#now();
    this.#sessionId = sessionId;
    this.#welcomeAtMs = welcomeAtMs;
    this.#subscriptionDeadlineAtMs = welcomeAtMs + this.#subscriptionDeadlineMs;
    this.#deadlineMissed = false;
    return this.reconcile();
  }

  /** Wire to the session ending (any reason) — stops treating the old session id as a valid
   * websocket transport target. Bumps `#generation` (same as every other trigger below) so an
   * ALREADY IN-FLIGHT reconcile() pass — e.g. mid-`getValidAccessToken()`/`list()` await, or about
   * to start a `#createOne()` for a still-missing key — notices at its next generation check and
   * bails out instead of racing this method: without this, a create request could otherwise read
   * `this.#sessionId` AFTER it was cleared here and send Twitch a subscription create with a
   * null `session_id`. `welcomeAtMs`/`subscriptionDeadlineAtMs` are intentionally kept for
   * diagnostics until the next onWelcome() overwrites them, mirroring eventsub-session.ts's own
   * convention of keeping the last-known close info visible rather than clearing it out from under
   * the UI. */
  onSessionEnded(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#sessionId = null;
    this.#emitSnapshot();
  }

  /** Issue #88: a Twitch-SPECIFIED (graceful) `session_reconnect` migrates every existing
   * subscription to the new session automatically, server-side — "new welcome後に既存subscription
   * を再作成せず引継ぐ". Unlike onWelcome() this deliberately does NOT call reconcile() (no Helix
   * list/create calls at all — see reconnect-coordinator.ts's own test asserting the Helix
   * create-endpoint request count is unchanged across a specified reconnect): it only retargets
   * which session id a FUTURE create call (for something desired later, e.g. after a config change)
   * should attach to. Bumps the generation like every other trigger (see onSessionEnded's doc
   * comment) so an in-flight reconcile() pass from BEFORE the specified reconnect can't clobber this
   * with a stale session id. */
  retarget(sessionId: string, atMs?: number): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#sessionId = sessionId;
    this.#welcomeAtMs = atMs ?? this.#now();
    this.#emitSnapshot();
  }

  setEnabledFeatures(features: readonly string[]): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#enabledFeatures = [...features];
    return this.reconcile();
  }

  setBroadcasterUserId(userId: string | null): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#broadcasterUserId = userId;
    return this.reconcile();
  }

  /** Wire to EventSubSession's onRevocation callback (via eventsub-service.ts's own
   * onRevocation passthrough). Synchronous, pure state update — never itself triggers a create/
   * recreate attempt; the NEXT externally-triggered reconcile() pass is what (subject to
   * isSuppressed()) may retry the key. */
  onRevocation(envelope: EventSubEnvelope): RevocationOutcome | null {
    if (this.#disposed) return null;
    const outcome = this.#revocationHandler.handle(envelope);
    if (!outcome) {
      this.#log("received a revocation message with an unparseable payload; ignoring", {});
      return null;
    }
    const existing = this.#entries.get(outcome.key);
    this.#entries.set(outcome.key, {
      key: outcome.key,
      type: outcome.subscription.type,
      version: outcome.subscription.version,
      condition: outcome.subscription.condition,
      feature: existing?.feature ?? null,
      subscriptionId: null,
      actualStatus: outcome.subscription.status,
      entryStatus: entryStatusForRevocationCategory(outcome.classification.category),
      lastError: existing?.lastError ?? null,
      revocation: outcome.classification,
      suppressedUntilMs: outcome.suppressedUntilMs,
      updatedAtMs: this.#now(),
    });
    this.#emitSnapshot();
    if (outcome.classification.category === "auth") {
      const requiredScopes = existing?.feature ? FEATURE_SCOPES[existing.feature] : [];
      this.#onAuthProblem({ key: outcome.key, requiredScopes, reason: "revoked" });
    }
    return outcome;
  }

  dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
  }

  // -----------------------------------------------------------------------------------------
  // The reconcile pass itself
  // -----------------------------------------------------------------------------------------

  async reconcile(): Promise<void> {
    if (this.#disposed) return;
    this.#generation += 1;
    const generation = this.#generation;

    const desired = desiredSubscriptions(this.#enabledFeatures, this.#broadcasterUserId);
    for (const entry of desired) this.#ensureEntry(entry);

    if (!this.#sessionId || desired.length === 0) {
      this.#emitSnapshot();
      return;
    }

    const requiredScopes = requiredScopesForDesired(desired);
    let accessToken: string;
    try {
      accessToken = await this.#authSource.getValidAccessToken(requiredScopes);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#applyAuthFailureToAll(desired, error);
      this.#emitSnapshot();
      return;
    }
    if (generation !== this.#generation) return;

    const listResult = await this.#client.list({ accessToken, clientId: this.#clientId });
    if (generation !== this.#generation) return;
    if (!listResult.ok) {
      this.#applyListFailureToAll(desired, listResult);
      this.#emitSnapshot();
      return;
    }

    const actualIndex = indexActualSubscriptions(listResult.subscriptions);
    const diff = diffSubscriptions(desired.map((entry) => entry.key), actualIndex);

    for (const key of diff.satisfied) {
      const actual = actualIndex.get(key);
      if (actual) this.#markActive(key, actual);
    }

    const missingByKey = new Map(desired.map((entry) => [entry.key, entry]));
    const toCreate: DesiredSubscription[] = [];
    for (const key of diff.missing) {
      const entry = missingByKey.get(key);
      if (!entry) continue;
      if (this.#revocationHandler.isSuppressed(key, this.#now())) this.#markSuppressed(key);
      else toCreate.push(entry);
    }

    await runWithConcurrency(toCreate, this.#concurrency, async (entry) => {
      if (generation !== this.#generation) return;
      await this.#createOne(generation, entry, accessToken);
    });
    if (generation !== this.#generation) return;

    // Housekeeping delete for actual subscriptions the current desired set no longer wants at all
    // (e.g. a feature just got disabled) — sequential (not pooled): this is expected to be rare
    // (at most a handful of entries on a config change) and never on the hot "create within
    // deadline" path.
    for (const key of diff.extra) {
      if (generation !== this.#generation) return;
      const actual = actualIndex.get(key);
      if (actual) await this.#deleteExtra(generation, key, actual, accessToken);
    }
    if (generation !== this.#generation) return;

    this.#deadlineMissed = this.#computeDeadlineMissed(this.#now(), new Set(desired.map((entry) => entry.key)));
    this.#emitSnapshot();
  }

  // -----------------------------------------------------------------------------------------
  // Per-key helpers
  // -----------------------------------------------------------------------------------------

  /** `generation` is the CALLER's reconcile() pass id, re-checked after every internal await
   * before this method mutates `this.#entries` — not just before it is invoked (the caller's own
   * guard covers that). Without this, a slow create/re-list here could resolve AFTER a newer,
   * already-completed reconcile() pass has legitimately written fresher state for the same key
   * (e.g. successfully recreated it), and this stale pass would silently clobber that fresher
   * state with its own outdated result. */
  async #createOne(generation: number, entry: DesiredSubscription, accessToken: string): Promise<void> {
    this.#setEntryStatus(entry.key, "creating");
    let result: CreateSubscriptionResult;
    try {
      result = await this.#client.create({ accessToken, clientId: this.#clientId, type: entry.type, version: entry.version, condition: entry.condition, sessionId: this.#sessionId as string });
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#setEntryError(entry.key, { errorCode: "network", message: error instanceof Error ? error.message : "create request failed" });
      this.#setEntryStatus(entry.key, "error");
      return;
    }
    if (generation !== this.#generation) return;

    if (result.ok) {
      this.#markActive(entry.key, result.subscription);
      return;
    }

    switch (result.errorCode) {
      case "conflict": {
        // "duplicate時にactual listを取得してdesiredと照合" — the lingering subscription might
        // belong to a previous WebSocket session; re-fetch and treat a matching, active entry as
        // satisfying desired rather than as an error, instead of leaving this as a bare "409"
        // failure.
        const relist = await this.#client.list({ accessToken, clientId: this.#clientId, type: entry.type });
        if (generation !== this.#generation) return;
        if (relist.ok) {
          const found = relist.subscriptions.find((subscription) => subscriptionKey(subscription) === entry.key && subscription.status === "enabled");
          if (found) {
            this.#markActive(entry.key, found);
            return;
          }
        }
        this.#setEntryError(entry.key, { errorCode: "conflict", status: result.status, message: "a duplicate subscription was reported, but re-checking the actual list did not find a matching active entry" });
        this.#setEntryStatus(entry.key, "error");
        return;
      }
      case "unauthorized":
      case "forbidden":
        // "auth/scope不足で無限create retryしない": surfaced once, never retried within this pass
        // or scheduled for a future one — only an externally-triggered reconcile() (e.g. after a
        // scope upgrade completes) gets another chance.
        this.#setEntryStatus(entry.key, result.errorCode === "unauthorized" ? "unauthorized" : "missing_scope");
        this.#setEntryError(entry.key, { errorCode: result.errorCode, status: result.status, message: result.message });
        this.#onAuthProblem({ key: entry.key, requiredScopes: entry.requiredScopes, reason: result.errorCode });
        return;
      default:
        // rate_limited/server/network/unknown: surfaced as a failed entry for this pass — see the
        // module doc comment for why this reconciler never retries any category internally.
        this.#setEntryStatus(entry.key, "error");
        this.#setEntryError(entry.key, { errorCode: result.errorCode, status: result.status, message: result.message });
        return;
    }
  }

  /** See #createOne()'s doc comment — `generation` is re-checked after the delete call resolves,
   * for the same "don't let a stale pass clobber a fresher one" reason. */
  async #deleteExtra(generation: number, key: string, actual: ActualSubscription, accessToken: string): Promise<void> {
    const result = await this.#client.delete({ accessToken, clientId: this.#clientId, id: actual.id });
    if (generation !== this.#generation) return;
    const entry = this.#entries.get(key) ?? this.#ensureUntrackedEntry(key, actual);
    if (result.ok) {
      this.#entries.set(key, { ...entry, subscriptionId: null, actualStatus: "removed", entryStatus: "removed", lastError: null, updatedAtMs: this.#now() });
    } else {
      this.#entries.set(key, { ...entry, lastError: { errorCode: result.errorCode, status: result.status, message: result.message }, updatedAtMs: this.#now() });
    }
  }

  #applyAuthFailureToAll(desired: readonly DesiredSubscription[], error: unknown): void {
    const reason = authFailureReason(error);
    const message = error instanceof Error ? error.message : "failed to obtain a valid Twitch access token";
    for (const entry of desired) {
      this.#ensureEntry(entry);
      this.#setEntryStatus(entry.key, reason === "forbidden" ? "missing_scope" : "unauthorized");
      this.#setEntryError(entry.key, { errorCode: reason, message });
    }
    if (desired.length > 0) this.#onAuthProblem({ key: desired[0].key, requiredScopes: requiredScopesForDesired(desired), reason });
  }

  #applyListFailureToAll(desired: readonly DesiredSubscription[], result: Extract<ListSubscriptionsResult, { ok: false }>): void {
    const entryStatus: SubscriptionEntryStatus = result.errorCode === "unauthorized" ? "unauthorized" : result.errorCode === "forbidden" ? "missing_scope" : "error";
    for (const entry of desired) {
      this.#ensureEntry(entry);
      this.#setEntryStatus(entry.key, entryStatus);
      this.#setEntryError(entry.key, { errorCode: result.errorCode, status: result.status, message: result.message });
    }
    if (desired.length > 0 && (result.errorCode === "unauthorized" || result.errorCode === "forbidden")) {
      this.#onAuthProblem({ key: desired[0].key, requiredScopes: requiredScopesForDesired(desired), reason: result.errorCode });
    }
  }

  #ensureEntry(desiredEntry: DesiredSubscription): SubscriptionSnapshotEntry {
    let entry = this.#entries.get(desiredEntry.key);
    if (!entry) {
      entry = {
        key: desiredEntry.key,
        type: desiredEntry.type,
        version: desiredEntry.version,
        condition: desiredEntry.condition,
        feature: desiredEntry.feature,
        subscriptionId: null,
        actualStatus: null,
        entryStatus: "pending",
        lastError: null,
        revocation: null,
        suppressedUntilMs: null,
        updatedAtMs: this.#now(),
      };
      this.#entries.set(desiredEntry.key, entry);
    } else if (entry.feature === null) {
      entry = { ...entry, feature: desiredEntry.feature };
      this.#entries.set(desiredEntry.key, entry);
    }
    return entry;
  }

  #ensureUntrackedEntry(key: string, actual: ActualSubscription): SubscriptionSnapshotEntry {
    const entry: SubscriptionSnapshotEntry = {
      key,
      type: actual.type,
      version: actual.version,
      condition: actual.condition,
      feature: null,
      subscriptionId: actual.id,
      actualStatus: actual.status,
      entryStatus: "active",
      lastError: null,
      revocation: null,
      suppressedUntilMs: null,
      updatedAtMs: this.#now(),
    };
    this.#entries.set(key, entry);
    return entry;
  }

  #markActive(key: string, actual: ActualSubscription): void {
    const entry = this.#entries.get(key) ?? this.#ensureUntrackedEntry(key, actual);
    this.#entries.set(key, { ...entry, subscriptionId: actual.id, actualStatus: actual.status, entryStatus: "active", lastError: null, revocation: null, suppressedUntilMs: null, updatedAtMs: this.#now() });
  }

  /** Called on every reconcile() pass that finds a desired-but-missing key still governed by
   * revocation-handler.ts's suppression/block (isSuppressed()). Reuses the ORIGINAL revocation's
   * classification (via lastOutcome()) to pick the entry status — a permanently-blocked `auth`/
   * `not_recoverable` key must keep reading as "unauthorized"/"error" on every subsequent pass, not
   * regress to a generic "suppressed" that would misleadingly suggest it will self-heal. */
  #markSuppressed(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    const outcome = this.#revocationHandler.lastOutcome(key);
    const entryStatus = outcome ? entryStatusForRevocationCategory(outcome.classification.category) : "suppressed";
    this.#entries.set(key, { ...entry, entryStatus, suppressedUntilMs: outcome?.suppressedUntilMs ?? null, updatedAtMs: this.#now() });
  }

  #setEntryStatus(key: string, status: SubscriptionEntryStatus): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.set(key, { ...entry, entryStatus: status, updatedAtMs: this.#now() });
  }

  #setEntryError(key: string, error: SubscriptionEntryError): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.set(key, { ...entry, lastError: error, updatedAtMs: this.#now() });
  }

  /** True once the subscription deadline has passed while at least one CURRENTLY DESIRED entry is
   * still not satisfied (anything other than "active"/"removed" — pending, still creating, blocked
   * on auth/scope, suppressed by a recent revocation, or outright failed). A purely diagnostic
   * signal ("desired eventをwelcome期限内に購読できる" acceptance criterion) — this reconciler
   * never acts on it itself; only eventsub-session.ts's own welcome/keepalive timers own the
   * WebSocket connection's actual lifecycle.
   *
   * Deliberately scoped to `desiredKeys` rather than every key in `#entries`: a key that failed to
   * create and was LATER dropped from the desired set (e.g. its feature got disabled before the
   * failed create could ever be cleaned up — it never reaches Helix, so it never shows up in
   * diff.extra's delete housekeeping either) stays in `#entries` indefinitely with a stale
   * non-"active" status; without this scoping it would wrongly keep flagging deadlineMissed even
   * after everything CURRENTLY desired is satisfied. */
  #computeDeadlineMissed(nowMs: number, desiredKeys: ReadonlySet<string>): boolean {
    if (this.#subscriptionDeadlineAtMs === null || nowMs <= this.#subscriptionDeadlineAtMs) return false;
    for (const key of desiredKeys) {
      const entry = this.#entries.get(key);
      if (entry && entry.entryStatus !== "active" && entry.entryStatus !== "removed") return true;
    }
    return false;
  }

  #emitSnapshot(): void {
    this.#onSnapshotChange(this.snapshot);
  }

  #now(): number {
    return this.#clock.now();
  }
}
