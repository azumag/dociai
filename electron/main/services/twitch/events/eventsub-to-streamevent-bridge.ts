// Issue #177: the missing wire between #86's EventSubService/#88's ReconnectCoordinator
// `notification` callback and #90's twitch-event-normalizer.ts. #86-90 were each merged with this
// exact gap left open (their own PR bodies say so explicitly) — this file is the first place a
// real, live EventSub `notification` envelope actually reaches `normalizeTwitchEvent()`.
//
// INPUT SHAPE: an `EventSubEnvelope` (eventsub-message-parser.ts) for a message the caller has
// already classified as `kind: "known", messageType: "notification"` (see
// electron/main/services/twitch/eventsub/eventsub-session.ts's `case "notification"` /
// reconnect-coordinator.ts's own `onNotification` dep — this class is deliberately as dumb as
// possible about WHERE the envelope came from, so it plugs into either the ORIGINAL #86
// `EventSubService.onNotification` or #88's `ReconnectCoordinator.onNotification` (the wiring this
// issue actually uses in twitch-composition.ts — see that file's own comment for why: #88's
// ReconnectCoordinator, not #86's EventSubService, is what twitch-composition.ts already
// constructs and drives production reconnection with).
//
// `type`/`version` for the `${type}@${version}` normalizer lookup come from
// `envelope.metadata.subscriptionType`/`subscriptionVersion` — the two EventSubMetadata fields
// Twitch's real `notification` frames always carry (see eventsub-message-parser.ts's own
// `EventSubMetadata` type) — NEVER from `messageType` (which is always the literal string
// `"notification"` and carries no type/version information at all).
//
// "変換に失敗したnotification (unknown type/version, critical field欠損) をdiagnosticへ記録し無言
// dropしない": every non-success path here (missing subscriptionType/Version, or
// `normalizeTwitchEvent()` returning `ok:false`) calls `onDiagnostic()` with enough detail to
// explain WHY — never a silent `return` with no observable trace. `onDiagnostic` is REQUIRED (not
// defaulted to a no-op) precisely so a caller can't accidentally wire this up without a sink for
// that diagnostic — see twitch-composition.ts's own construction site for where it lands
// (electron/main/index.ts's `console.error`-based `log`, same as this module's own sibling
// services already use for their own `log` deps).
import { normalizeTwitchEvent } from "./twitch-event-normalizer";
import type { NormalizeDiagnostics, NormalizeIssue } from "./twitch-event-normalizer";
import type { EventSubEnvelope } from "../eventsub/eventsub-message-parser";
import type { StreamEvent } from "../../../../../src/stream-events/contract.js";

export type EventSubBridgeDiagnosticReason = "missing-subscription-type-or-version" | "normalize-failed";

export type EventSubBridgeDiagnostic = {
  reason: EventSubBridgeDiagnosticReason;
  type: string | null;
  version: string | null;
  messageId: string | null;
  issues: readonly NormalizeIssue[];
  diagnostics: NormalizeDiagnostics | null;
};

export type EventSubToStreamEventBridgeDeps = {
  /** Called for every notification that normalizes successfully — the caller is expected to
   * `streamEventBus.publish(event, "production")` it (see twitch-composition.ts's own
   * `onStreamEvent` dep), but this class never touches a StreamEventBus itself (same "depend on the
   * shape, not the class" seam this repo's Twitch services already use throughout). */
  onStreamEvent: (event: StreamEvent) => void;
  /** Called for every notification this bridge could NOT turn into a StreamEvent — "diagnosticへ
   * 記録し無言dropしない". Required, not optional; see this module's own header comment. */
  onDiagnostic: (diagnostic: EventSubBridgeDiagnostic) => void;
  /** Local receipt clock (ms since epoch) — threaded into `normalizeTwitchEvent()`'s own timestamp
   * fallback chain (see NormalizeInput's `receivedAtMs`). Defaults to `Date.now()`, overridable for
   * deterministic tests, mirroring every other Twitch service file's own `now` dep. */
  now?: () => number;
  /** Opt-in only (default off) — threaded straight through to `normalizeTwitchEvent()`'s own
   * `keepRawPayload` (bounded/redacted debug retention, never published onto the StreamEventBus).
   * Off by default so production notifications never pay that cost unless explicitly asked for. */
  keepRawPayload?: boolean;
};

/** Structural shape of a Twitch EventSub `notification` message's `payload` — `event` is the raw,
 * still-fully-untrusted Twitch event body `normalizeTwitchEvent()`'s `NormalizeInput.event` expects
 * (see twitch-event-normalizer.ts's own doc comment for why this is deliberately NOT the whole
 * envelope). A payload missing `event` entirely (malformed) is treated as `undefined`, which every
 * normalizer already rejects via its own critical-field checks — never a special case here. */
type NotificationPayload = { event?: unknown };

function payloadEvent(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as NotificationPayload).event;
}

export class EventSubToStreamEventBridge {
  readonly #onStreamEvent: (event: StreamEvent) => void;
  readonly #onDiagnostic: (diagnostic: EventSubBridgeDiagnostic) => void;
  readonly #now: () => number;
  readonly #keepRawPayload: boolean;

  constructor(deps: EventSubToStreamEventBridgeDeps) {
    this.#onStreamEvent = deps.onStreamEvent;
    // Fails LOUDLY and IMMEDIATELY at construction (composition/wiring time) rather than lazily the
    // first time a rare malformed/unnormalizable notification actually arrives deep inside a live
    // WebSocket message handler — a missing sink for "diagnosticへ記録し無言dropしない" is a wiring
    // bug that should surface at startup, never as an unhandled exception mid-stream in production.
    if (typeof deps.onDiagnostic !== "function") throw new TypeError("EventSubToStreamEventBridge requires an onDiagnostic function");
    this.#onDiagnostic = deps.onDiagnostic;
    this.#now = deps.now ?? (() => Date.now());
    this.#keepRawPayload = deps.keepRawPayload ?? false;
  }

  /** Handles ONE `notification` envelope. Never throws — a malformed/unnormalizable notification is
   * reported via `onDiagnostic()`, exactly like `normalizeTwitchEvent()` itself never throws for an
   * unrecognized `type@version` or a missing critical field (see that function's own doc comment). */
  handleNotification(envelope: EventSubEnvelope): void {
    const type = envelope?.metadata?.subscriptionType ?? null;
    const version = envelope?.metadata?.subscriptionVersion ?? null;
    const messageId = envelope?.metadata?.messageId ?? null;

    if (!type || !version) {
      this.#onDiagnostic({ reason: "missing-subscription-type-or-version", type, version, messageId, issues: [], diagnostics: null });
      return;
    }

    const result = normalizeTwitchEvent(type, version, {
      event: payloadEvent(envelope?.payload),
      messageId: messageId ?? "",
      messageTimestamp: envelope?.metadata?.messageTimestamp,
      receivedAtMs: this.#now(),
      keepRawPayload: this.#keepRawPayload,
    });

    if (!result.ok) {
      this.#onDiagnostic({ reason: "normalize-failed", type, version, messageId, issues: result.issues, diagnostics: result.diagnostics });
      return;
    }

    this.#onStreamEvent(result.event);
  }
}
