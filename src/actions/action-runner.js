// Issue #93: executes ONE ActionPlan (built by action-planner.js from a #91 match) end to end —
// short-TTL duplicate-plan dedupe, a FRESH re-check of generation validity and #92's
// GlobalActionBudget (and, if configured, its ActionRateLimiter) immediately before actually
// running (never trusting the match-time decision alone, since a plan can sit queued for a while),
// persona/connector availability gating with a graceful fallback, the actual ai-response/
// template-speech mechanics, and routing the final result to SpeechQueue/OBS/reply-log/trace —
// all tagged with `plan.context` ("production" | "simulation", #89's own wrapper-metadata
// convention, see electron/main/services/stream-events/stream-event-history.ts).
//
// Reuses REAL modules throughout, never reimplementations:
//   - src/runtime/request-registry.js's `BrowserRequestRegistry` (via `runtime`) for the
//     generation-scoped, cancel/timeout-capable AI request — the exact same primitive
//     src/app/response-coordinator.js already uses.
//   - src/actions/global-action-budget.js's REAL `GlobalActionBudget` (#92, merged) for the
//     pre-execution budget re-check.
//   - src/actions/action-rate-limiter.js's REAL `ActionRateLimiter` (#92, merged), OPTIONALLY, for
//     a pre-execution per-trigger rate re-check when the action config carries a `rateLimit` tuple.
//   - src/personas/response-budget-tracker.js's REAL `ResponseBudgetTracker` (the SAME bounded-TTL
//     "reserve/commit, limit=1" primitive src/triggers/cooldown-tracker.js already reuses for its
//     own cooldown bookkeeping) for the short-TTL duplicate-plan dedupe — same family as #88's
//     notification-dedupe.ts / #89's event-id-dedupe.ts, mirrored mechanics, real shared class.
import { ResponseBudgetTracker } from "../personas/response-budget-tracker.js";
import { formatStreamEvent } from "../stream-events/display.js";
import { createConnector } from "../connectors.js";
import { checkAiResponseAvailability, runAiResponseAction } from "./ai-response-action.js";
import { renderTemplateSpeech } from "./template-speech-action.js";
import { buildFallbackSpeech } from "./action-fallback.js";
import { OVERLAY_SKIP_REASON } from "../overlay/overlay-cue-contract.js";

/** Short-window dedupe TTL — same family/order of magnitude as
 * electron/main/services/stream-events/event-id-dedupe.ts's `DEFAULT_EVENT_DEDUPE_TTL_MS`: enough
 * to absorb a genuine duplicate re-plan of the SAME (eventId, triggerId, actionIndex) without
 * holding plan ids indefinitely. */
export const DEFAULT_DEDUPE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_DEDUPE_MAX_ENTRIES = 2_000;

let sharedMockConnector = null;
/** Lazily-constructed, reused-across-calls mock connector for `mockAi: true` executions — reuses
 * `connectors.js`'s REAL `provider: "mock"` branch (the same mock this repo already ships for
 * apiKey-less operation, see connectors.js's own header comment), not a bespoke fake. `delayMs: 0`
 * keeps simulation runs synchronous-ish and unit-test-friendly. */
function defaultMockConnector() {
  if (!sharedMockConnector) sharedMockConnector = createConnector("stream-event-simulation-mock", { provider: "mock", delayMs: 0 });
  return sharedMockConnector;
}

