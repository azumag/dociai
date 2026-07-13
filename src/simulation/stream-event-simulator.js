// Issue #93: lets a future operator UI (#96) construct a synthetic StreamEvent — from a named
// fixture or fully custom operator-typed input — and run it through the EXACT SAME
// matcher (#91) -> planner -> runner (#93) domain path a real Twitch-sourced event takes, so a
// "try my trigger conditions" tool can never silently diverge from production behavior. The custom
// input is validated with the SAME `validateStreamEvent()` (#89's schemas.js) a real #90 normalizer
// output would have to pass — "no bypassing validation just because it's a simulated event".
//
// Safe-by-default per the issue's own explicit requirement (must match #96's eventual safe
// defaults): a plain `simulateStreamEvent()` call with no `options` override MOCKS the AI connector
// (real `connectors.js` `provider:"mock"`, zero network calls), NEVER calls the real SpeechQueue,
// NEVER broadcasts to real OBS, and BYPASSES cooldown (src/triggers/cooldown-tracker.js's own
// `bypassCooldown` flag — reused here, not reimplemented) — so an operator testing trigger
// conditions can never accidentally speak or broadcast for real, or spend a real AI request, purely
// by running a simulation. `options.productionEquivalent: true` is the explicit, opt-in escape
// hatch for someone who genuinely wants to exercise the full real pipeline end to end.
//
// `context: "production" | "simulation"` on every plan/result below is the SAME wrapper-metadata
// field #89 established for `StreamEventBus`'s `PublishedStreamEvent` (see
// electron/main/services/stream-events/stream-event-history.ts's own `StreamEventContext` type) —
// extended here to ActionPlan/execution-result tagging so a trace/history view can tell simulated
// runs apart from real ones at a glance.
import { CURRENT_SCHEMA_VERSION } from "../stream-events/contract.js";
import { validateStreamEvent } from "../stream-events/schemas.js";
import { matchEvent } from "../triggers/event-trigger-matcher.js";
import { planActions } from "../actions/action-planner.js";

export const SIMULATION_CONTEXT = "simulation";
export const PRODUCTION_CONTEXT = "production";

/** Safe-by-default simulation options — "cooldown bypass ON, mock AI ON, speech/OBS OFF". */
export const DEFAULT_SIMULATION_OPTIONS = Object.freeze({
  bypassCooldown: true,
  useMockAi: true,
  enableSpeech: false,
  enableObs: false,
});

/** The explicit "run for real" opt-in — the inverse of every default above. */
export const PRODUCTION_EQUIVALENT_OPTIONS = Object.freeze({
  bypassCooldown: false,
  useMockAi: false,
  enableSpeech: true,
  enableObs: true,
});

function baseFixture(kind, data, overrides = {}) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: overrides.id ?? `sim-${kind}-${Math.random().toString(36).slice(2, 10)}`,
    kind,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    actor: overrides.actor ?? { id: "sim-user-1", displayName: "シミュレーション視聴者", isAnonymous: false },
    channel: overrides.channel ?? { id: "sim-channel", displayName: "シミュレーションチャンネル" },
    sourceMetadata: overrides.sourceMetadata ?? { simulated: true },
    data,
    ...overrides,
  };
}

/** One representative fixture per STREAM_EVENT_KINDS — deliberately realistic (passes
 * `validateStreamEvent()` unmodified) so a fixture-driven simulation exercises the real matcher
 * immediately, without an operator having to hand-author a valid event from scratch. */
export const SIMULATION_FIXTURES = Object.freeze({
  cheer: () => baseFixture("cheer", { bits: 100, message: "応援してます!" }),
  subscription: () => baseFixture("subscription", { tier: "1000", isGift: false }),
  resub: () => baseFixture("resub", { tier: "1000", cumulativeMonths: 6, streakMonths: 3, message: "いつも見てます" }),
  "gift-subscription": () => baseFixture("gift-subscription", { tier: "1000", count: 5, cumulativeTotal: 20 }),
  "reward-redemption": () => baseFixture("reward-redemption", { rewardId: "reward-1", rewardTitle: "配信者に一言", cost: 500, userInput: "こんにちは!", status: "fulfilled" }),
});

