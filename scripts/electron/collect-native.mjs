// collect-native.mjs (issue #267): onnxruntime-nodeのネイティブバイナリを、electron-builder.yml
// extraResources (build/native -> <resources>/native) 経由で同梱するため node_modules から
// build/native/onnxruntime-node/ へ収集する。electron-builder.yml が node_modules 全体を
// パッケージから除外する設計 (#72) のため、native binaryだけをこの別経路で運ぶ。
//
// 収集先はビルドホスト自身の process.platform/process.arch ではなく、electron-builder.yml が
// 宣言する全ターゲット (runtime-layout.mjs の SUPPORTED_TARGETS) ぶん — 1ホストでmac
// arm64+x64を同時にcross-buildするため (electron-builder.yml参照)、宣言済みターゲットを
// 列挙して対応可否を判定する。対応するprebuiltバイナリが無いターゲット (現状darwin/x64) にも
// 必ずディレクトリとmanifest.jsonを作り、{supported:false, reason} を明示する —
// ディレクトリを丸ごと欠落させると、after-pack.mjsのprune後に「対象archのdirが存在しない」
// 状態になり、verify-artifact.mjsが本物の収集漏れと区別できなくなる (issue #267 review指摘)。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SUPPORTED_TARGETS } from "../release/runtime-layout.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

export const PACKAGE_NAME = "onnxruntime-node";
export const DEPENDENCY_NAME = "onnxruntime-common";
const STRIP_SUFFIXES = [".map", ".d.ts"];

export function shouldStrip(fileName) {
  return STRIP_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// srcRoot配下を再帰的にdestRootへコピーする。*.map/*.d.tsは除外し、コピー直後にsha256で
// 転写ミス (途中で壊れた0バイトファイル等) を検知する。戻り値はdestRoot相対のposixパス。
export async function copyFilteredTree(srcRoot, destRoot) {
  const files = [];
  async function walk(relDir) {
    const entries = await fs.readdir(path.join(srcRoot, relDir), { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(rel);
        continue;
      }
      if (shouldStrip(entry.name)) continue;
      const srcPath = path.join(srcRoot, rel);
      const destPath = path.join(destRoot, rel);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
      const [srcHash, destHash] = await Promise.all([sha256File(srcPath), sha256File(destPath)]);
      if (srcHash !== destHash) throw new Error(`collect-native: copy integrity check failed for ${rel} (source hash != destination hash)`);
      const stat = await fs.stat(destPath);
      files.push({ path: rel, size: stat.size });
    }
  }
  await walk("");
  return files;
}

// dist/cjs/package.json ({"type":"commonjs"}) のような、ESM/CJS二重公開のための下位marker
// package.json (name フィールドを持たない) に引っかからないよう、name一致まで遡る
// (onnxruntime-common で実際に踏んだ罠 — dist/cjs/ 配下で止まり、dist/ を1階層余分に
// 数えて実体を見失っていた)。
async function packageRootFromEntry(entryFile, expectedName) {
  let dir = path.dirname(entryFile);
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (await fileExists(candidate)) {
      const pkg = JSON.parse(await fs.readFile(candidate, "utf8"));
      if (pkg.name === expectedName) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`collect-native: could not locate a package.json named "${expectedName}" above ${entryFile}`);
    dir = parent;
  }
}

// @huggingface/transformers自身の視点からrequire.resolveすることで、hoisting/バージョンずれが
// 将来起きても、transformers.jsが実際に読み込むのと同じ実体を収集する (#267 review指摘)。
// onnxruntime-commonはonnxruntime-node自身の依存であってtransformersの直接依存ではないため、
// onnxruntime-nodeのpackageスコープから改めてresolveする。
export async function resolveUpstreamPackages(rootDir = repoRoot) {
  const repoRequire = createRequire(path.join(rootDir, "package.json"));
  const transformersEntry = repoRequire.resolve("@huggingface/transformers");
  const transformersRequire = createRequire(transformersEntry);
  const onnxruntimeNodeEntry = transformersRequire.resolve(PACKAGE_NAME);
  const onnxruntimeNodeDir = await packageRootFromEntry(onnxruntimeNodeEntry, PACKAGE_NAME);
  const onnxruntimeNodeRequire = createRequire(path.join(onnxruntimeNodeDir, "package.json"));
  const onnxruntimeCommonEntry = onnxruntimeNodeRequire.resolve(DEPENDENCY_NAME);
  const onnxruntimeCommonDir = await packageRootFromEntry(onnxruntimeCommonEntry, DEPENDENCY_NAME);
  return { onnxruntimeNodeDir, onnxruntimeCommonDir };
}