export class ActionRunner {
  constructor({
    runtime,
    globalActionBudget = null,
    rateLimiter = null,
    resolvePersona = () => null,
    getConnector = () => null,
    speechQueue = null,
    obs = null,
    dispatch = () => {},
    onExecuted = () => {},
    trace = null,
    clock = () => Date.now(),
    aiTimeoutMs,
    maxOutputChars,
    maxUntrustedChars,
    maxPromptChars,
    maxTemplateChars,
    commonRules,
    dedupeTtlMs = DEFAULT_DEDUPE_TTL_MS,
    dedupeMaxEntries = DEFAULT_DEDUPE_MAX_ENTRIES,
  } = {}) {
    if (!runtime || typeof runtime.isCurrent !== "function" || typeof runtime.createRequest !== "function") {
      throw new TypeError("ActionRunner requires a runtime controller ({ isCurrent, createRequest, guard })");
    }
    this.runtime = runtime;
    this.globalActionBudget = globalActionBudget;
    this.rateLimiter = rateLimiter;
    this.resolvePersona = resolvePersona;
    this.getConnector = getConnector;
    this.speechQueue = speechQueue;
    this.obs = obs;
    this.dispatch = dispatch;
    this.onExecuted = onExecuted;
    this.trace = trace;
    this.clock = clock;
    this.aiTimeoutMs = aiTimeoutMs;
    this.maxOutputChars = maxOutputChars;
    this.maxUntrustedChars = maxUntrustedChars;
    this.maxPromptChars = maxPromptChars;
    this.maxTemplateChars = maxTemplateChars;
    this.commonRules = commonRules;
    this.dedupe = new ResponseBudgetTracker({ ttlMs: dedupeTtlMs, maxEntries: dedupeMaxEntries, clock });
  }

  /**
   * Executes `plan` (an action-planner.js ActionPlan). `overrides`:
   *   - `mockAi` (default `false`): force a mock connector regardless of what `getConnector` would
   *     return — zero real network calls.
   *   - `speak` (default `true`): call `speechQueue.enqueue()` with the FINAL text.
   *   - `notifyObs` (default `true`): call `obs.publish()` with the execution result.
   * simulation's safe defaults (mock AI ON, speech/OBS OFF) are exactly `{ mockAi: true, speak:
   * false, notifyObs: false }` — see src/simulation/stream-event-simulator.js.
   *
   * Returns a frozen result record; never throws (a thrown connector/dependency error is caught and
   * turned into an `"error"`/fallback result, matching src/app/response-coordinator.js's own
   * catch-and-dispatch stance).
   */
  async execute(plan, { speak = true, notifyObs = true, mockAi = false, onStarted = () => {} } = {}) {
    const now = this.clock();
    const event = plan.event;
    const context = plan.context ?? "production";
    const display = safeFormat(event);

    // 1) short-TTL duplicate-plan dedupe (reserve+commit immediately — "at most one execution
    // attempt per plan id per dedupeTtlMs").
    const reservation = this.dedupe.reserve(plan.id, 1, now);
    if (!reservation) return this.#skip(plan, { reason: "duplicate-plan", context, display });
    this.dedupe.commit(reservation, now);

    // 2) FRESH generation re-check — a plan captured `generation` at PLAN time; the runtime may
    // have moved on (config reload / reconnect) while this plan sat queued.
    if (!this.runtime.isCurrent(plan.generation)) return this.#skip(plan, { reason: "stale-generation", context, display });

    // The persisted/planned contract lands before the renderer runtime. Until that runtime is
    // composed, overlay cues are an explicit no-side-effect skip. Unknown future kinds are also
    // denied here instead of falling through to the AI path.
    if (plan.kind === "overlay-cue") return this.#skip(plan, { reason: OVERLAY_SKIP_REASON.OVERLAY_UNAVAILABLE, context, display });
    if (plan.kind !== "ai-response" && plan.kind !== "template-speech") return this.#skip(plan, { reason: "unsupported-action-kind", context, display });

    // 3) FRESH #92 GlobalActionBudget re-check (real module, re-consulted here — never trusted from
    // match time alone).
    let budgetReservation = null;
    if (this.globalActionBudget) {
      let decision;
      try {
        decision = this.globalActionBudget.reserve({ priority: plan.priority, now });
      } catch (error) {
        return this.#dependencyError(plan, { error, context, display });
      }
      if (!decision.allowed) return this.#skip(plan, { reason: decision.reason, context, display });
      budgetReservation = decision.reservation;
    }

    // 4) FRESH #92 ActionRateLimiter re-check (optional — only when the action config opted in with
    // its own `rateLimit` tuple; real module, real key derivation scoped to trigger+action).
    if (this.rateLimiter && plan.action?.rateLimit) {
      const key = `stream-event-action:${plan.triggerId}:${plan.actionIndex}`;
      let decision;
      try {
        decision = this.rateLimiter.attempt(key, plan.action.rateLimit, now);
      } catch (error) {
        if (budgetReservation) { try { this.globalActionBudget.release(budgetReservation); } catch {} }
        return this.#dependencyError(plan, { error, context, display });
      }
      if (!decision.allowed) {
        if (budgetReservation) { try { this.globalActionBudget.release(budgetReservation); } catch {} }
        return this.#skip(plan, { reason: decision.reason ?? decision.decision, context, display });
      }
    }

    try {
      onStarted({ plan, context, startedAt: this.clock() });
      switch (plan.kind) {
        case "template-speech": return await this.#runTemplateSpeech(plan, { event, context, display, speak, notifyObs });
        case "ai-response": return await this.#runAiResponse(plan, { event, context, display, speak, notifyObs, mockAi });
        default: return this.#skip(plan, { reason: "unsupported-action-kind", context, display });
      }
    } catch (error) {
      return this.#dependencyError(plan, { error, context, display });
    } finally {
      if (budgetReservation) { try { this.globalActionBudget.complete(budgetReservation); } catch {} }
    }
  }

