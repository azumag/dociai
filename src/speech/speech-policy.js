const clampInteger = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
};

export function normalizeSpeechPolicy(policy = {}) {
  const overflow = ["drop-oldest", "drop-new", "replace-latest", "aggregate"].includes(policy.overflow)
    ? policy.overflow
    : "drop-oldest";
  return {
    maxPending: clampInteger(policy.maxPending, 50, 1, 1000),
    maxPendingPerSource: clampInteger(policy.maxPendingPerSource, 20, 1, 1000),
    maxAgeMs: clampInteger(policy.maxAgeMs, 120_000, 1000, 86_400_000),
    maxHistory: clampInteger(policy.maxHistory, 50, 0, 1000),
    overflow,
    expireWhileHeld: policy.expireWhileHeld !== false,
    aggregate: typeof policy.aggregate === "function" ? policy.aggregate : null,
  };
}
