import { PublicIpcError } from "../../shared/errors";
import type { SecretKey } from "../../shared/secret-contract";

export function parseSecretKey(value: unknown): SecretKey {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new PublicIpcError("INVALID_INPUT", "secret keyが不正です");
  return value as SecretKey;
}
