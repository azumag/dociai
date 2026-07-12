#!/usr/bin/env node
// verify-artifact.mjs (#72): packaged/unpacked artifactの中身をscanし、開発資産・secret・
// .env・GGUFモデル・source mapなどが混入していないことと、build-info.json/licenses.jsonが
// 存在すること、userData/models相当のdirectoryがapp resourcesに無いことを確認する。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { listPackage } from "@electron/asar";

// basenameの完全一致で弾くもの。開発中に生成される実体だけを対象にし、
// config.local.example.json のようなtemplateは対象外 (完全一致なので誤検知しない)。
export const FORBIDDEN_EXACT_NAMES = new Set([
  ".env",
  "config.local.json",
  "config.json",
  "config.json.bak",
  "secrets.enc.json",
  "secrets.enc.json.bak",
  "window-state.json",
  "migration.log.jsonl",
  ".DS_Store",
  ".npmrc",
]);

export const FORBIDDEN_NAME_PATTERNS = [
  { pattern: /^\.env\..+$/i, reason: "environment file (.env.*)" },
  { pattern: /\.gguf$/i, reason: "model weights (GGUF)" },
  { pattern: /\.ggml$/i, reason: "model weights (GGML)" },
  { pattern: /\.map$/i, reason: "source map" },
  { pattern: /\.pem$/i, reason: "private key / certificate" },
  { pattern: /\.p12$/i, reason: "code-signing certificate" },
  { pattern: /\.pfx$/i, reason: "code-signing certificate" },
  { pattern: /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i, reason: "SSH key" },
  { pattern: /credentials?\.json$/i, reason: "credentials file" },
];

const FORBIDDEN_PATH_SEGMENTS = new Set([".git", "node_modules"]);

export function classifyRelativePath(relativePath) {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  const basename = segments[segments.length - 1] ?? relativePath;
  for (const segment of segments.slice(0, -1)) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) return { forbidden: true, reason: `forbidden directory: ${segment}/` };
  }
  if (FORBIDDEN_EXACT_NAMES.has(basename)) return { forbidden: true, reason: `forbidden file: ${basename}` };
  for (const { pattern, reason } of FORBIDDEN_NAME_PATTERNS) {
    if (pattern.test(basename)) return { forbidden: true, reason };
  }
  return { forbidden: false };
}

export function scanRelativePaths(relativePaths) {
  const violations = [];
  for (const relativePath of relativePaths) {
    const result = classifyRelativePath(relativePath);
    if (result.forbidden) violations.push({ path: relativePath, reason: result.reason });
  }
  return violations;
}

export function hasModelsOrUserDataDir(relativePaths) {
  return relativePaths.some((relativePath) => {
    const segments = relativePath.split(/[\\/]/).filter(Boolean);
    return segments.includes("models") || segments.includes("userData");
  });
}

async function walkDirectory(root, prefix) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walkDirectory(path.join(root, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

export async function listResourceFiles(resourcesDir) {
  let entries;
  try {
    entries = await fsp.readdir(resourcesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name === "app.asar") continue; // scanned separately via listAsarFiles
    if (entry.isDirectory()) files.push(...(await walkDirectory(path.join(resourcesDir, entry.name), entry.name)));
    else files.push(entry.name);
  }
  return files;
}

export function listAsarFiles(asarPath) {
  if (!fs.existsSync(asarPath)) return [];
  return listPackage(asarPath).map((entry) => `app.asar/${entry.replace(/^\/+/, "")}`);
}

export async function resolveResourcesDir(rootPath) {
  if (fs.existsSync(path.join(rootPath, "app.asar"))) return rootPath;
  const macCandidate = path.join(rootPath, "Contents", "Resources");
  if (fs.existsSync(path.join(macCandidate, "app.asar"))) return macCandidate;
  const winCandidate = path.join(rootPath, "resources");
  if (fs.existsSync(path.join(winCandidate, "app.asar"))) return winCandidate;
  if (fs.existsSync(rootPath) && fs.statSync(rootPath).isDirectory()) {
    const appBundle = fs.readdirSync(rootPath).find((name) => name.endsWith(".app"));
    if (appBundle) return resolveResourcesDir(path.join(rootPath, appBundle));
  }
  return rootPath;
}

export async function verifyArtifactTree(resourcesDir) {
  const resourceFiles = await listResourceFiles(resourcesDir);
  const asarPath = path.join(resourcesDir, "app.asar");
  const asarFiles = listAsarFiles(asarPath);
  const allPaths = [...resourceFiles, ...asarFiles];
  const violations = scanRelativePaths(allPaths);
  return {
    resourcesDir,
    fileCount: allPaths.length,
    violations,
    hasAsar: fs.existsSync(asarPath),
    hasBuildInfo: fs.existsSync(path.join(resourcesDir, "build-info.json")),
    hasLicenses: fs.existsSync(path.join(resourcesDir, "licenses.json")),
    hasModelsOrUserDataDir: hasModelsOrUserDataDir(allPaths),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/release/verify-artifact.mjs <artifact-root>");
    process.exit(2);
  }
  const resourcesDir = await resolveResourcesDir(path.resolve(target));
  const result = await verifyArtifactTree(resourcesDir);
  const failures = [];
  if (!result.hasAsar) failures.push(`app.asar not found under ${resourcesDir}`);
  if (result.violations.length) failures.push(`${result.violations.length} forbidden file(s): ${result.violations.map((v) => `${v.path} (${v.reason})`).join(", ")}`);
  if (!result.hasBuildInfo) failures.push("build-info.json missing from app resources");
  if (!result.hasLicenses) failures.push("licenses.json missing from app resources");
  if (result.hasModelsOrUserDataDir) failures.push("a models/ or userData/ directory was found inside app resources; those must live outside the app bundle");

  if (failures.length) {
    console.error(`FAIL | verify-artifact | ${resourcesDir}`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS | verify-artifact | ${result.fileCount} file(s) scanned under ${resourcesDir}, 0 forbidden, build-info.json + licenses.json present, no models/userData leakage`);
  }
}
