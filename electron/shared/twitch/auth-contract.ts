// Renderer/IPC-facing contract for Twitch's Device Code Grant flow (#83, parent #51/#37).
//
// SAFETY INVARIANT: nothing in this file may ever carry `device_code`, `access_token`, or
// `refresh_token`. Those live only in Main-process memory (device_code, transiently, inside
// device-code-flow.ts) or are handed off internally to whatever consumes
// `DeviceCodeFlowDeps.onTokenObtained` (issue #84's SecretStore persistence) — never through this
// contract. `TwitchAuthPublicState` is exactly the shape that is safe to serialize across the
// IPC boundary to a Renderer; see device-code-flow.test assertions that check its keys.
import type { ServiceErrorCode } from "../services/service-errors";

export type TwitchAuthLifecycleState = "signed_out" | "starting" | "awaiting_user" | "exchanging" | "ready" | "error";

/** Reuses the shared ServiceErrorCode taxonomy and adds the two terminal reasons that are
 * specific to the device code grant's polling protocol (RFC 8628 / Twitch's id.twitch.tv):
 * `access_denied` (the user explicitly declined on Twitch's verification page) and
 * `expired_token` (the device_code's lifetime elapsed before authorization completed). */
export type TwitchAuthErrorCode = ServiceErrorCode | "ACCESS_DENIED" | "EXPIRED";

export type TwitchAuthErrorShape = { code: TwitchAuthErrorCode; message: string; retryable: boolean };

/** Everything a Renderer console/UI needs to show the auth flow's progress and let the user open
 * the verification page — and nothing more. */
export type TwitchAuthPublicState = {
  state: TwitchAuthLifecycleState;
  requestId: string | null;
  generation: number;
  scopes: string[];
  scopeFingerprint: string | null;
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: string | null;
  intervalSeconds: number | null;
  error: TwitchAuthErrorShape | null;
  updatedAt: string;
};

export type TwitchAuthStartInput = { scopes: string[] };

/** `requestId` is null only for the "reset to signed_out" event emitted after a cancel/config
 * reload/app quit with nothing further in flight — every other lifecycle state (starting through
 * ready/error) always carries the requestId of the auth attempt it describes. */
export type TwitchAuthProgressEvent = {
  type: "twitch-auth:progress";
  requestId: string | null;
  generation: number;
  publicState: TwitchAuthPublicState;
};
