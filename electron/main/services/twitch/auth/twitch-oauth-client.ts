// Thin HTTP client for Twitch's public-client Device Code Grant endpoints (id.twitch.tv). This
// file only ever knows how to make the documented calls and shape their responses/errors — it
// never persists anything and never runs a poll/retry loop itself (see device-code-flow.ts for
// the device-code state machine, and issue #84's twitch-token-validator.ts/twitch-token-
// refresher.ts for the validate/refresh orchestration built on top of validate()/refresh() below).
//
// `fetchImpl`/`baseUrl` are injectable (same pattern as ai-service.ts, speech-backend-service.ts,
// rss-client.ts) so tests point this at a local `http.Server` fixture instead of ever reaching
// real Twitch infrastructure.
import { ServiceError, errorFromHttpStatus } from "../../service-error";

const SERVICE_ID = "twitch:auth";
export const DEFAULT_TWITCH_ID_BASE_URL = "https://id.twitch.tv";
const DEVICE_ENDPOINT_PATH = "/oauth2/device";
const TOKEN_ENDPOINT_PATH = "/oauth2/token";
const VALIDATE_ENDPOINT_PATH = "/oauth2/validate";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_TOKEN_GRANT_TYPE = "refresh_token";

export type DeviceCodeRequest = { clientId: string; scopes: string[] };
export type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type DeviceTokenSuccess = { accessToken: string; refreshToken: string; scope: string[]; tokenType: string };

/** `authorization_pending`/`slow_down`/`expired_token`/`access_denied` are RFC 8628's documented
 * device-flow error codes (Twitch's token endpoint returns these in a JSON body regardless of
 * HTTP status). `rate_limited`/`network`/`server`/`unknown` are this client's own classification
 * for everything else (a bare 429 with no recognizable body, a 5xx, a transport failure, or an
 * unparseable response) — device-code-flow.ts treats those as transient and retries a bounded
 * number of times rather than failing the whole auth attempt on the first hiccup. */
export type DeviceTokenPollErrorCode = "authorization_pending" | "slow_down" | "expired_token" | "access_denied" | "rate_limited" | "network" | "server" | "unknown";

export type DeviceTokenPollResult =
  | { ok: true; token: DeviceTokenSuccess }
  | { ok: false; errorCode: DeviceTokenPollErrorCode; status?: number; retryAfterMs?: number; message: string };

export type TwitchOAuthClientDeps = { fetchImpl?: typeof fetch; baseUrl?: string };

/** Twitch's documented `GET /oauth2/validate` success shape (id.twitch.tv, `Authorization: OAuth
 * <token>`): https://dev.twitch.tv/docs/authentication/validate-tokens/. */
export type ValidateSuccess = { clientId: string; login: string; userId: string; scopes: string[]; expiresInSeconds: number };

/** `invalid_token` is Twitch's documented 401 for validate (a dead/revoked/malformed token).
 * `rate_limited`/`network`/`server`/`unknown` mirror DeviceTokenPollErrorCode's own transient
 * classification — issue #84's twitch-token-validator.ts treats those as "couldn't confirm right
 * now" (leave current trust state alone), never as proof the token itself is bad. */
export type TokenValidationErrorCode = "invalid_token" | "rate_limited" | "network" | "server" | "unknown";

export type TokenValidationResult =
  | { ok: true; result: ValidateSuccess }
  | { ok: false; errorCode: TokenValidationErrorCode; status?: number; retryAfterMs?: number; message: string };

export type RefreshTokenSuccess = { accessToken: string; refreshToken: string; scope: string[]; tokenType: string };

/** `invalid_grant` covers every shape Twitch uses to say "this refresh_token no longer works":
 * the RFC 6749 `{ error: "invalid_grant" }` body, and Twitch's own plainer `{ status: 400,
 * message: "Invalid refresh token" }` shape (no recognizable transient cause) — both are treated
 * identically by twitch-token-refresher.ts as a terminal, non-retryable failure that must lead to
 * `reauth_required`, never a retry. `rate_limited`/`network`/`server`/`unknown` are transient and
 * bounded-retried instead (see retry-policy.ts usage in twitch-token-refresher.ts). */
export type TokenRefreshErrorCode = "invalid_grant" | "rate_limited" | "network" | "server" | "unknown";

export type TokenRefreshResult =
  | { ok: true; token: RefreshTokenSuccess }
  | { ok: false; errorCode: TokenRefreshErrorCode; status?: number; retryAfterMs?: number; message: string };

