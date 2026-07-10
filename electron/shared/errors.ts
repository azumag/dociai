export type PublicErrorCode =
  | "INVALID_INPUT"
  | "FORBIDDEN"
  | "CONFIG_CONFLICT"
  | "NOT_FOUND"
  | "NOT_IMPLEMENTED"
  | "INTERNAL_ERROR"
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "NETWORK"
  | "SERVER"
  | "BAD_REQUEST"
  | "UNAVAILABLE"
  | "CANCELLED"
  | "CONFLICT"
  | "UNKNOWN"
  | "EMPTY";

export type PublicError = {
  code: PublicErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

export class PublicIpcError extends Error {
  constructor(public readonly code: PublicErrorCode, message: string, public readonly retryable = false) {
    super(message);
  }
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof PublicIpcError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error && typeof error === "object" && "code" in error && "retryable" in error && typeof error.code === "string" && typeof error.retryable === "boolean") {
    const codes = new Set<PublicErrorCode>(["AUTH", "RATE_LIMIT", "TIMEOUT", "NETWORK", "SERVER", "BAD_REQUEST", "UNAVAILABLE", "CANCELLED", "CONFLICT", "UNKNOWN", "EMPTY"]);
    if (codes.has(error.code as PublicErrorCode)) {
      const candidate = error as { code: PublicErrorCode; message?: unknown; retryable: boolean; options?: { retryAfterMs?: unknown } };
      const retryAfterMs = typeof candidate.options?.retryAfterMs === "number" ? candidate.options.retryAfterMs : undefined;
      return { code: candidate.code, message: typeof candidate.message === "string" ? candidate.message : "サービス処理に失敗しました", retryable: candidate.retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    }
  }
  return { code: "INTERNAL_ERROR", message: "内部処理に失敗しました", retryable: false };
}
