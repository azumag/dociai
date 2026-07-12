// BuildInfo(version/SHA/build time/channel/platform/arch)の計算とresourcesへの書き出し (#72)。
// electron:build (dev/unpacked)とelectron:package (electron-builderのextraResources)の両方から呼ばれる、
// 唯一のsource of truth。electron/main/runtime-layout.tsが実行時に読む形式と一致させる。
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export async function readPackageJson(repoRoot) {
  const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
  return JSON.parse(raw);
}

export function resolveGitSha(repoRoot, env = process.env) {
  if (env.DOCIAI_BUILD_GIT_SHA) return env.DOCIAI_BUILD_GIT_SHA;
  if (env.GITHUB_SHA) return env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function resolveChannel(env = process.env) {
  const channel = env.DOCIAI_RELEASE_CHANNEL?.trim();
  return channel && channel.length > 0 ? channel : "dev";
}

export function resolveBuildTime(env = process.env, now = () => new Date()) {
  if (env.DOCIAI_BUILD_TIME) return env.DOCIAI_BUILD_TIME;
  return now().toISOString();
}

// version/gitSha/buildTime/channelは呼び出し側から明示的に渡す (テスト容易性のため副作用を分離)。
export function computeBuildInfo({ version, gitSha, buildTime, channel, platform = process.platform, arch = process.arch }) {
  if (!version) throw new Error("version is required");
  if (!gitSha) throw new Error("gitSha is required");
  if (!buildTime) throw new Error("buildTime is required");
  if (!channel) throw new Error("channel is required");
  return { version, gitSha, buildTime, channel, platform, arch };
}

export async function resolveBuildInfoForRepo(repoRoot, env = process.env) {
  const pkg = await readPackageJson(repoRoot);
  return computeBuildInfo({
    version: pkg.version ?? "0.0.0-unknown",
    gitSha: resolveGitSha(repoRoot, env),
    buildTime: resolveBuildTime(env),
    channel: resolveChannel(env),
  });
}

export async function writeBuildInfo(filePath, buildInfo) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
}