const DEVICE_FLOW_ERROR_CODES = new Set<DeviceTokenPollErrorCode>(["authorization_pending", "slow_down", "expired_token", "access_denied"]);

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

export class TwitchOAuthClient {
  #fetch: typeof fetch;
  #baseUrl: string;

  constructor(deps: TwitchOAuthClientDeps = {}) {
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#baseUrl = deps.baseUrl ?? DEFAULT_TWITCH_ID_BASE_URL;
  }

  async requestDeviceCode(request: DeviceCodeRequest, signal?: AbortSignal): Promise<DeviceCodeResponse> {
    const body = new URLSearchParams({ client_id: request.clientId, scopes: request.scopes.join(" ") });
    const response = await this.#post(DEVICE_ENDPOINT_PATH, body, signal);
    if (!response.ok) {
      const json = await safeJson(response);
      const message = typeof json?.message === "string" ? json.message : `device endpoint returned HTTP ${response.status}`;
      throw errorFromHttpStatus(response.status, { serviceId: SERVICE_ID, message });
    }
    const json = await safeJson(response);
    if (!json || typeof json.device_code !== "string" || typeof json.user_code !== "string" || typeof json.verification_uri !== "string" || typeof json.expires_in !== "number" || typeof json.interval !== "number") {
      throw new ServiceError("SERVER", "device endpoint response is missing required fields", { serviceId: SERVICE_ID, retryable: false });
    }
    return { deviceCode: json.device_code, userCode: json.user_code, verificationUri: json.verification_uri, expiresInSeconds: json.expires_in, intervalSeconds: json.interval };
  }

