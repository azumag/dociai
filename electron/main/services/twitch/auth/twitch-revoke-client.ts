// Issue #85: POST https://id.twitch.tv/oauth2/revoke — Twitch's documented token revocation
// endpoint (https://dev.twitch.tv/docs/authentication/revoke-tokens/), `client_id` + `token` as
// form params, the same request shape as twitch-oauth-client.ts's other id.twitch.tv calls (whose
// DEFAULT_TWITCH_ID_BASE_URL this file reuses rather than redefining the same real endpoint as a
// second magic string).
//
// BEST EFFORT BY DESIGN: this client never throws for an ordinary failure (network blip, Twitch
// having already invalidated the token, a 4xx/5xx). It always resolves to an `{ ok: boolean }`-
// shaped result. twitch-auth-coordinator.ts's logout()/switchAccount() flows call this and MUST
// proceed to clear local secrets/state regardless of the result — issue #85 explicitly separates
// "revoke成否" from "local secret削除" (see twitch-auth-coordinator.ts's logout() doc comment).
// Only cancellation (the caller's own AbortSignal firing, e.g. app quit mid-logout) propagates as
// a throw, matching twitch-oauth-client.ts's convention.
import { ServiceError } from "../../service-error";
import { DEFAULT_TWITCH_ID_BASE_URL } from "./twitch-oauth-client";

const SERVICE_ID = "twitch:auth:revoke";
const REVOKE_ENDPOINT_PATH = "/oauth2/revoke";

export type RevokeResult = { ok: true } | { ok: false; status?: number; message: string };

export type TwitchRevokeClientDeps = { fetchImpl?: typeof fetch; baseUrl?: string };

export class TwitchRevokeClient {
  #fetch: typeof fetch;
  #baseUrl: string;

  constructor(deps: TwitchRevokeClientDeps = {}) {
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#baseUrl = deps.baseUrl ?? DEFAULT_TWITCH_ID_BASE_URL;
  }

  async revoke(params: { clientId: string; token: string }, signal?: AbortSignal): Promise<RevokeResult> {
    const body = new URLSearchParams({ client_id: params.clientId, token: params.token });
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${REVOKE_ENDPOINT_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new ServiceError("CANCELLED", "request cancelled", { serviceId: SERVICE_ID, retryable: false });
      return { ok: false, message: error instanceof Error ? error.message : "network error" };
    }
    if (response.ok) return { ok: true };
    let message = `revoke endpoint returned HTTP ${response.status}`;
    try {
      const json = await response.json();
      if (json && typeof json === "object" && typeof (json as Record<string, unknown>).message === "string") message = (json as Record<string, unknown>).message as string;
    } catch {
      // Unparseable body — the HTTP status alone is enough to report failure; this is still a
      // best-effort client, so there is nothing further to recover here.
    }
    return { ok: false, status: response.status, message };
  }
}
