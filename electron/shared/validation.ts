import { PublicIpcError } from "./errors";

const MAX_JSON_CHARS = 256_000;
const SECRET_KEYS = new Set(["apiKey", "token", "access_token", "refresh_token", "client_secret", "authorization"]);

export function expectNoInput(input: unknown): void {
  if (input !== undefined && input !== null) throw new PublicIpcError("INVALID_INPUT", "このIPCは引数を受け取りません");
}

export function expectRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PublicIpcError("INVALID_INPUT", `${label}はobjectで指定してください`);
  if (JSON.stringify(input).length > MAX_JSON_CHARS) throw new PublicIpcError("INVALID_INPUT", `${label}が大きすぎます`);
  return input as Record<string, unknown>;
}

export function expectString(input: unknown, label: string, maxLength = 256): string {
  if (typeof input !== "string" || input.length === 0 || input.length > maxLength) throw new PublicIpcError("INVALID_INPUT", `${label}が不正です`);
  return input;
}

export function expectExternalHttpsUrl(input: unknown): URL {
  const value = expectString(input, "URL", 2_048);
  let url: URL;
  try { url = new URL(value); } catch { throw new PublicIpcError("INVALID_INPUT", "URLが不正です"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new PublicIpcError("FORBIDDEN", "HTTPSの標準ポート以外の外部URLは開けません");
  return url;
}

export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, SECRET_KEYS.has(key) ? "[configured]" : redactConfig(nested)]));
}