export const SIMULATION_FIXTURE_KINDS = Object.freeze(Object.keys(SIMULATION_FIXTURES));

/** Builds a named fixture event, optionally overridden — still passed through `validateStreamEvent`
 * by `simulateStreamEvent()` just like any other input (an override that breaks validity is
 * reported as an issue, never silently accepted). */
export function buildFixtureEvent(kind, overrides = {}) {
  const builder = SIMULATION_FIXTURES[kind];
  if (!builder) return null;
  const fixture = builder();
  return { ...fixture, ...overrides, actor: { ...fixture.actor, ...overrides.actor }, channel: { ...fixture.channel, ...overrides.channel }, data: { ...fixture.data, ...overrides.data } };
}

function resolveInput({ fixture, overrides, event }) {
  if (event !== undefined) return event;
  if (fixture) return buildFixtureEvent(fixture, overrides);
  return null;
}

function resolveEffectiveOptions(options = {}) {
  const base = options.productionEquivalent ? { ...PRODUCTION_EQUIVALENT_OPTIONS } : { ...DEFAULT_SIMULATION_OPTIONS };
  return { ...base, ...options };
}

/**
 * Shared core: matchEvent() -> planActions() -> (cooldown gate) -> ActionRunner.execute(), for an
 * ALREADY-VALIDATED event. Both `simulateStreamEvent()` (below, `context: "simulation"`, safe
 * mock-by-default) and `runProductionStreamEvent()` (issue #177, `context: "production"`, always
 * real deps) delegate here so there is exactly ONE implementation of "how a StreamEvent becomes
 * ActionPlans and gets executed" — never two parallel copies that could silently drift apart.
 *
 * The cooldown key is namespaced by `context` (`"simulation:<triggerId>"` /
 * `"production:<triggerId>"`) so a simulation run and a real production event for the SAME trigger
 * id can never accidentally share (and consume) each other's cooldown window, even if a caller
 * mistakenly reused one CooldownTracker instance across both.
 */
async function runStreamEventPipeline({ context, effective, validatedEvent, triggers, actionRunner, cooldownTracker, cooldownConfigByTrigger, matchOptions, generation, now, trace }) {
  const { matches, skipped, truncated } = matchEvent(triggers, validatedEvent, { ...matchOptions, trace });

  const plans = [];
  const planSkips = [];
  for (const match of matches) {
    const trigger = triggers.find((entry) => entry?.id === match.triggerId);
    const actions = Array.isArray(trigger?.actions) ? trigger.actions : [];
    const planned = planActions({ event: validatedEvent, triggerId: match.triggerId, actions, priority: match.priority, context, generation, now });
    plans.push(...planned.plans);
    for (const skip of planned.skipped) planSkips.push({ triggerId: match.triggerId, ...skip });
  }

  const results = [];
  if (actionRunner) {
    for (const plan of plans) {
      if (cooldownTracker) {
        const cooldownConfig = cooldownConfigByTrigger(plan.triggerId);
        if (cooldownConfig) {
          const gate = cooldownTracker.schedule(`${context}:${plan.triggerId}`, { ...cooldownConfig, bypassCooldown: effective.bypassCooldown }, now);
          if (!gate.allowed) {
            results.push({ planId: plan.id, executed: false, reason: gate.reason });
            continue;
          }
        }
      }
      const result = await actionRunner.execute(plan, { mockAi: effective.useMockAi, speak: effective.enableSpeech, notifyObs: effective.enableObs });
      results.push(result);
    }
  }

  return { ok: true, event: validatedEvent, matches, skipped, truncated, plans, planSkips, results, context, options: effective };
}

