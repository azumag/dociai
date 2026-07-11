import { TERMINAL_SPEECH_STATES } from "./speech-item.js";

const transitions = {
  waiting: new Set(["preparing", "speaking", "held", "dropped", "skipped", "cancelled", "failed", "done", "submitted"]),
  preparing: new Set(["speaking", "held", "skipped", "cancelled", "failed", "submitted"]),
  speaking: new Set(["held", "done", "skipped", "cancelled", "failed", "submitted"]),
  held: new Set(["waiting", "preparing", "speaking", "skipped", "cancelled", "failed"]),
};

export function transitionSpeechItem(item, nextState, { now = Date.now(), error = null, dropReason = null } = {}) {
  if (item.state === nextState) return item;
  if (TERMINAL_SPEECH_STATES.has(item.state) || !transitions[item.state]?.has(nextState)) {
    throw new Error(`Invalid speech state transition: ${item.state} -> ${nextState}`);
  }
  item.state = nextState;
  item.stateChangedAt = now;
  if (error != null) item.error = String(error);
  if (dropReason != null) item.dropReason = String(dropReason);
  return item;
}
