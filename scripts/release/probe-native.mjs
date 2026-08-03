#!/usr/bin/env node
// probe-native.mjs (issue #267): a plain-Node (no Electron runtime needed) load-proof for the
// onnxruntime-node binary collect-native.mjs bundled into a packaged artifact. Complements
// scripts/release/smoke-packaged.mjs's in-Electron probe (which only runs on macOS CI today) —
// this script is mandatory in the Windows CI job, where win32-x64 is the *only* electron-builder
// target (see electron-builder.yml), so a single plain-Node run on the windows-latest x64 runner
// is full coverage of every shipped Windows arch, not partial. Also run against both macOS
// artifacts as a cheap extra gate: arm64 gets a second, Electron-independent load-proof; x64
// deterministically exercises the {supported:false} manifest-only path that the arm64-only mac
// CI runner's own process.arch can never reach.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveResourcesDir } from "./verify-artifact.mjs";

const require = createRequire(import.meta.url);

export async function readNativeManifest(resourcesDir) {
  const nativeRoot = path.join(resourcesDir, "native", "onnxruntime-node");
  const entries = await fs.readdir(nativeRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length !== 1) throw new Error(`expected exactly one arch directory under native/onnxruntime-node/, found ${dirs.length}: ${dirs.map((d) => d.name).join(", ") || "(none)"}`);
  const archDir = path.join(nativeRoot, dirs[0].name);
  const manifest = JSON.parse(await fs.readFile(path.join(archDir, "manifest.json"), "utf8"));
  return { archDirName: dirs[0].name, archDir, manifest };
}

// 常に本物のrequire()を試みる — manifest.supportedを鵜呑みにして早期returnすると、
// 「manifestの自己申告をmanifest自身と比較する」だけの同語反復チェックになってしまう
// (issue #267 review指摘)。unsupportedなターゲットでもpackage/自体が存在しない以上
// require()は自然に失敗するはずで、それを実際に確認することが検証の本体になる。
export function probeCollectedBinary(archDir) {
  try {
    const onnxruntimeNode = require(path.join(archDir, "package"));
    return { ok: true, version: onnxruntimeNode.env?.versions?.node ?? "unknown" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/release/probe-native.mjs <artifact-root>");
    process.exit(2);
  }
  const resourcesDir = await resolveResourcesDir(path.resolve(target));
  const { archDirName, archDir, manifest } = await readNativeManifest(resourcesDir);
  const probe = probeCollectedBinary(archDir);

  if (manifest.supported) {
    if (!probe.ok) {
      console.error(`FAIL | probe-native | ${archDirName}: manifest claims supported, but require() failed: ${probe.reason}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS | probe-native | ${archDirName}: onnxruntime-node@${probe.version} loaded successfully`);
    }
  } else {
    // probe.reasonはNodeの生のMODULE_NOT_FOUND文言 (probe-native.mjsはshim経由せずpackage/を
    // 直接requireするため) であり、shim/manifestが持つ人間可読なmanifest.reasonとは文面が
    // 一致しない — 一致を要求するのではなく、「package/自体が実在しない」ことを独立に
    // 確認することで、manifestの自己申告ではなく実ファイルの状態を検証する。
    const packageDirExists = await fs.access(path.join(archDir, "package")).then(() => true).catch(() => false);
    if (probe.ok || packageDirExists) {
      console.error(`FAIL | probe-native | ${archDirName}: manifest claims unsupported (${manifest.reason}), but ${probe.ok ? `require() unexpectedly succeeded (version ${probe.version})` : "a package/ directory unexpectedly exists on disk"}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS | probe-native | ${archDirName}: unsupported target correctly reported — no package/ directory exists and require() genuinely fails (manifest reason: ${manifest.reason})`);
    }
  }
}
