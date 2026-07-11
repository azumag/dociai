export function shouldRunHealthCheck(provider, { allowPaid = false, force = false } = {}) {
  if (!provider) return { allowed: false, reason: "missing-provider" };
  if (provider.paid && !allowPaid) return { allowed: false, reason: "paid-check" };
  if (provider.enabled === false && !force) return { allowed: false, reason: "disabled" };
  return { allowed: true };
}

export function limitConcurrency(value, fallback = 3) { return Math.max(1, Math.min(16, Number.isSafeInteger(value) ? value : fallback)); }