  async pollToken(request: { clientId: string; deviceCode: string }, signal?: AbortSignal): Promise<DeviceTokenPollResult> {
    const body = new URLSearchParams({ client_id: request.clientId, device_code: request.deviceCode, grant_type: DEVICE_CODE_GRANT_TYPE });
    let response: Response;
    try {
      response = await this.#post(TOKEN_ENDPOINT_PATH, body, signal);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "CANCELLED") throw error;
      return { ok: false, errorCode: "network", message: error instanceof Error ? error.message : "network error" };
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const json = await safeJson(response);

    if (response.ok && json && typeof json.access_token === "string" && typeof json.refresh_token === "string") {
      const scope = Array.isArray(json.scope)
        ? json.scope.filter((value): value is string => typeof value === "string")
        : typeof json.scope === "string"
          ? json.scope.split(" ").filter(Boolean)
          : [];
      return { ok: true, token: { accessToken: json.access_token, refreshToken: json.refresh_token, scope, tokenType: typeof json.token_type === "string" ? json.token_type : "bearer" } };
    }

    // Twitch/RFC 8628 report the poll outcome via a JSON body error code, not solely via HTTP
    // status (authorization_pending/expired_token/access_denied are commonly a 400) — so the body
    // is authoritative whenever it parses to one of the four documented codes, regardless of
    // status. Only fall back to status-based classification when the body doesn't say.
    const bodyErrorCode = typeof json?.error === "string" ? json.error : typeof json?.message === "string" ? json.message : undefined;
    if (bodyErrorCode && DEVICE_FLOW_ERROR_CODES.has(bodyErrorCode as DeviceTokenPollErrorCode)) {
      return { ok: false, errorCode: bodyErrorCode as DeviceTokenPollErrorCode, status: response.status, retryAfterMs, message: bodyErrorCode };
    }
    if (response.status === 429) return { ok: false, errorCode: "rate_limited", status: response.status, retryAfterMs, message: "rate limited" };
    if (response.status >= 500) return { ok: false, errorCode: "server", status: response.status, retryAfterMs, message: `token endpoint returned HTTP ${response.status}` };
    return { ok: false, errorCode: "unknown", status: response.status, retryAfterMs, message: `unexpected token response (HTTP ${response.status})` };
  }

  /** Issue #84: confirms an access token is still live and belongs to this app/user, per Twitch's
   * documented `GET /oauth2/validate`. Never throws for an ordinary "token is bad" outcome (401)
   * or a transient hiccup — those are `ok: false` results for the caller (twitch-token-
   * validator.ts) to classify; only cancellation propagates as a thrown ServiceError, matching
   * pollToken's convention above. */
  async validate(accessToken: string, signal?: AbortSignal): Promise<TokenValidationResult> {
    let response: Response;
    try {
      response = await this.#get(VALIDATE_ENDPOINT_PATH, accessToken, signal);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "CANCELLED") throw error;
      return { ok: false, errorCode: "network", message: error instanceof Error ? error.message : "network error" };
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const json = await safeJson(response);

    if (response.ok && json && typeof json.client_id === "string" && typeof json.user_id === "string" && typeof json.login === "string") {
      const scopes = Array.isArray(json.scopes) ? json.scopes.filter((value): value is string => typeof value === "string") : [];
      const expiresInSeconds = typeof json.expires_in === "number" ? json.expires_in : 0;
      return { ok: true, result: { clientId: json.client_id, login: json.login, userId: json.user_id, scopes, expiresInSeconds } };
    }
    if (response.status === 401) return { ok: false, errorCode: "invalid_token", status: 401, message: typeof json?.message === "string" ? json.message : "invalid access token" };
    if (response.status === 429) return { ok: false, errorCode: "rate_limited", status: response.status, retryAfterMs, message: "rate limited" };
    if (response.status >= 500) return { ok: false, errorCode: "server", status: response.status, retryAfterMs, message: `validate endpoint returned HTTP ${response.status}` };
    return { ok: false, errorCode: "unknown", status: response.status, retryAfterMs, message: `unexpected validate response (HTTP ${response.status})` };
  }

  /** Issue #84: exchanges a refresh_token for a new access_token, per Twitch's documented `POST
   * /oauth2/token` with `grant_type=refresh_token`. Twitch always rotates the refresh_token on a
   * successful call — the caller (twitch-token-refresher.ts/twitch-token-provider.ts) MUST persist
   * `token.refreshToken` in place of the old one; this client never does so itself. */
  async refresh(request: { clientId: string; refreshToken: string }, signal?: AbortSignal): Promise<TokenRefreshResult> {
    const body = new URLSearchParams({ grant_type: REFRESH_TOKEN_GRANT_TYPE, refresh_token: request.refreshToken, client_id: request.clientId });
    let response: Response;
    try {
      response = await this.#post(TOKEN_ENDPOINT_PATH, body, signal);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "CANCELLED") throw error;
      return { ok: false, errorCode: "network", message: error instanceof Error ? error.message : "network error" };
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const json = await safeJson(response);

    if (response.ok && json && typeof json.access_token === "string" && typeof json.refresh_token === "string") {
      const scope = Array.isArray(json.scope)
        ? json.scope.filter((value): value is string => typeof value === "string")
        : typeof json.scope === "string"
          ? json.scope.split(" ").filter(Boolean)
          : [];
      return { ok: true, token: { accessToken: json.access_token, refreshToken: json.refresh_token, scope, tokenType: typeof json.token_type === "string" ? json.token_type : "bearer" } };
    }

    // Body-authoritative first (RFC 6749's `{ error: "invalid_grant" }`), same precedence as
    // pollToken above. Twitch's own refresh-endpoint error responses often omit an `error` field
    // entirely (just `{ status: 400, message: "Invalid refresh token" }`) — a bare 400/401 with no
    // recognizable transient shape is therefore ALSO classified as invalid_grant rather than
    // "unknown", since every documented non-transient refresh failure Twitch returns is a 400/401
    // meaning the refresh_token itself is dead (expired, revoked, already-rotated, wrong client).
    const bodyErrorCode = typeof json?.error === "string" ? json.error : undefined;
    if (bodyErrorCode === "invalid_grant") return { ok: false, errorCode: "invalid_grant", status: response.status, message: typeof json?.error_description === "string" ? json.error_description : bodyErrorCode };
    if (response.status === 400 || response.status === 401) return { ok: false, errorCode: "invalid_grant", status: response.status, message: typeof json?.message === "string" ? json.message : `refresh rejected (HTTP ${response.status})` };
    if (response.status === 429) return { ok: false, errorCode: "rate_limited", status: response.status, retryAfterMs, message: "rate limited" };
    if (response.status >= 500) return { ok: false, errorCode: "server", status: response.status, retryAfterMs, message: `token endpoint returned HTTP ${response.status}` };
    return { ok: false, errorCode: "unknown", status: response.status, retryAfterMs, message: `unexpected refresh response (HTTP ${response.status})` };
  }

  async #get(path: string, accessToken: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `OAuth ${accessToken}`, Accept: "application/json" },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false });
      throw new ServiceError("NETWORK", error instanceof Error ? error.message : "network request failed", { serviceId: SERVICE_ID, retryable: true });
    }
  }

  async #post(path: string, body: URLSearchParams, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false });
      throw new ServiceError("NETWORK", error instanceof Error ? error.message : "network request failed", { serviceId: SERVICE_ID, retryable: true });
    }
  }
}
