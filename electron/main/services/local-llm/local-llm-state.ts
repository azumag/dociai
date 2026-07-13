// Pure state shape + transition guard for LocalLlmService's state machine (#45). Framework-free —
// mirrors electron/main/services/twitch/eventsub/eventsub-state.ts's role for that state machine:
// only local-llm-service.ts is allowed to actually drive transitions, but the transition table
// itself lives here so it (and every rejection) is independently testable.
import type { LocalLlmState, LocalLlmStatus } from "../../../shared/local-llm/contract";

/** Implements the exact transition table given in the issue body. Note this is deliberately NOT
 * "from === to is always allowed" (unlike eventsub-state.ts's canTransitionSessionState) — only
 * `unavailable -> unavailable` is a listed self-loop; every other status must move to a genuinely
 * different one. A caller wanting to re-enter "loading"/"ready" while already there (e.g. a
 * redundant load() call) is a BUSY/programming-error case for local-llm-service.ts to reject
 * before ever attempting the transition, not something this table silently allows. */
export const LOCAL_LLM_STATE_TRANSITIONS: Readonly<Record<LocalLlmStatus, readonly LocalLlmStatus[]>> = Object.freeze({
  unavailable: ["unavailable"],
  idle: ["loading"],
  loading: ["ready", "idle", "error"],
  ready: ["generating", "unloading", "loading"],
  generating: ["ready", "error", "unloading"],
  unloading: ["idle", "error"],
  error: ["idle", "loading", "unavailable"],
});

export function canTransitionLocalLlmState(from: LocalLlmStatus, to: LocalLlmStatus): boolean {
  return LOCAL_LLM_STATE_TRANSITIONS[from].includes(to);
}

/** Thrown (never silently swallowed — issue: "不正遷移はprogramming errorとして検出し、黙って状態を
 * 書き換えない") whenever local-llm-service.ts attempts a transition outside the table above. */
export class InvalidLocalLlmTransitionError extends Error {
  constructor(readonly from: LocalLlmStatus, readonly to: LocalLlmStatus) {
    super(`invalid LocalLlmService state transition: ${from} -> ${to}`);
    this.name = "InvalidLocalLlmTransitionError";
  }
}

export function assertLocalLlmTransition(from: LocalLlmStatus, to: LocalLlmStatus): void {
  if (!canTransitionLocalLlmState(from, to)) throw new InvalidLocalLlmTransitionError(from, to);
}

export function initialLocalLlmState(): LocalLlmState {
  return { status: "idle" };
}