// 1ターゲット (platform/arch) ぶんを収集する。srcにprebuiltバイナリが無ければ
// {supported:false} のmanifestだけを書く。戻り値はmanifest本体 (テスト用に純粋寄りにしている
// — 実際のディレクトリ操作はfsを介して行うが、呼び出し側だけがrepoRoot/SUPPORTED_TARGETSに
// 依存する構成)。
export async function collectTarget({ target, archRoot, onnxruntimeNodeDir, onnxruntimeCommonDir, licenseSrc, now = () => new Date() }) {
  await fs.rm(archRoot, { recursive: true, force: true });
  await fs.mkdir(archRoot, { recursive: true });
  const pkgJson = JSON.parse(await fs.readFile(path.join(onnxruntimeNodeDir, "package.json"), "utf8"));
  const version = pkgJson.version;
  const binDir = path.join(onnxruntimeNodeDir, "bin/napi-v6", target.platform, target.arch);
  const supported = await fileExists(binDir);

  if (!supported) {
    const manifest = {
      formatVersion: 1,
      package: PACKAGE_NAME,
      version,
      platform: target.platform,
      arch: target.arch,
      supported: false,
      reason: `${PACKAGE_NAME}@${version} ships no ${target.platform}/${target.arch} binary`,
      collectedAt: now().toISOString(),
    };
    await fs.writeFile(path.join(archRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  const packageDestRoot = path.join(archRoot, "package");
  const files = [];

  await fs.mkdir(packageDestRoot, { recursive: true });
  await fs.copyFile(path.join(onnxruntimeNodeDir, "package.json"), path.join(packageDestRoot, "package.json"));
  files.push({ path: "package.json", size: (await fs.stat(path.join(packageDestRoot, "package.json"))).size });

  for (const entry of await copyFilteredTree(path.join(onnxruntimeNodeDir, "dist"), path.join(packageDestRoot, "dist"))) {
    files.push({ path: `dist/${entry.path}`, size: entry.size });
  }

  // dist/binding.js は自身のファイル位置から相対で
  // `../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node` を require
  // する — その相対構造を保つため、対象platform/archのサブフォルダだけを同じ相対位置へ置く。
  const binRelBase = `bin/napi-v6/${target.platform}/${target.arch}`;
  for (const entry of await copyFilteredTree(binDir, path.join(packageDestRoot, binRelBase))) {
    files.push({ path: `${binRelBase}/${entry.path}`, size: entry.size });
  }

  await fs.copyFile(licenseSrc, path.join(packageDestRoot, "LICENSE.txt"));
  files.push({ path: "LICENSE.txt", size: (await fs.stat(path.join(packageDestRoot, "LICENSE.txt"))).size });

  // onnxruntime-commonはonnxruntime-node自身のnode_modulesには実在せずhoistされているが、
  // dist/index.jsの `require("onnxruntime-common")` (bare specifier) がpackage/node_modules/
  // 配下から解決できるよう、収集先ではnestedな配置を合成する (#267 review指摘: 実測でロード
  // 可能なことを確認済み)。
  const dependencyDestRoot = path.join(packageDestRoot, "node_modules", DEPENDENCY_NAME);
  await fs.mkdir(dependencyDestRoot, { recursive: true });
  await fs.copyFile(path.join(onnxruntimeCommonDir, "package.json"), path.join(dependencyDestRoot, "package.json"));
  files.push({ path: `node_modules/${DEPENDENCY_NAME}/package.json`, size: (await fs.stat(path.join(dependencyDestRoot, "package.json"))).size });
  for (const entry of await copyFilteredTree(path.join(onnxruntimeCommonDir, "dist"), path.join(dependencyDestRoot, "dist"))) {
    files.push({ path: `node_modules/${DEPENDENCY_NAME}/dist/${entry.path}`, size: entry.size });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    formatVersion: 1,
    package: PACKAGE_NAME,
    version,
    platform: target.platform,
    arch: target.arch,
    supported: true,
    collectedAt: now().toISOString(),
    files,
  };
  await fs.writeFile(path.join(archRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

// rootDirは出力先だけを制御する (テストが実repoのbuild/native/を汚さず一時dirへ書けるように)。
// パッケージ解決とlicenseテキストの取得元は常に実repoRoot固定 — 実node_modulesとlicenseは
// 1つしか存在せず、それらまでrootDirで差し替える意味は無い。
export async function collectAll({ rootDir = repoRoot, targets = SUPPORTED_TARGETS, log = console.log } = {}) {
  const nativeRoot = path.join(rootDir, "build/native/onnxruntime-node");
  // 自身のsubtreeだけを消す (#50のnode-llama-cpp向けsubtreeが将来同じbuild/native/配下に
  // 同居する想定のため、build/native全体は触らない)。バージョンを跨いで古いバイナリが
  // 残り続けるのを防ぐ (issue #267 review指摘)。
  await fs.rm(nativeRoot, { recursive: true, force: true });
  const { onnxruntimeNodeDir, onnxruntimeCommonDir } = await resolveUpstreamPackages(repoRoot);
  const licenseSrc = path.join(repoRoot, "scripts/electron/native-licenses/onnxruntime-LICENSE.txt");

  const results = [];
  for (const target of targets) {
    const dirName = `${target.platform}-${target.arch}`;
    const archRoot = path.join(nativeRoot, dirName);
    const manifest = await collectTarget({ target, archRoot, onnxruntimeNodeDir, onnxruntimeCommonDir, licenseSrc });
    results.push(manifest);
    if (manifest.supported) {
      log(`OK   | collect-native | ${dirName}: collected ${manifest.files.length} file(s) from ${PACKAGE_NAME}@${manifest.version}`);
    } else {
      log(`SKIP | collect-native | ${dirName}: ${manifest.reason}`);
    }
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await collectAll();
}
