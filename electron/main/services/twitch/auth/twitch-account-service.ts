// Issue #85: thin Helix client for the one endpoint this issue needs — `GET /helix/users` with no
// query params, which Twitch defines as "the user identified by the passed access token"
// (https://dev.twitch.tv/docs/api/reference/#get-users). Used to confirm which real Twitch account
// a Device Code Grant just authorized (see twitch-auth-coordinator.ts's broadcaster-mismatch hard
// stop below), and to surface a login/display name for a future accounts UI (#55).
//
// SCHEME WARNING: Helix (api.twitch.tv) is a different API family from the id.twitch.tv OAuth
// endpoints twitch-oauth-client.ts talks to, and uses a DIFFERENT Authorization scheme — `Bearer
// <token>`, not validate's `OAuth <token>` — plus a mandatory `Client-Id` header that id.twitch.tv
// never needs. Mixing these up is a common real-world mistake; get it wrong here and every Helix
// call this app makes (this one, and every future EventSub subscription-creation call) would 401.
// See twitch-account-service.test's header-assertion test for the standing check on this.
//
// `fetchImpl`/`baseUrl` are injectable (same pattern as twitch-oauth-client.ts/twitch-revoke-
// client.ts) so tests point this at a local `http.Server` fixture instead of ever reaching real
// Twitch infrastructure.
import { ServiceError } from "../../service-error";

const SERVICE_ID = "twitch:auth:account";
export const DEFAULT_TWITCH_HELIX_BASE_URL = "https://api.twitch.tv";
const USERS_ENDPOINT_PATH = "/helix/users";

export type TwitchAccountSummary = { userId: string; login: string; displayName: string };

/** `unauthorized` is Helix's 401 for a dead/revoked/malformed token or a missing/wrong Client-Id
 * header. `rate_limited`/`network`/`server`/`unknown` mirror twitch-oauth-client.ts's own
 * transient classification. */
export type TwitchAccountErrorCode = "unauthorized" | "rate_limited" | "network" | "server" | "unknown";

export type FetchAccountResult =
  | { ok: true; account: TwitchAccountSummary }
  | { ok: false; errorCode: TwitchAccountErrorCode; status?: number; retryAfterMs?: number; message: string };

export type TwitchAccountServiceDeps = { fetchImpl?: typeof fetch; baseUrl?: string };

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

export class TwitchAccountService {
  #fetch: typeof fetch;
  #baseUrl: string;

  constructor(deps: TwitchAccountServiceDeps = {}) {
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#baseUrl = deps.baseUrl ?? DEFAULT_TWITCH_HELIX_BASE_URL;
  }

  /** GET /helix/users, no query params — Twitch resolves this to "the token's own account".
   * Never throws for an ordinary failure (a 401/429/5xx or a transport error) — those are
   * `ok: false` results for the caller (twitch-auth-coordinator.ts) to classify; only cancellation
   * propagates as a thrown ServiceError, matching twitch-oauth-client.ts's convention. */
  async fetchAuthenticatedAccount(params: { accessToken: string; clientId: string }, signal?: AbortSignal): Promise<FetchAccountResult> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${USERS_ENDPOINT_PATH}`, {
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

    if (response.ok && json) {
      const first = Array.isArray(json.data) ? (json.data[0] as unknown) : undefined;
      if (first && typeof first === "object" && typeof (first as Record<string, unknown>).id === "string" && typeof (first as Record<string, unknown>).login === "string") {
        const record = first as Record<string, unknown>;
        const login = record.login as string;
        return { ok: true, account: { userId: record.id as string, login, displayName: typeof record.display_name === "string" ? record.display_name : login } };
      }
      return { ok: false, errorCode: "unknown", status: response.status, message: "helix /users response did not include an account" };
    }
    if (response.status === 401) return { ok: false, errorCode: "unauthorized", status: 401, message: typeof json?.message === "string" ? json.message : "unauthorized" };
    if (response.status === 429) return { ok: false, errorCode: "rate_limited", status: response.status, retryAfterMs, message: "rate limited" };
    if (response.status >= 500) return { ok: false, errorCode: "server", status: response.status, retryAfterMs, message: `helix /users returned HTTP ${response.status}` };
    return { ok: false, errorCode: "unknown", status: response.status, retryAfterMs, message: `unexpected helix /users response (HTTP ${response.status})` };
  }
}

/** Thrown/recorded by twitch-auth-coordinator.ts when the authorized account's user id does not
 * match the configured broadcaster id — issue #85's hard-stop condition ("認可user IDをbroadcaster
 * IDとして検証" / "broadcasterと認可accountの不一致を拒否する"). Never thrown by
 * fetchAuthenticatedAccount itself, which only ever reports what Helix said; the mismatch judgment
 * belongs to the caller, the only place that knows the expected broadcaster id. */
export class TwitchBroadcasterMismatchError extends Error {
  constructor(readonly expectedBroadcasterId: string, readonly observedUserId: string, readonly observedLogin: string) {
    super(`authorized Twitch account ${observedLogin} (${observedUserId}) does not match the configured broadcaster (${expectedBroadcasterId})`);
    this.name = "TwitchBroadcasterMismatchError";
  }
}

/** Pure assertion helper — throws TwitchBroadcasterMismatchError when `account` does not belong to
 * `expectedBroadcasterId`. A null/empty `expectedBroadcasterId` means "no broadcaster configured
 * yet" (first-ever login bootstrapping a fresh install) and is never a mismatch. */
export function assertBroadcasterMatch(account: TwitchAccountSummary, expectedBroadcasterId: string | null): void {
  if (!expectedBroadcasterId) return;
  if (account.userId !== expectedBroadcasterId) throw new TwitchBroadcasterMismatchError(expectedBroadcasterId, account.userId, account.login);
}
