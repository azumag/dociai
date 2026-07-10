export type ServiceErrorCode = "AUTH" | "RATE_LIMIT" | "TIMEOUT" | "NETWORK" | "SERVER" | "BAD_REQUEST" | "UNAVAILABLE" | "CANCELLED" | "CONFLICT" | "UNKNOWN" | "EMPTY";

export type ServiceErrorShape = {
  code: ServiceErrorCode;
  message: string;
  serviceId?: string;
  status?: number;
  retryAfterMs?: number;
  retryable: boolean;
};
