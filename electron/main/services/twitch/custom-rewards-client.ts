// Issue #95: thin Helix client for `GET /helix/channel_points/custom_rewards` ("Get Custom
// Rewards", https://dev.twitch.tv/docs/api/reference/#get-custom-reward) — populates the Event Rule
// editor's reward selector (src/twitch-ui/rules/reward-selector.js) with the broadcaster's real
// Channel Points reward list, keyed by Twitch's own stable reward `id` (never the mutable `title` —
// "reward title変更後もID参照が維持される" is this issue's own acceptance criterion). Mirrors
// twitch-account-service.ts's / eventsub-subscription-client.ts's Helix conventions exactly:
// `Authorization: Bearer <token>` plus a mandatory `Client-Id` header (never validate's `OAuth
// <token>` scheme), an injectable fetchImpl/baseUrl so tests point this at a local http.Server
// fixture, and an `ok:false` result (never a throw) for every ordinary failure — only cancellation
// propagates as a thrown ServiceError.
//
// BROADCASTER-ONLY CONSTRAINT (this issue's own explicit note): Twitch requires `channel:read:
// redemptions` (or `channel:manage:redemptions`) scope AND requires `broadcaster_id` to equal the
// token's own user id — Get Custom Rewards simply does not work for a different channel's rewards,
// even with an otherwise-valid token for some OTHER purpose. Twitch does not give this its own HTTP
// status: both "missing scope" and "wrong broadcaster_id" come back as a bare 401 with only the
// `message` body text distinguishing them (respectively "Missing scope: ..." and "The ID in
// broadcaster_id must match the user ID found in the request's OAuth token."). classifyUnauthorized()
// below does a best-effort text match on that message so the UI can show a specific, actionable error
// rather than one generic "unauthorized" for every 401 — but this app's own broadcaster-mismatch hard
// stop (twitch-auth-coordinator.ts) already prevents the wrong-broadcaster case from being reachable
// in ordinary operation, so `unauthorized` (the message didn't match either known shape) is the
// expected fallback for any OTHER 401 cause (e.g. a token Twitch revoked out-of-band).
import { ServiceError } from "../service-error";

const SERVICE_ID = "twitch:rewards:custom";
export const DEFAULT_TWITCH_HELIX_BASE_URL = "https://api.twitch.tv";
const CUSTOM_REWARDS_PATH = "/helix/channel_points/custom_rewards";

export type TwitchCustomReward = { id: string; title: string; cost: number; isEnabled: boolean; isPaused: boolean };

export type TwitchCustomRewardsClientErrorCode = "unauthorized" | "missing_scope" | "wrong_broadcaster" | "rate_limited" | "network" | "server" | "unknown";

export type ListCustomRewardsParams = { accessToken: string; clientId: string; broadcasterUserId: string };

export type ListCustomRewardsResult =
  | { ok: true; rewards: TwitchCustomReward[] }
  | { ok: false; errorCode: TwitchCustomRewardsClientErrorCode; status?: number; retryAfterMs?: number; message: string };

export type TwitchCustomRewardsClientDeps = { fetchImpl?: typeof fetch; baseUrl?: string };

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

/** Best-effort classification of a bare-401 Get Custom Rewards response — see this file's own doc
 * comment for why Twitch does not give "missing scope" and "wrong broadcaster" distinct HTTP
 * statuses here. Exported standalone for direct unit testing against real Twitch-documented message
 * text, without needing a full HTTP round trip. */
export function classifyUnauthorized(message: string): "missing_scope" | "wrong_broadcaster" | "unauthorized" {
  const lower = (message ?? "").toLowerCase();
  if (lower.includes("scope")) return "missing_scope";
  if (lower.includes("broadcaster_id") || lower.includes("broadcaster id")) return "wrong_broadcaster";
  return "unauthorized";
}

/** Parses one Helix custom-reward record into this app's own, deliberately minimal
 * `TwitchCustomReward` shape — only the fields the reward selector actually needs (id/title/cost/
 * enabled/paused). Twitch's real payload carries many more fields (image URLs, prompt text,
 * per-stream limits, …) this app has no UI for yet; dropping them here (rather than passing the raw
 * record through) keeps the Renderer-facing contract closed and easy to audit, matching this repo's
 * established "safe projection" stance for every other Helix-backed overview. Returns `null` for a
 * malformed record (missing id/title) rather than throwing — one bad entry must never fail the whole
 * list. */
export function parseRewardRecord(value: unknown): TwitchCustomReward | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.title !== "string") return null;
  return {
    id: record.id,
    title: record.title,
    cost: typeof record.cost === "number" && Number.isFinite(record.cost) ? record.cost : 0,
    isEnabled: record.is_enabled !== false,
    isPaused: record.is_paused === true,
  };
}

function classifyErrorCode(status: number, message: string): TwitchCustomRewardsClientErrorCode {
  if (status === 401) return classifyUnauthorized(message);
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "unknown";
}

export class TwitchCustomRewardsClient {
  #fetch: typeof fetch;
  #baseUrl: string;

  constructor(deps: TwitchCustomRewardsClientDeps = {}) {
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#baseUrl = deps.baseUrl ?? DEFAULT_TWITCH_HELIX_BASE_URL;
  }

  /** GET /helix/channel_points/custom_rewards?broadcaster_id=... — "only_manageable_rewards" is
   * deliberately left at Twitch's own default (false: return every reward, not just ones this app's
   * client_id created) since the condition builder needs to reference ANY of the broadcaster's
   * rewards, not only ones dociai itself manages. Never throws for an ordinary HTTP/transport
   * failure — only cancellation does, matching every other Helix client in this app. */
  async list(params: ListCustomRewardsParams, signal?: AbortSignal): Promise<ListCustomRewardsResult> {
    let response: Response;
    try {
      const query = new URLSearchParams({ broadcaster_id: params.broadcasterUserId });
      response = await this.#fetch(`${this.#baseUrl}${CUSTOM_REWARDS_PATH}?${query.toString()}`, {
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
      const data = Array.isArray(json.data) ? json.data : [];
      const rewards: TwitchCustomReward[] = [];
      for (const entry of data) {
        const parsed = parseRewardRecord(entry);
        if (parsed) rewards.push(parsed);
      }
      return { ok: true, rewards };
    }
    const message = typeof json?.message === "string" ? json.message : `custom rewards request returned HTTP ${response.status}`;
    return { ok: false, errorCode: classifyErrorCode(response.status, message), status: response.status, retryAfterMs, message };
  }
}
