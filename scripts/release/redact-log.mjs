#!/usr/bin/env node
// redact-log.mjs (#74): CI失敗診断log/artifactを公開する前に、指定した環境変数名の値を
// signing-credentials.mjsのredactSecrets()で一括除去する。release.ymlのpublish jobが失敗時に
// これを使い、diagnostics化するlogに万一secret相当の値が紛れ込んでいてもartifact化する前に
// 伏字にする(#73のredactSecrets再利用 — scrubロジックをここで新しく作らない)。
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { redactSecrets } from "./signing-credentials.mjs";

export async function redactLogFile(filePath, secretEnvVarNames, env = process.env) {
  const secrets = secretEnvVarNames.map((name) => env[name]).filter((value) => typeof value === "string" && value.length > 0);
  const original = await fs.readFile(filePath, "utf8");
  const redacted = redactSecrets(original, secrets);
  await fs.writeFile(filePath, redacted, "utf8");
  return { redactedCount: secrets.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [filePath, ...envVarNames] = process.argv.slice(2);
  if (!filePath) {
    console.error("Usage: node scripts/release/redact-log.mjs <logFile> [SECRET_ENV_VAR_NAME...]");
    process.exit(2);
  }
  // The caller invokes this on `if: failure()`, which fires for a job failure at any step —
  // including ones that happen before the log file this scrubs would have been written.
  if (
    await fs.access(filePath).then(
      () => false,
      () => true,
    )
  ) {
    console.log(`SKIP | redact-log | ${filePath} does not exist (job failed before it was written)`);
    process.exit(0);
  }
  const result = await redactLogFile(filePath, envVarNames);
  console.log(`PASS | redact-log | ${filePath} scrubbed against ${result.redactedCount} secret value(s)`);
}
