import fs from "node:fs/promises";
import { PublicIpcError } from "../../shared/errors";

const SECRET_FIELDS = new Set(["apiKey", "token", "accessToken", "refreshToken", "clientSecret", "client_secret"]);

export type LegacyImportPreview = {
  config: Record<string, unknown>;
  secretEntries: Array<{ key: string; value: string }>;
  source: string;
};

function walk(value: unknown, path: string[], secrets: LegacyImportPreview["secretEntries"]): unknown {
  if (Array.isArray(value)) return value.map((item, index) => walk(item, [...path, String(index)], secrets));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key) && typeof nested === "string" && nested.length > 0) {
      const secretKey = path.concat(key).join(".");
      secrets.push({ key: secretKey, value: nested });
      output[`${key}Configured`] = true;
      output[`${key}SecretRef`] = secretKey;
    } else {
      output[key] = walk(nested, [...path, key], secrets);
    }
  }
  return output;
}

export async function previewLegacyConfig(file: string): Promise<LegacyImportPreview> {
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(file, "utf8")); }
  catch { throw new PublicIpcError("NOT_FOUND", "legacy configが見つからないか、JSONとして読めません"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PublicIpcError("INVALID_INPUT", "legacy configのrootはobjectで指定してください");
  const secretEntries: LegacyImportPreview["secretEntries"] = [];
  return { config: walk(parsed, [], secretEntries) as Record<string, unknown>, secretEntries, source: file };
}