/**
 * Runs one synthetic StreamEvent through matchEvent() -> planActions() -> ActionRunner.execute(),
 * the SAME domain code a real production event uses. `triggers` are #91 EventTriggerConfigs, each
 * optionally carrying its own `actions` array (see action-planner.js). `actionRunner` is a REAL
 * (shared-with-production, if the caller wants) `ActionRunner` instance — this function only
 * decides WHICH override flags (`mockAi`/`speak`/`notifyObs`) get passed to its `execute()` calls,
 * it never constructs a second, parallel execution path.
 *
 * Returns `{ ok, event, matches, skipped, truncated, plans, planSkips, results, context, options }`.
 * `ok:false` (validation failure) short-circuits before any matcher/planner/runner code runs at
 * all — same "no bypassing validation" guarantee a real #90-normalized event gets.
 */
export async function simulateStreamEvent({
  fixture = null,
  overrides = {},
  event: rawEventOverride,
  triggers = [],
  actionRunner,
  cooldownTracker = null,
  cooldownConfigByTrigger = () => null,
  matchOptions = {},
  generation = 0,
  options = {},
  now = Date.now(),
  trace = null,
} = {}) {
  const effective = resolveEffectiveOptions(options);
  const context = SIMULATION_CONTEXT;

  const input = resolveInput({ fixture, overrides, event: rawEventOverride });
  const validation = validateStreamEvent(input);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues, event: null, matches: [], skipped: [], truncated: false, plans: [], planSkips: [], results: [], context, options: effective };
  }

  return runStreamEventPipeline({ context, effective, validatedEvent: validation.event, triggers, actionRunner, cooldownTracker, cooldownConfigByTrigger, matchOptions, generation, now, trace });
}

/**
 * Issue #177: the PRODUCTION counterpart to `simulateStreamEvent()` — runs an already-#90-normalized
 * StreamEvent (received live from the Main-process StreamEventBus, #89) through the EXACT SAME
 * matchEvent() -> planActions() -> cooldown -> ActionRunner.execute() pipeline, but tagged
 * `context: "production"` throughout (plans, dispatched action events, the OBS
 * `stream-event-action` broadcast, the returned envelope) instead of `simulateStreamEvent()`'s
 * always-"simulation" tag — so a real cheer/subscribe/redemption never gets mislabeled as a
 * simulation run in the Event History view (#96) or the OBS overlay.
 *
 * Unlike `simulateStreamEvent()`, there is no "safe by default" option resolution here: a
 * production event ALWAYS runs with `PRODUCTION_EQUIVALENT_OPTIONS` (real AI connector, real
 * SpeechQueue, real OBS broadcast, real — non-bypassed — cooldown). There is no fixture/override
 * support either (a production event is always a real, already-validated `event`, never an
 * operator-authored fixture) and no `productionEquivalent` opt-in flag (production IS the opt-in).
 * Still re-validates via `validateStreamEvent()` — defense in depth, and the same "no bypassing
 * validation" guarantee `simulateStreamEvent()` gives, even though the StreamEventBus already
 * validated this event once at publish time.
 *
 * Returns the SAME `{ ok, event, matches, skipped, truncated, plans, planSkips, results, context,
 * options }` envelope shape `simulateStreamEvent()` returns (`context: "production"`), so
 * src/twitch-ui/history/history-store.js's `deriveSimulationStatus()`/`updateStatus()` and
 * trigger-trace-drawer.js's rendering work identically for a production result with zero special-
 * casing.
 */
export async function runProductionStreamEvent({
  event,
  triggers = [],
  actionRunner,
  cooldownTracker = null,
  cooldownConfigByTrigger = () => null,
  matchOptions = {},
  generation = 0,
  now = Date.now(),
  trace = null,
} = {}) {
  const context = PRODUCTION_CONTEXT;
  const effective = { ...PRODUCTION_EQUIVALENT_OPTIONS };

  const validation = validateStreamEvent(event);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues, event: null, matches: [], skipped: [], truncated: false, plans: [], planSkips: [], results: [], context, options: effective };
  }

  return runStreamEventPipeline({ context, effective, validatedEvent: validation.event, triggers, actionRunner, cooldownTracker, cooldownConfigByTrigger, matchOptions, generation, now, trace });
}
