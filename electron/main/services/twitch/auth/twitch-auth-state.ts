// Pure state shape + transition guard for the Device Code Grant state machine
// (signed_out -> starting -> awaiting_user -> exchanging -> {ready, error}). No I/O, no timers —
// device-code-flow.ts is the only thing that drives transitions.
import crypto from "node:crypto";
import { ServiceError } from "../../service-error";
import type { TwitchAuthErrorShape, TwitchAuthLifecycleState, TwitchAuthPublicState } from "../../../../shared/twitch/auth-contract";

const SERVICE_ID = "twitch:auth";

/** Main-process-only state: carries `deviceCode`, which must never reach `toPublicAuthState`'s
 * output. Deliberately does NOT have a field for access_token/refresh_token at all — the token
 * response is handed off directly to `DeviceCodeFlowDeps.onTokenObtained` and never stored here,
 * so there is no field a future refactor could accidentally spread into the public state. */
export type TwitchAuthInternalState = {
  state: TwitchAuthLifecycleState;
  requestId: string | null;
  generation: number;
  scopes: string[];
  scopeFingerprint: string | null;
  deviceCode: string | null;
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: string | null;
  intervalSeconds: number | null;
  error: TwitchAuthErrorShape | null;
  updatedAt: string;
};

export function initialAuthState(updatedAt: string, generation = 0): TwitchAuthInternalState {
  return { state: "signed_out", requestId: null, generation, scopes: [], scopeFingerprint: null, deviceCode: null, userCode: null, verificationUri: null, expiresAt: null, intervalSeconds: null, error: null, updatedAt };
}

export const AUTH_STATE_TRANSITIONS: Readonly<Record<TwitchAuthLifecycleState, readonly TwitchAuthLifecycleState[]>> = Object.freeze({
  signed_out: ["starting"],
  starting: ["awaiting_user", "error", "signed_out"],
  awaiting_user: ["exchanging", "error", "signed_out"],
  exchanging: ["awaiting_user", "ready", "error", "signed_out"],
  ready: ["starting", "signed_out"],
  error: ["starting", "signed_out"],
});

export function canTransitionAuthState(from: TwitchAuthLifecycleState, to: TwitchAuthLifecycleState): boolean {
  return from === to || AUTH_STATE_TRANSITIONS[from].includes(to);
}

export function assertAuthStateTransition(from: TwitchAuthLifecycleState, to: TwitchAuthLifecycleState): void {
  if (!canTransitionAuthState(from, to)) throw new ServiceError("CONFLICT", `invalid Twitch auth state transition: ${from} -> ${to}`, { serviceId: SERVICE_ID, retryable: false });
}

/** Sorts + dedupes a scope list — the same normalization the future "enabled features -> scopes"
 * resolver (#85) is expected to feed through before calling device-code-flow.ts's start(), so two
 * requests for the same effective scope set always fingerprint identically regardless of the
 * order features were toggled in. */
export function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

export function computeScopeFingerprint(scopes: readonly string[]): string {
  return crypto.createHash("sha256").update(normalizeScopes(scopes).join(" ")).digest("hex");
}

/** The only place `deviceCode` is (deliberately) dropped on the way to a Renderer-safe shape. */
export function toPublicAuthState(internal: TwitchAuthInternalState): TwitchAuthPublicState {
  return {
    state: internal.state,
    requestId: internal.requestId,
    generation: internal.generation,
    scopes: internal.scopes,
    scopeFingerprint: internal.scopeFingerprint,
    userCode: internal.userCode,
    verificationUri: internal.verificationUri,
    expiresAt: internal.expiresAt,
    intervalSeconds: internal.intervalSeconds,
    error: internal.error,
    updatedAt: internal.updatedAt,
  };
}
