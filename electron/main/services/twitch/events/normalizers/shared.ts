// Issue #90: small helpers shared by every normalizer under this directory — actor/channel
// construction (including the anonymous-actor rule: NEVER back-fill/guess an identity when Twitch
// itself reports `is_anonymous: true`, see `buildActor()`'s own doc comment below), the
// event-timestamp-fallback-chain call every normalizer needs, and a defensive raw-record
// coercion. Deliberately NOT part of ../twitch-event-normalizer.ts itself, so that file can stay a
// pure type@version dispatch table (its own doc comment) without every normalizer needing a
// circular value-import back into it — normalizers only ever import a *type* from
// ../twitch-event-normalizer.ts (erased at build time by esbuild/tsc, never a runtime edge).
import type { StreamEvent } from "../../../../../../src/stream-events/contract.js";
import { requireNonEmptyString } from "../event-validation";
import type { NormalizeIssue } from "../event-validation";
import { normalizeEventTimestamp } from "../timestamp-normalizer";

/** The fixed, non-identifying label an anonymous actor's `displayName` is ALWAYS set to — issue
 * #90's "匿名identityを推測しない" means this is the ONLY thing it is ever allowed to be; never
 * derived from any other field on the payload (an anonymous cheer/gift-sub's `user_id`/
 * `user_login`/`user_name` are nulled out by Twitch itself and must stay untouched/unused here). */
export const ANONYMOUS_ACTOR_DISPLAY_NAME = "Anonymous";

/** Defensive `unknown -> plain record` coercion every normalizer starts with — `input.event` is
 * still fully untrusted at this point (shaped like Twitch's documented payload, but never
 * guaranteed by anything at compile time; a fixture or a future malformed delivery could hand this
 * literally anything). */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstNonEmptyString(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

/** Builds a StreamEvent `actor`. When `isAnonymous` (read from the raw payload's own
 * `is_anonymous` field by the caller) is true, `id`/`login`/`name` are IGNORED ENTIRELY — never
 * inspected, never used to derive a displayName. Returns `null` (recording an `error` issue) only
 * on the non-anonymous path when `id` is missing/invalid: `id` is a CRITICAL field for a named
 * actor (StreamEvent's own contract requires it whenever `isAnonymous` is not true — see
 * src/stream-events/schemas.js's `validateActor()`). */
export function buildActor(
  raw: { id: unknown; login: unknown; name: unknown },
  isAnonymous: boolean,
  issues: NormalizeIssue[],
): StreamEvent["actor"] | null {
  if (isAnonymous) return { id: null, displayName: ANONYMOUS_ACTOR_DISPLAY_NAME, isAnonymous: true };
  const id = requireNonEmptyString(raw.id, "actor.id", issues);
  if (id === null) return null;
  const displayName = firstNonEmptyString(raw.name, raw.login) ?? id;
  return { id, displayName, isAnonymous: false };
}

/** Builds a StreamEvent `channel` (the broadcaster the event happened on) — never anonymous;
 * Twitch always reports the broadcaster's identity on every one of these 5 subscription types.
 * `id` is CRITICAL — a missing/invalid broadcaster id fails normalization outright. */
export function buildChannel(raw: { id: unknown; login: unknown; name: unknown }, issues: NormalizeIssue[]): StreamEvent["channel"] | null {
  const id = requireNonEmptyString(raw.id, "channel.id", issues);
  if (id === null) return null;
  const displayName = firstNonEmptyString(raw.name, raw.login) ?? id;
  return { id, displayName };
}

/** Runs the `event -> message -> receivedAt` timestamp fallback chain (../timestamp-normalizer.ts)
 * and pushes any resulting warning onto the caller's own `issues` array — every one of the 5
 * normalizers calls this exactly once, differing only in whether they have a real per-event
 * timestamp candidate to pass (only reward-redemption.ts's `redeemed_at` does; every other
 * normalizer omits `eventTimestamp` entirely, going straight to the message/receivedAt links).
 * Factored here instead of each normalizer inlining `normalizeEventTimestamp(...)` +
 * `issues.push(...result.issues)` itself. */
export function resolveTimestamp(
  input: { messageTimestamp?: unknown; receivedAtMs?: number },
  issues: NormalizeIssue[],
  eventTimestamp?: unknown,
): string {
  const result = normalizeEventTimestamp({ eventTimestamp, messageTimestamp: input.messageTimestamp, receivedAtMs: input.receivedAtMs ?? Date.now() });
  issues.push(...result.issues);
  return result.timestamp;
}
