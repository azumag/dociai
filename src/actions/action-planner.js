// Issue #93: turns one #91 MatchResult (a trigger that matched a StreamEvent) plus that trigger's
// own configured actions into a list of ActionPlans — pure, synchronous, no I/O, no side effects.
// Deliberately does NOT decide whether a plan may actually run (that is action-runner.js's job,
// re-checked immediately before execution per this issue's own "an event could be queued for a
// while and go stale" requirement) — this module only builds the plan objects themselves.
import { DEFAULT_ACTION_PRIORITY, buildActionPlanId, validateActionConfig } from "./action-schema.js";

/** Safety cap mirroring event-trigger-matcher.js's own `DEFAULT_MAX_MATCHES_PER_EVENT` — bounds how
 * many actions a single matched trigger may fan out into for one event, protecting against a
 * misconfigured trigger with a huge `actions` array producing an unbounded burst of plans. */
export const DEFAULT_MAX_ACTIONS_PER_TRIGGER = 5;

/**
 * Builds one ActionPlan per valid entry in `actions` (in array order), stamping each with a stable
 * id from `(event.id, triggerId, actionIndex)` (action-schema.js's `buildActionPlanId`) and the
 * `generation` captured by the CALLER at planning time (mirrors
 * src/app/response-coordinator.js's own `const generation = this.getGeneration()` — captured once,
 * threaded through, re-checked against the CURRENT generation only later at execution time so a
 * plan that goes stale while queued is caught by action-runner.js, not silently re-validated here).
 *
 * An invalid action config (fails action-schema.js's validateActionConfig) is skipped, never thrown
 * — recorded in `skipped` with its issues, same "collect + continue" style as
 * event-trigger-matcher.js's own skipped-with-reason list.
 *
 * Returns `{ plans, skipped, truncated }`.
 */
export function planActions({
  event,
  triggerId,
  actions = [],
  priority = DEFAULT_ACTION_PRIORITY,
  context = "production",
  generation = 0,
  maxActionsPerTrigger = DEFAULT_MAX_ACTIONS_PER_TRIGGER,
  now = Date.now(),
} = {}) {
  const plans = [];
  const skipped = [];
  const list = Array.isArray(actions) ? actions : [];
  let truncated = false;

  list.forEach((action, actionIndex) => {
    if (plans.length >= maxActionsPerTrigger) {
      truncated = true;
      skipped.push({ actionIndex, reason: "max-actions-per-trigger-reached" });
      return;
    }
    const validation = validateActionConfig(action);
    if (!validation.ok) {
      skipped.push({ actionIndex, reason: "invalid-action-config", issues: validation.issues });
      return;
    }
    const id = buildActionPlanId(event?.id, triggerId, actionIndex);
    plans.push(
      Object.freeze({
        id,
        eventId: event?.id ?? null,
        triggerId: triggerId ?? null,
        actionIndex,
        kind: action.kind,
        action: Object.freeze({ ...action }),
        event,
        priority: typeof action.priority === "number" ? action.priority : priority,
        context,
        generation,
        createdAt: now,
      }),
    );
  });

  return { plans, skipped, truncated };
}
