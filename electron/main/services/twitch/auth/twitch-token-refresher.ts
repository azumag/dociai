// Issue #84: runs one refresh attempt against `TwitchOAuthClient.refresh()`, retrying ONLY the
// documented transient cases (network blips / Twitch 5xx / 429) via #68's retry-policy.ts, and
// classifying every other outcome for twitch-token-provider.ts to act on. A dead refresh_token
// (`invalid_grant`-shaped, see twitch-oauth-client.ts's refresh() doc comment) is never retried —
// retrying a refresh_token Twitch has already rejected cannot succeed and would just delay
// reaching `reauth_required`, the terminal state the caller needs to surface to the user.
import { ServiceError, normalizeServiceError } from "../../service-error";
import { retryWithPolicy } from "../../retry-policy";
import type { RetryPolicy } from "../../retry-policy";
import type { RequestContext } from "../../../../shared/services/service-contract";
import type { RefreshTokenSuccess, TwitchOAuthClient } from "./twitch-oauth-client";

const SERVICE_ID = "twitch:auth:token";

/** #68's retry-policy.ts default: 3 attempts, short bounded backoff — a refresh is on the
 * critical path of every Twitch-dependent service's next call, so it should fail fast into
 * `transient_failure` rather than stall the app for long. */
export const DEFAULT_REFRESH_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4_000, jitterRatio: 0.2 };

export type TokenRefreshOutcome =
  | { status: "refreshed"; token: RefreshTokenSuccess }
  /** Terminal: the refresh_token itself is dead (invalid_grant-shaped) — no amount of retrying
   * helps; the caller must transition to reauth_required. */
  | { status: "reauth_required"; message: string }
  /** Non-terminal: transient retries (network/5xx/429) were exhausted for this one attempt — the
   * caller may leave the current token/status alone and try again later (next reactive 401, next
   * hourly validate, ...). */
  | { status: "transient_failure"; message: string };

export type RefreshTwitchTokenOptions = {
  signal: AbortSignal;
  requestContext: RequestContext;
  retryPolicy?: RetryPolicy;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export async function refreshTwitchToken(
  oauthClient: Pick<TwitchOAuthClient, "refresh">,
  params: { clientId: string; refreshToken: string },
  options: RefreshTwitchTokenOptions,
): Promise<TokenRefreshOutcome> {
  const policy = options.retryPolicy ?? DEFAULT_REFRESH_RETRY_POLICY;
  try {
    const token = await retryWithPolicy<RefreshTokenSuccess>(
      async () => {
        const result = await oauthClient.refresh(params, options.signal);
        if (result.ok) return result.token;
        if (result.errorCode === "invalid_grant") throw new ServiceError("AUTH", result.message, { serviceId: SERVICE_ID, retryable: false, status: result.status });
        const code = result.errorCode === "rate_limited" ? "RATE_LIMIT" : result.errorCode === "network" ? "NETWORK" : result.errorCode === "server" ? "SERVER" : "UNKNOWN";
        throw new ServiceError(code, result.message, { serviceId: SERVICE_ID, retryable: code !== "UNKNOWN", ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}) });
      },
      policy,
      options.requestContext,
      options.sleep ? { sleep: options.sleep } : {},
    );
    return { status: "refreshed", token };
  } catch (error) {
    const normalized = normalizeServiceError(error, { serviceId: SERVICE_ID, signal: options.signal });
    // Cancellation (app quit / provider disposed mid-refresh) is not a refresh *outcome* — it is
    // the caller's own teardown in progress, so it must propagate as a throw rather than be
    // reported as reauth_required or a transient failure (either of which the caller would act on).
    if (normalized.code === "CANCELLED") throw normalized;
    if (normalized.code === "AUTH") return { status: "reauth_required", message: normalized.message };
    return { status: "transient_failure", message: normalized.message };
  }
}
