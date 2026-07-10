import fs from "node:fs/promises";
import path from "node:path";

const SECRET_PATTERNS = [
  /\b(?:sk|gho|ghp|oauth|or)-[A-Za-z0-9_.-]{6,}\b/g,
  /\bBearer\s+[A-Za-z0-9_.-]+/gi,
];
const JSON_SECRET = /("(?:apiKey|token|access_token|refresh_token|client_secret)"\s*:\s*")[^"]+("?)/gi;

export function redactSecrets(value, secrets = []) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  for (const secret of secrets.filter(Boolean)) text = text.split(String(secret)).join("[REDACTED]");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  text = text.replace(JSON_SECRET, "$1[REDACTED]$2");
  return text;
}

export async function writeFailureArtifact(directory, name, value, options = {}) {
  const safeName = String(name).replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!safeName || safeName.startsWith(".")) throw new Error("artifact name is invalid");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, safeName);
  await fs.writeFile(file, redactSecrets(value, options.secrets), { encoding: "utf8", mode: 0o600 });
  return file;
}

export async function persistArtifacts(sourceDirectory, destinationDirectory) {
  const source = path.resolve(sourceDirectory);
  const destination = path.resolve(destinationDirectory);
  if (source === destination || destination.startsWith(`${source}${path.sep}`)) {
    throw new Error("artifact destination must be outside the temporary source directory");
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
  return destination;
}