  async #runAiResponse(plan, { event, context, display, speak, notifyObs, mockAi }) {
    const action = plan.action;
    const availability = checkAiResponseAvailability({ action, resolvePersona: this.resolvePersona, getConnector: this.getConnector });
    const persona = availability.persona;

    if (!mockAi && !availability.available) {
      return this.#fallback(plan, { event, context, display, persona, speak, notifyObs, reason: availability.reason });
    }

    this.dispatch({ type: "action-started", plan, persona, context, triggerId: plan.triggerId });
    const connector = mockAi ? defaultMockConnector() : availability.connector;
    const generation = plan.generation;

    const outcome = await runAiResponseAction({
      plan,
      event,
      persona,
      connector,
      runtime: this.runtime,
      generation,
      timeoutMs: action.timeoutMs ?? this.aiTimeoutMs,
      maxOutputChars: action.maxChars ?? this.maxOutputChars,
      contextOptions: { maxUntrustedChars: this.maxUntrustedChars, maxPromptChars: this.maxPromptChars, commonRules: this.commonRules },
    });

    this.dispatch({ type: "action-debug", plan, persona, debugText: outcome.debugText, context, triggerId: plan.triggerId });

    if (outcome.ok) {
      this.dispatch({ type: "action-final", plan, persona, text: outcome.text, context, triggerId: plan.triggerId, contentLabel: event?.kind ?? null, contentTitle: display?.summary ?? null });
      this.#speakAndNotify({ plan, persona, text: outcome.text, context, speak, notifyObs, source: "ai-response", voiceAvailable: availability.voiceAvailable });
      const result = this.#result(plan, { status: "executed", text: outcome.text, context, personaId: persona?.id ?? null });
      this.#trace(result);
      return result;
    }

    if (outcome.cancelled) {
      this.dispatch({ type: "action-cancelled", plan, persona, context, triggerId: plan.triggerId });
      const result = this.#result(plan, { status: "cancelled", context, personaId: persona?.id ?? null, error: outcome.error });
      this.#trace(result);
      return result;
    }

