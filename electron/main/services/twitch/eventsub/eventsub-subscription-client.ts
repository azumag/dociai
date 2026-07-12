// Issue #87: thin Helix client for the 3 EventSub subscription-management endpoints this issue
// needs — POST/GET/DELETE /helix/eventsub/subscriptions (Twitch's documented Create/Get/Delete
// EventSub Subscription endpoints, https://dev.twitch.tv/docs/api/reference/). Mirrors twitch-
// account-service.ts's Helix conventions exactly (issue #85): `Authorization: Bearer <token>` plus
// a mandatory `Client-Id` header (never validate's `OAuth <token>` scheme), an injectable
// fetchImpl/baseUrl so tests point this at a local http.Server fixture, and an `ok:false` result
// (never a throw) for every ordinary failure — only cancellation propagates as a thrown
// ServiceError.
//
// WebSocket transport subscriptions REQUIRE a user access token (an app access token is rejected
// by Twitch for `transport.method: "websocket"` — issue #87's own note). This client itself does
// not enforce that; it only sends whatever token the caller hands it. subscription-reconciler.ts
// is the one that always calls TwitchTokenProvider.getValidAccessToken(), which only ever holds
// user tokens obtained via the Device Code Grant (see twitch-token-provider.ts's whole lineage) —
// there is no app-access-token code path anywhere in this app for the reconciler to accidentally
// reach for instead.
import { ServiceError } from "../../service-error";
import type { ActualSubscription, SubscriptionCondition } from "./subscription-registry";

const SERVICE_ID = "twitch:eventsub:subscriptions";
export const DEFAULT_TWITCH_HELIX_BASE_URL = "https://api.twitch.tv";
const SUBSCRIPTIONS_PATH = "/helix/eventsub/subscriptions";

/** Twitch's Helix error-code taxonomy for subscription create/list/delete, kept closer to the raw
 * HTTP status than twitch-account-service.ts's own classification (`unauthorized` there covers
 * both 401 and 403) because subscription-reconciler.ts needs to tell "the token itself is bad"
 * (401 — a fresh getValidAccessToken()/reauth might fix it) apart from "the token is fine but
 * missing a scope" (403 — only a scope-upgrade Device Code Grant can fix it, see issue #85's
 * checkScopesForFeatures()/startScopeUpgrade()). `conflict` (409) is its own case: NOT a failure to
 * surface to a human, just a signal to go re-read the actual list (see subscription-reconciler.ts's
 * duplicate-reconciliation handling). */
export type EventSubSubscriptionErrorCode = "unauthorized" | "forbidden" | "conflict" | "rate_limited" | "network" | "server" | "unknown";

export type CreateSubscriptionParams = {
  accessToken: string;
  clientId: string;
  type: string;
  version: string;
  condition: SubscriptionCondition;
  /** "WebSocket session IDをtransportへ設定" (issue #87's TODO) — the EventSubSession.id this
   * subscription's notifications should be delivered to (see eventsub-session.ts). */
  sessionId: string;
};

export type CreateSubscriptionResult =
  | { ok: true; subscription: ActualSubscription }
  | { ok: false; errorCode: EventSubSubscriptionErrorCode; status?: number; retryAfterMs?: number; message: string };

export type ListSubscriptionsParams = { accessToken: string; clientId: string; type?: string; status?: string };

export type ListSubscriptionsResult =
  | { ok: true; subscriptions: ActualSubscription[] }
  | { ok: false; errorCode: EventSubSubscriptionErrorCode; status?: number; retryAfterMs?: number; message: string };

export type DeleteSubscriptionParams = { accessToken: string; clientId: string; id: string };

export type DeleteSubscriptionResult = { ok: true } | { ok: false; errorCode: EventSubSubscriptionErrorCode; status?: number; message: string };

/** Hard safety bound on list() pagination — Twitch's own `after` cursor could in principle loop
 * forever against a misbehaving mock/proxy; a real broadcaster's subscription count for this app's
 * 5 types is always tiny (at most 5), so this is enormous headroom, never a realistic ceiling. */
const MAX_LIST_PAGES = 50;

export type EventSubSubscriptionClientDeps = { fetchImpl?: typeof fetch; baseUrl?: string };

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const parsed = Date.parse(header);
  return Number.isNaN(parsed) ? undefined : Math.max(0, parsed - Date.now());
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function classifyErrorCode(status: number): EventSubSubscriptionErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "unknown";
}

function parseConditionRecord(value: unknown): SubscriptionCondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const condition: Record<string, string> = {};
  for (const [conditionKey, conditionValue] of Object.entries(value as Record<string, unknown>)) if (typeof conditionValue === "string") condition[conditionKey] = conditionValue;
  return condition;
}

function parseSubscriptionRecord(value: unknown): ActualSubscription | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.type !== "string" || typeof record.version !== "string" || typeof record.status !== "string") return null;
  return { id: record.id, type: record.type, version: record.version, status: record.status, condition: parseConditionRecord(record.condition) };
}

export class EventSubSubscriptionClient {
  #fetch: typeof fetch;
  #baseUrl: string;

