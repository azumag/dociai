import type { RequestContext } from "../../shared/services/service-contract";
import type { ServiceErrorCode, ServiceErrorShape } from "../../shared/services/service-errors";

const STATUS_CODES: Record<number, ServiceErrorCode> = { 400: "BAD_REQUEST", 401: "AUTH", 403: "AUTH", 404: "BAD_REQUEST", 408: "TIMEOUT", 409: "CONFLICT", 429: "RATE_LIMIT" };

export class ServiceError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: ServiceErrorCode, message: string, readonly options: { serviceId?: string; status?: number; retryAfterMs?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "ServiceError";
    this.retryable = options.retryable ?? ["RATE_LIMIT", "TIMEOUT", "NETWORK", "SERVER", "UNAVAILABLE"].includes(code);
  }
  toJSON(): ServiceErrorShape { return { code: this.code, message: this.message, serviceId: this.options.serviceId, status: this.options.status, retryAfterMs: this.options.retryAfterMs, retryable: this.retryable }; }
}

export function errorFromHttpStatus(status: number, options: { serviceId?: string; retryAfterMs?: number; message?: string } = {}): ServiceError {
  const code = STATUS_CODES[status] ?? (status >= 500 ? "SERVER" : "UNKNOWN");
  return new ServiceError(code, options.message ?? `HTTP ${status}`, { ...options, status });
}

export function normalizeServiceError(error: unknown, context?: Pick<RequestContext, "serviceId" | "signal">): ServiceError {
  if (error instanceof ServiceError) return error;
  if (context?.signal.aborted || (error instanceof Error && error.name === "AbortError")) return new ServiceError("CANCELLED", "request cancelled", { serviceId: context?.serviceId, retryable: false });
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") return errorFromHttpStatus(error.status, { serviceId: context?.serviceId, message: error instanceof Error ? error.message : undefined });
  if (error instanceof TypeError) return new ServiceError("NETWORK", "network request failed", { serviceId: context?.serviceId });
  return new ServiceError("UNKNOWN", "service request failed", { serviceId: context?.serviceId, retryable: false });
}

export function serviceErrorShape(error: unknown, context?: Pick<RequestContext, "serviceId" | "signal">): ServiceErrorShape { return normalizeServiceError(error, context).toJSON(); }
