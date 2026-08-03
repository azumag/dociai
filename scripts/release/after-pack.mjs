// electron-builder afterPack hook (#72).
// build/generated/build-info.json is generated once by scripts/electron/build.mjs, before
// packaging, and copied into every target via electron-builder.yml's extraResources. Its
// platform/arch reflect the *build host* at generation time. When a single host cross-builds
// multiple targets (e.g. this repo's mac target list is [arm64, x64], commonly built from one
// CI runner), that value is wrong for every target that doesn't match the host. This hook
// rewrites the already-packaged build-info.json with the actual per-target platform/arch that
// electron-builder just packaged, so BuildInfo always matches the artifact it ships inside.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveResourcesDir } from "./verify-artifact.mjs";

const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

export function archName(arch) {
  return ARCH_NAMES[arch] ?? String(arch);
}

export async function correctBuildInfoPlatformArch(resourcesDir, platform, arch) {
  const buildInfoFile = path.join(resourcesDir, "build-info.json");
  let buildInfo;
  try {
    buildInfo = JSON.parse(await fs.readFile(buildInfoFile, "utf8"));
  } catch {
    return { updated: false, reason: "build-info.json missing or unreadable" };
  }
  if (buildInfo.platform === platform && buildInfo.arch === arch) return { updated: false, reason: "already correct" };
  const corrected = { ...buildInfo, platform, arch };
  await fs.writeFile(buildInfoFile, `${JSON.stringify(corrected, null, 2)}\n`, "utf8");
  return { updated: true, buildInfo: corrected };
}

// issue #267: scripts/electron/collect-native.mjs collects EVERY electron-builder-declared
// target (e.g. darwin-arm64 + darwin-x64 + win32-x64) into one shared build/native/onnxruntime-node/
// tree, because a single mac host cross-builds arm64+x64 in one `electron:package` run (same
// build/native/ input, packaged into multiple targets). Each packaged target must only ship its
// own arch's copy — this prunes every non-matching directory. The matching directory (even a
// manifest-only {supported:false} one, e.g. darwin-x64) must survive; its absence means
// collect-native.mjs failed to emit a manifest for a declared target, which verify-artifact.mjs's
// own "exactly one arch dir must exist" rule is specifically designed to also catch — this throw
// is a second, earlier gate against the same class of collection regression.
export async function pruneNativeOnnxruntimeDirs(resourcesDir, platform, arch) {
  const nativeDir = path.join(resourcesDir, "native", "onnxruntime-node");
  let entries;
  try {
    entries = await fs.readdir(nativeDir, { withFileTypes: true });
  } catch {
    // electron:package[:dir]が常にcollect-native.mjsを先に走らせる (package.json) ため、
    // 正常経路ではここが無い状態は起き得ない — 無言でスキップすると、issue #267がまさに
    // 解決しようとした「収集が失敗しても誰も気づかない」を、この検証層自身で再現して
    // しまう (review指摘)。electron-builderのafterPackフックがthrowすればpackaging自体が
    // 失敗し、CI/ローカルどちらでも即座に気づける。
    throw new Error(`after-pack: native/onnxruntime-node/ is missing under ${resourcesDir} — collect-native.mjs must run (via "npm run electron:package"/"electron:package:dir") before electron-builder packages the app`);
  }
  const keepName = `${platform}-${arch}`;
  const pruned = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepName) continue;
    await fs.rm(path.join(nativeDir, entry.name), { recursive: true, force: true });
    pruned.push(entry.name);
  }
  const stillPresent = await fs
    .stat(path.join(nativeDir, keepName))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (!stillPresent) {
    throw new Error(`after-pack: native/onnxruntime-node/${keepName} is missing after pruning — collect-native.mjs must emit a directory (manifest-only if unsupported) for every declared target`);
  }
  return { pruned, keptDirName: keepName, present: true };
}

export default async function afterPack(context) {
  const resourcesDir = await resolveResourcesDir(context.appOutDir);
  await correctBuildInfoPlatformArch(resourcesDir, context.electronPlatformName, archName(context.arch));
  await pruneNativeOnnxruntimeDirs(resourcesDir, context.electronPlatformName, archName(context.arch));
}
