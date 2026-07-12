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

export default async function afterPack(context) {
  const resourcesDir = await resolveResourcesDir(context.appOutDir);
  await correctBuildInfoPlatformArch(resourcesDir, context.electronPlatformName, archName(context.arch));
}
