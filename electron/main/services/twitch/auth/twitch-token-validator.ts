// Issue #84: classifies a single `TwitchOAuthClient.validate()` call into exactly what twitch-
// token-provider.ts needs to decide what to do next — a pure(ish) function, no state of its own,
// so it can be unit-tested directly against a mock TwitchOAuthClient-shaped object without
// standing up the whole provider.
import type { TwitchOAuthClient } from "./twitch-oauth-client";

export type TokenValidationOutcome =
  | { status: "valid"; account: { userId: string; login: string }; clientId: string; scopes: string[]; expiresAt: string }
  /** Twitch itself rejected the token (401 invalid_token) — dead/revoked/expired. */
  | { status: "invalid" }
  /** The token validates, but belongs to a different Twitch application than configured —
   * refreshing it would be pointless (a refresh_token is also scoped to one client_id) and
   * continuing to use it would mean this app is silently acting as a different registered app. */
  | { status: "client_mismatch"; observedClientId: string }
  /** The token validates and belongs to the right app, but to a *different* Twitch account than
   * the one this app previously established (see auth-metadata-repository.ts's `account`) — never
   * expected in normal operation, but treated as a hard stop rather than silently continuing under
   * a different identity. */
  | { status: "user_mismatch"; observedUserId: string }
  /** Could not get a definitive answer (network blip, Twitch 5xx/429) — the caller must leave
   * whatever trust state it already had alone; this is not evidence the token is bad. */
  | { status: "transient"; message: string };

export async function validateTwitchToken(
  oauthClient: Pick<TwitchOAuthClient, "validate">,
  params: { accessToken: string; expectedClientId: string; expectedUserId: string | null; now: () => number },
  signal?: AbortSignal,
): Promise<TokenValidationOutcome> {
  const result = await oauthClient.validate(params.accessToken, signal);
  if (!result.ok) {
    if (result.errorCode === "invalid_token") return { status: "invalid" };
    return { status: "transient", message: result.message };
  }
  if (result.result.clientId !== params.expectedClientId) return { status: "client_mismatch", observedClientId: result.result.clientId };
  if (params.expectedUserId && result.result.userId !== params.expectedUserId) return { status: "user_mismatch", observedUserId: result.result.userId };

  const expiresAt = new Date(params.now() + Math.max(0, result.result.expiresInSeconds) * 1000).toISOString();
  return { status: "valid", account: { userId: result.result.userId, login: result.result.login }, clientId: result.result.clientId, scopes: result.result.scopes, expiresAt };
}