    this.dispatch({ type: "action-error", plan, persona, error: outcome.error, context, triggerId: plan.triggerId });
    return this.#fallback(plan, { event, context, display, persona, speak, notifyObs, reason: "ai-error", error: outcome.error });
  }

  async #runTemplateSpeech(plan, { event, context, display, speak, notifyObs }) {
    const action = plan.action;
    let persona = null;
    if (action.personaId) {
      try {
        persona = this.resolvePersona(action.personaId);
      } catch {
        persona = null;
      }
    }
    const rendered = renderTemplateSpeech(action.template, event, { maxChars: action.maxChars ?? this.maxTemplateChars });
    this.dispatch({ type: "action-final", plan, persona, text: rendered.text, context, triggerId: plan.triggerId, contentLabel: event?.kind ?? null, contentTitle: display?.summary ?? null });
    this.#speakAndNotify({ plan, persona, text: rendered.text, context, speak, notifyObs, source: "template-speech", voiceAvailable: persona?.voice?.enabled !== false });
    const result = this.#result(plan, { status: "executed", text: rendered.text, context, personaId: persona?.id ?? null });
    this.#trace(result);
    return result;
  }

  #fallback(plan, { event, context, display, persona, speak, notifyObs, reason, error = null }) {
    const fallback = buildFallbackSpeech({ event, action: plan.action, reason });
    this.dispatch({ type: "action-fallback", plan, persona, reason, context, triggerId: plan.triggerId, contentLabel: event?.kind ?? null, contentTitle: display?.summary ?? null });
    this.#speakAndNotify({ plan, persona, text: fallback.text, context, speak, notifyObs, source: "fallback", voiceAvailable: persona?.voice?.enabled !== false });
    const result = this.#result(plan, { status: "fallback", text: fallback.text, context, personaId: persona?.id ?? null, fallbackReason: reason, error });
    this.#trace(result);
    return result;
  }

  #skip(plan, { reason, context, display }) {
    this.#safeDispatch({ type: "action-skipped", plan, reason, context, triggerId: plan.triggerId, contentLabel: display?.label ?? null });
    const result = this.#result(plan, { status: "skipped", reason, context });
    this.#trace(result);
    return result;
  }

  #dependencyError(plan, { error, context, display }) {
    const normalized = error instanceof Error ? error : new Error(String(error ?? "unknown dependency error"));
    this.#safeDispatch({ type: "action-error", plan, error: normalized, context, triggerId: plan.triggerId, contentLabel: display?.label ?? null });
    const result = this.#result(plan, { status: "error", reason: "dependency-error", context, error: normalized });
    this.#trace(result);
    return result;
  }

  #safeDispatch(event) {
    try { this.dispatch(event); } catch {}
  }

  #speakAndNotify({ plan, persona, text, context, speak, notifyObs, source, voiceAvailable }) {
    if (speak && voiceAvailable !== false && this.speechQueue) {
      this.speechQueue.enqueue({
        personaId: persona?.id ?? plan.action?.personaId ?? "stream-event",
        personaName: persona?.name ?? "配信イベント",
        text,
        voice: persona?.voice ?? {},
        source: `stream-event:${source}`,
        priority: plan.priority,
      });
    }
    if (notifyObs && this.obs) {
      this.obs.publish("stream-event-action", { planId: plan.id, eventId: plan.eventId, triggerId: plan.triggerId, text, context, source });
    }
    this.onExecuted({ plan, text, context, source });
  }

  #result(plan, { status, reason = null, text = null, context, personaId = null, fallbackReason = null, error = null }) {
    return Object.freeze({
      planId: plan.id,
      eventId: plan.eventId,
      triggerId: plan.triggerId,
      actionIndex: plan.actionIndex,
      kind: plan.kind,
      status,
      reason,
      text,
      context,
      personaId,
      usedFallback: status === "fallback",
      fallbackReason,
      error: error ? { message: typeof error.message === "string" ? error.message : String(error), kind: error.kind ?? null } : null,
    });
  }

  #trace(result) {
    try { this.trace?.record?.(result); } catch {}
  }
}

function safeFormat(event) {
  try {
    return formatStreamEvent(event);
  } catch {
    return null;
  }
}
