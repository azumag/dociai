#!/usr/bin/env node
// print-runtime-layout.mjs (#72): dev/unpacked/packagedそれぞれで解決されるpathをdebug表示する。
// Usage: node scripts/release/print-runtime-layout.mjs [--mode dev|unpacked|packaged] [--platform darwin|win32] [--arch arm64|x64] [--output-root <dir>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveLayout } from "./runtime-layout.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

function exists(candidate) {
  if (!candidate) return false;
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

function readJsonIfPresent(file) {
  if (!exists(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return "<unreadable>";
  }
}

export function formatLayout(mode, layout) {
  const lines = [`[${mode}]`];
  for (const [key, value] of Object.entries(layout)) {
    if (key === "mode") continue;
    const status = value ? (exists(value) ? "exists" : "missing") : "n/a";
    lines.push(`  ${key.padEnd(14)} ${value ?? "(n/a)"}  (${status})`);
  }
  const buildInfo = readJsonIfPresent(layout.buildInfoFile);
  if (buildInfo) lines.push(`  buildInfo      ${JSON.stringify(buildInfo)}`);
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const platform = argValue("platform") ?? process.platform;
  const arch = argValue("arch") ?? process.arch;
  const outputRoot = argValue("output-root");
  const requestedMode = argValue("mode");
  const modes = requestedMode ? [requestedMode] : ["dev", "unpacked", "packaged"];

  for (const mode of modes) {
    try {
      const layout = resolveLayout({ mode, repoRoot, platform, arch, outputRoot });
      console.log(formatLayout(mode, layout));
    } catch (error) {
      console.log(`[${mode}] ${error.message}`);
    }
    console.log("");
  }
}
