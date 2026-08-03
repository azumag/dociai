#!/usr/bin/env node
// verify-artifact.mjs (#72): packaged/unpacked artifactの中身をscanし、開発資産・secret・
// .env・GGUFモデル・source mapなどが混入していないことと、build-info.json/licenses.jsonが
// 存在すること、userData/models相当のdirectoryがapp resourcesに無いことを確認する。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

// issue #267: collect-native.mjs synthesizes a node_modules/onnxruntime-common/ nesting inside
// the collected onnxruntime-node package (required for Node's normal module resolution to find
// it at runtime — see electron/main/native/onnxruntime-node-shim.cjs). This is the one
// intentional, narrowly-scoped exception to the node_modules ban above; it must not broaden into
// a general node_modules allowance (see this file's own module comment for why that ban exists).
const NATIVE_NODE_MODULES_EXEMPTION = /^native\/onnxruntime-node\/[^/]+-[^/]+\/package\/node_modules\/onnxruntime-common(\/|$)/;

export function classifyRelativePath(relativePath) {
  const normalized = relativePath.split(/[\\/]/).filter(Boolean).join("/");
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1] ?? relativePath;
  const exemptNodeModules = NATIVE_NODE_MODULES_EXEMPTION.test(normalized);
  for (const segment of segments.slice(0, -1)) {
    if (segment === "node_modules" && exemptNodeModules) continue;
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

const NATIVE_BINARY_EXTENSIONS = new Set([".node", ".dylib", ".dll"]);

function isNativeBinaryPath(relPath) {
  return NATIVE_BINARY_EXTENSIONS.has(path.extname(relPath));
}

// issue #267: collect-native.mjs always emits exactly one <platform>-<arch> directory under
// native/onnxruntime-node/ (a manifest-only {supported:false} entry when no upstream binary
// exists for that target, e.g. darwin/x64 today) and after-pack.mjs prunes every other target's
// directory before packaging. "Absent entirely" must always fail, on every arch, forever — no
// hardcoded arch exemption here (a prior version of this check special-cased darwin-x64, which
// would have kept silently passing even if a future onnxruntime-node release added real
// darwin/x64 support and collection then regressed).
export async function verifyNativeOnnxruntimeLayout(resourcesDir, buildInfo) {
  const problems = [];
  const nativeRoot = path.join(resourcesDir, "native", "onnxruntime-node");
  let entries;
  try {
    entries = await fsp.readdir(nativeRoot, { withFileTypes: true });
  } catch {
    problems.push(`native/onnxruntime-node/ is missing under ${resourcesDir}`);
    return problems;
  }
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length !== 1) {
    problems.push(`expected exactly one arch directory under native/onnxruntime-node/, found ${dirs.length}${dirs.length ? `: ${dirs.map((d) => d.name).join(", ")}` : ""}`);
    return problems;
  }
  const dirName = dirs[0].name;
  const expectedDirName = `${buildInfo?.platform}-${buildInfo?.arch}`;
  if (dirName !== expectedDirName) problems.push(`native/onnxruntime-node/${dirName} does not match build-info.json's platform/arch (expected ${expectedDirName})`);
  const archDir = path.join(nativeRoot, dirName);

  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(archDir, "manifest.json"), "utf8"));
  } catch (error) {
    problems.push(`native/onnxruntime-node/${dirName}/manifest.json is missing or unparsable: ${error instanceof Error ? error.message : String(error)}`);
    return problems;
  }

  if (!manifest.supported) {
    const siblingEntries = await fsp.readdir(archDir);
    const extra = siblingEntries.filter((name) => name !== "manifest.json");
    if (extra.length) problems.push(`native/onnxruntime-node/${dirName}/ is marked unsupported but contains unexpected entries: ${extra.join(", ")}`);
    return problems;
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  // 「files[]が空/欠落」は以下のfor文をゼロ回で通り抜け、walkDirectoryもpackage/自体が
  // 存在しなければENOENTを[]へ握りつぶす — package/がまるごと欠落した収集失敗を、この関数が
  // 検出すべき本来の対象そのものなのに素通りさせてしまう (issue #267 review指摘)。
  if (!files.length || !files.some((file) => isNativeBinaryPath(file.path))) {
    problems.push(`native/onnxruntime-node/${dirName}/manifest.json is marked supported but lists no native binary file — package/ may be entirely missing or the collection produced an empty manifest`);
    return problems;
  }

  const packageRoot = path.join(archDir, "package");
  const onDisk = new Set(await walkDirectory(packageRoot, ""));
  const listed = new Set();
  for (const file of files) {
    listed.add(file.path);
    let stat;
    try {
      stat = await fsp.stat(path.join(packageRoot, file.path));
    } catch {
      problems.push(`native/onnxruntime-node/${dirName}/package/${file.path} is listed in manifest.json but missing on disk`);
      continue;
    }
    if (isNativeBinaryPath(file.path)) {
      // codesign/signtool rewrite native binaries in place during signing (typically growing
      // them), so an exact-size match would false-fail on signed artifacts — a non-zero,
      // not-shrunk floor still catches a truncated/corrupted copy.
      if (stat.size <= 0 || stat.size < file.size) problems.push(`native/onnxruntime-node/${dirName}/package/${file.path} is smaller than the collected size (${stat.size} < ${file.size} bytes) — possibly truncated`);
    } else if (stat.size !== file.size) {
      problems.push(`native/onnxruntime-node/${dirName}/package/${file.path} size mismatch (expected ${file.size}, found ${stat.size})`);
    }
  }
  for (const relPath of onDisk) {
    if (!listed.has(relPath)) problems.push(`native/onnxruntime-node/${dirName}/package/${relPath} exists on disk but is not listed in manifest.json`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
  if (result.hasBuildInfo) {
    const buildInfo = JSON.parse(await fsp.readFile(path.join(resourcesDir, "build-info.json"), "utf8"));
    failures.push(...(await verifyNativeOnnxruntimeLayout(resourcesDir, buildInfo)));
  }

  if (failures.length) {
    console.error(`FAIL | verify-artifact | ${resourcesDir}`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS | verify-artifact | ${result.fileCount} file(s) scanned under ${resourcesDir}, 0 forbidden, build-info.json + licenses.json present, no models/userData leakage`);
  }
}