  constructor(deps: EventSubSubscriptionClientDeps = {}) {
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#baseUrl = deps.baseUrl ?? DEFAULT_TWITCH_HELIX_BASE_URL;
  }

  /** POST /helix/eventsub/subscriptions. 202 is Twitch's documented success status for a
   * subscription create (never 200/201); everything else is classified per classifyErrorCode()
   * above. Never throws for an ordinary HTTP/transport failure — only cancellation does. */
  async create(params: CreateSubscriptionParams, signal?: AbortSignal): Promise<CreateSubscriptionResult> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${SUBSCRIPTIONS_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${params.accessToken}`, "Client-Id": params.clientId, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ type: params.type, version: params.version, condition: params.condition, transport: { method: "websocket", session_id: params.sessionId } }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false });
      return { ok: false, errorCode: "network", message: error instanceof Error ? error.message : "network error" };
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const json = await safeJson(response);

    if (response.status === 202 && json) {
      const first = Array.isArray(json.data) ? parseSubscriptionRecord(json.data[0]) : null;
      if (first) return { ok: true, subscription: first };
      return { ok: false, errorCode: "unknown", status: response.status, message: "create response did not include the created subscription" };
    }
    return { ok: false, errorCode: classifyErrorCode(response.status), status: response.status, retryAfterMs, message: typeof json?.message === "string" ? json.message : `create subscription returned HTTP ${response.status}` };
  }

  /** GET /helix/eventsub/subscriptions, paginated via `after` — "actual listを取得してdesiredと
   * 照合" (issue #87). Fetches every page up to MAX_LIST_PAGES. A failure partway through a
   * multi-page fetch reports the failure for the WHOLE call (partial results are never silently
   * treated as complete — a caller reconciling against an incomplete actual list could wrongly
   * conclude a still-existing subscription is missing and attempt a doomed create). */
  async list(params: ListSubscriptionsParams, signal?: AbortSignal): Promise<ListSubscriptionsResult> {
    const subscriptions: ActualSubscription[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const query = new URLSearchParams();
      if (params.type) query.set("type", params.type);
      if (params.status) query.set("status", params.status);
      if (after) query.set("after", after);
      const queryString = query.toString();

      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${SUBSCRIPTIONS_PATH}${queryString ? `?${queryString}` : ""}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${params.accessToken}`, "Client-Id": params.clientId, Accept: "application/json" },
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false });
        return { ok: false, errorCode: "network", message: error instanceof Error ? error.message : "network error" };
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const json = await safeJson(response);
      if (!response.ok || !json) return { ok: false, errorCode: classifyErrorCode(response.status), status: response.status, retryAfterMs, message: typeof json?.message === "string" ? json.message : `list subscriptions returned HTTP ${response.status}` };

      const data = Array.isArray(json.data) ? json.data : [];
      for (const entry of data) {
        const parsed = parseSubscriptionRecord(entry);
        if (parsed) subscriptions.push(parsed);
      }
      const pagination = json.pagination && typeof json.pagination === "object" ? (json.pagination as Record<string, unknown>) : null;
      const cursor = pagination && typeof pagination.cursor === "string" ? pagination.cursor : undefined;
      if (!cursor) return { ok: true, subscriptions };
      after = cursor;
    }
    // Exhausted MAX_LIST_PAGES with a cursor still pending — per this method's own doc comment, a
    // partial result must never be silently treated as complete (a caller reconciling against a
    // truncated actual list could wrongly conclude a still-existing subscription is missing and
    // attempt a doomed create). This app's real subscription count is always tiny (at most 5), so
    // reaching this bound only happens against a misbehaving/malicious server — never real Twitch.
    return { ok: false, errorCode: "unknown", message: `list subscriptions did not terminate within ${MAX_LIST_PAGES} pages; refusing to report a truncated result as complete` };
  }

  /** DELETE /helix/eventsub/subscriptions?id=... — the reconciler's own housekeeping for a
   * subscription the current desired set no longer wants (e.g. a feature was just disabled). Never
   * called in reaction to a server-sent `revocation` message — Twitch has already torn those down
   * itself by the time that message arrives (see revocation-handler.ts). Best-effort: a 404
   * (already gone) is treated as success, matching twitch-revoke-client.ts's own best-effort
   * stance for a similarly "it's fine if it's already gone" cleanup call. */
  async delete(params: DeleteSubscriptionParams, signal?: AbortSignal): Promise<DeleteSubscriptionResult> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${SUBSCRIPTIONS_PATH}?id=${encodeURIComponent(params.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${params.accessToken}`, "Client-Id": params.clientId, Accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false });
      return { ok: false, errorCode: "network", message: error instanceof Error ? error.message : "network error" };
    }
    if (response.status === 204 || response.status === 404) return { ok: true };
    const json = await safeJson(response);
    return { ok: false, errorCode: classifyErrorCode(response.status), status: response.status, message: typeof json?.message === "string" ? json.message : `delete subscription returned HTTP ${response.status}` };
  }
}
