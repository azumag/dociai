export type PublicErrorCode =
  | "INVALID_INPUT"
  | "FORBIDDEN"
  | "CONFIG_CONFLICT"
  | "NOT_FOUND"
  | "NOT_IMPLEMENTED"
  | "INTERNAL_ERROR";

export type PublicError = {
  code: PublicErrorCode;
  message: string;
  retryable: boolean;
};

export class PublicIpcError extends Error {
  constructor(public readonly code: PublicErrorCode, message: string, public readonly retryable = false) {
    super(message);
  }
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof PublicIpcError) return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: "INTERNAL_ERROR", message: "内部処理に失敗しました", retryable: false };
}
