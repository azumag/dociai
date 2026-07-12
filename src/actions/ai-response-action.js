// Issue #93: the `ai-response` action kind's own execution mechanics — availability checking
// (persona/connector actually configured+enabled) and the AI connector call itself (build prompt,
// call, cancel/timeout). Deliberately split out from action-runner.js (which owns dedupe/
// generation/budget/dispatch/speech-queue/OBS orchestration common to BOTH action kinds) so this
// file's only job is "how do we get text out of the AI connector for one plan".
//
// Reuses THIS REPO'S EXISTING generation/cancel/timeout primitive one-for-one — the exact same
// `runtime.createRequest({ generation, ownerId, kind, timeoutMs })` / `runtime.guard(context)` /
// `request.complete()` calls src/app/response-coordinator.js already makes (see that file's own
// `respond()`), backed by src/runtime/request-registry.js's REAL `BrowserRequestRegistry` (timeout
// is a real `setTimeout` that aborts the request's own AbortController — nothing here reimplements
// timeout/cancel, it only supplies `timeoutMs` and reads `request.context.signal`, the same
// contract `connectors.js`'s connectors already expect via `opts.signal`).
import { isCancellation } from "../runtime/request-registry.js";
import { buildStreamEventContext } from "../context/stream-event-context.js";
import { sanitizeInlineText } from "./action-schema.js";

export const DEFAULT_AI_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 200;

/**
 * Confirms the `ai-response` action's configured persona/connector actually exist and are enabled
 * in the CURRENT config — "persona/connector/voice/OBS availabilityを確認 ... fail gracefully to
 * action-fallback.js if not, don't throw/crash". Never throws; `getConnector`/`resolvePersona`
 * throwing is caught and treated as unavailable, same defensive stance
 * src/topic-reader.js's `#getConnector()` already takes.
 *
 * Returns `{ persona, connector, personaAvailable, connectorAvailable, voiceAvailable, available,
 * reason }` — `available` gates whether the AI call may even be attempted (persona+connector only;
 * `voiceAvailable` is reported separately since a disabled voice should silence SPEAKING, not block
 * generating/logging a text response — see action-runner.js's own `#speakAndNotify`).
 */
export function checkAiResponseAvailability({ action, resolvePersona, getConnector }) {
  let persona = null;
  try {
    persona = typeof resolvePersona === "function" ? resolvePersona(action?.personaId) : null;
  } catch {
    persona = null;
  }
  const personaAvailable = Boolean(persona) && persona.enabled !== false;

  let connector = null;
  const connectorId = action?.connectorId ?? persona?.connector ?? null;
  if (personaAvailable && connectorId && typeof getConnector === "function") {
    try {
      connector = getConnector(connectorId);
    } catch {
      connector = null;
    }
  }
  const connectorAvailable = Boolean(connector) && typeof connector.chat === "function";
  const voiceAvailable = persona?.voice?.enabled !== false;

  const reason = !personaAvailable ? "persona-unavailable" : !connectorAvailable ? "connector-unavailable" : null;
  return Object.freeze({ persona, connector, personaAvailable, connectorAvailable, voiceAvailable, available: personaAvailable && connectorAvailable, reason });
}

/**
 * Calls the AI connector for one `ai-response` ActionPlan. Builds the injection-safe prompt via
 * `buildContext` (defaults to src/context/stream-event-context.js's `buildStreamEventContext`,
 * injectable for tests), issues a cancel/timeout-bounded request through `runtime`, and trims the
 * final output text before returning it — "final textだけSpeechQueueへ" starts here: this function
 * NEVER returns a partial/streaming chunk, only the connector's one resolved `{text}}`.
 *
 * Returns `{ ok, text, debugText }` on success, or `{ ok: false, cancelled, error, debugText }` on
 * failure/cancellation. Never throws.
 */
export async function runAiResponseAction({
  plan,
  event,
  persona,
  connector,
  runtime,
  generation,
  timeoutMs = DEFAULT_AI_TIMEOUT_MS,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  buildContext = buildStreamEventContext,
  contextOptions = {},
}) {
  const { messages, debugText } = buildContext({ persona, event, action: plan.action, ...contextOptions });
  const request = runtime.createRequest({
    generation,
    ownerId: `stream-event-action:${generation}:${plan.id}`,
    kind: "stream-event-ai-response",
    timeoutMs,
  });
  try {
    const response = await connector.chat(messages, {
      signal: request.context.signal,
      requestId: request.context.requestId,
      generation,
      maxTokens: plan.action?.maxTokens,
    });
    runtime.guard(request.context);
    const text = sanitizeInlineText(response?.text ?? "", { maxChars: maxOutputChars });
    if (!text) throw Object.assign(new Error("AI応答が空でした"), { kind: "empty" });
    return { ok: true, text, debugText };
  } catch (error) {
    if (isCancellation(error)) return { ok: false, cancelled: true, error, debugText };
    return { ok: false, cancelled: false, error, debugText };
  } finally {
    request.complete();
  }
}
