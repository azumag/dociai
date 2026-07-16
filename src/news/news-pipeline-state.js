// ニュースpipelineのstate machine (issue #187)。
// 実際の遷移はNewsPipelineCoordinatorが行う。ここでは許可されたedgeを1箇所にまとめ、
// 後続issueでstageを追加・差し替えるときに無効な遷移を静かに作り込まないための
// ドキュメント兼assertionとして提供する。
//
//   idle -> acquiring -> selecting -> researching|generating -> generating -> validating
//        -> delivering -> committed
//   任意stage -> cancelled
//   任意stage -> failed_retryable | failed_permanent
//   selecting -> no_candidate
//   validating -> rewriting -> validating

export const PIPELINE_STATES = Object.freeze([
  "idle",
  "acquiring",
  "selecting",
  "researching",
  "generating",
  "validating",
  "rewriting",
  "delivering",
  "committed",
  "no_candidate",
  "cancelled",
  "failed_retryable",
  "failed_permanent",
]);

const TERMINAL_STATES = new Set(["committed", "no_candidate", "cancelled", "failed_retryable", "failed_permanent"]);

const TRANSITIONS = Object.freeze({
  idle: new Set(["acquiring"]),
  acquiring: new Set(["selecting", "cancelled", "failed_retryable", "failed_permanent"]),
  selecting: new Set(["researching", "generating", "no_candidate", "cancelled", "failed_retryable", "failed_permanent"]),
  researching: new Set(["generating", "cancelled", "failed_retryable", "failed_permanent"]),
  generating: new Set(["validating", "cancelled", "failed_retryable", "failed_permanent"]),
  validating: new Set(["delivering", "rewriting", "cancelled", "failed_retryable", "failed_permanent"]),
  rewriting: new Set(["validating", "cancelled", "failed_retryable", "failed_permanent"]),
  delivering: new Set(["committed", "cancelled", "failed_retryable", "failed_permanent"]),
  committed: new Set(),
  no_candidate: new Set(),
  cancelled: new Set(),
  failed_retryable: new Set(),
  failed_permanent: new Set(),
});

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.has(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error(`invalid news pipeline transition: ${from} -> ${to}`);
  return to;
}
