import type { RequestContext } from "../../shared/services/service-contract";
import type { ServiceErrorCode } from "../../shared/services/service-errors";
import { normalizeServiceError, ServiceError } from "./service-error";

export type RetryPolicy = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; jitterRatio?: number; retryableCodes?: ServiceErrorCode[] };
const DEFAULT_RETRYABLE: ServiceErrorCode[] = ["RATE_LIMIT", "TIMEOUT", "NETWORK", "SERVER", "UNAVAILABLE"];

export function retryDelay(error: ServiceError, attempt: number, policy: RetryPolicy, random = Math.random): number {
  if (error.options.retryAfterMs !== undefined) return Math.max(0, Math.min(policy.maxDelayMs, error.options.retryAfterMs));
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = policy.jitterRatio ?? 0;
  return Math.max(0, Math.round(base * (1 - jitter + (2 * jitter * random()))));
}

async function interruptibleDelay(ms: number, signal: AbortSignal, sleep: (ms: number, signal: AbortSignal) => Promise<void>): Promise<void> {
  if (signal.aborted) throw new ServiceError("CANCELLED", "request cancelled", { retryable: false });
  await sleep(ms, signal);
  if (signal.aborted) throw new ServiceError("CANCELLED", "request cancelled", { retryable: false });
}

export async function retryWithPolicy<T>(operation: (attempt: number) => Promise<T>, policy: RetryPolicy, context: RequestContext, options: { sleep?: (ms: number, signal: AbortSignal) => Promise<void>; random?: () => number } = {}): Promise<T> {
  const sleep = options.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new ServiceError("CANCELLED", "request cancelled", { retryable: false })); }, { once: true }); }));
  const retryable = policy.retryableCodes ?? DEFAULT_RETRYABLE;
  for (let attempt = 1; attempt <= Math.max(1, policy.maxAttempts); attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      const normalized = normalizeServiceError(error, context);
      if (normalized.code === "CANCELLED" || attempt >= policy.maxAttempts || !normalized.retryable || !retryable.includes(normalized.code)) throw normalized;
      await interruptibleDelay(retryDelay(normalized, attempt, policy, options.random), context.signal, sleep);
    }
  }
  throw new ServiceError("UNKNOWN", "retry policy exhausted", { serviceId: context.serviceId, retryable: false });
}
