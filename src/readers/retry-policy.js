const RETRYABLE = new Set(["timeout", "network", "server", "rate_limit", "empty"]);

export function retryDecision(error, { attempts, now = Date.now(), maxAttempts = 3, initialDelayMs = 30_000, maxDelayMs = 15 * 60_000 } = {}) {
  const kind = String(error?.kind ?? error?.code ?? "unknown").toLowerCase();
  if (!RETRYABLE.has(kind) || attempts >= maxAttempts) return { action: "permanent", reason: kind };

  // ConnectorError.retryAfter は秒、Electron bridge の retryAfterMs はミリ秒。
  const retryAfterMs = error?.retryAfterMs != null ? Number(error.retryAfterMs) : Number(error?.retryAfter) * 1000;
  const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempts - 1));
  return { action: "retry", reason: kind, nextRetryAt: now + delayMs };
}
