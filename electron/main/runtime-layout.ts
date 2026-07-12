// Main processが自身のrun-time modeを解決するhook (#72)。
// dev: `electron dist/electron/main.cjs`で直接起動 (app.isPackaged === false)。build-info.jsonはappPath直下。
// packaged: electron-builderで固めたapp (--dirのunpackedも含む。isPackaged的には同じ layout)。
//   build-info.jsonとnative moduleのhook dir (#50)はapp.asar外、resourcesPath直下に置く。
import fs from "node:fs";
import path from "node:path";
import type { BuildInfo } from "../shared/build-info";
import { UNKNOWN_BUILD_INFO } from "../shared/build-info";

export type RuntimeMode = "dev" | "packaged";

export type RuntimeLayoutInput = {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
};

export type RuntimeLayout = {
  mode: RuntimeMode;
  buildInfoFile: string;
  nativeDir: string | null;
};

export function resolveRuntimeLayout(input: RuntimeLayoutInput): RuntimeLayout {
  if (input.isPackaged) {
    return {
      mode: "packaged",
      buildInfoFile: path.join(input.resourcesPath, "build-info.json"),
      nativeDir: path.join(input.resourcesPath, "native"),
    };
  }
  return {
    mode: "dev",
    buildInfoFile: path.join(input.appPath, "build-info.json"),
    nativeDir: null,
  };
}

function isBuildInfoShape(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBuildInfo(raw: Record<string, unknown>): BuildInfo {
  const str = (value: unknown, fallback: string): string => (typeof value === "string" && value.length > 0 ? value : fallback);
  return {
    version: str(raw.version, UNKNOWN_BUILD_INFO.version),
    gitSha: str(raw.gitSha, UNKNOWN_BUILD_INFO.gitSha),
    buildTime: str(raw.buildTime, UNKNOWN_BUILD_INFO.buildTime),
    channel: str(raw.channel, UNKNOWN_BUILD_INFO.channel),
    platform: str(raw.platform, process.platform),
    arch: str(raw.arch, process.arch),
  };
}

export function readBuildInfo(buildInfoFile: string): BuildInfo {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(buildInfoFile, "utf8"));
    if (isBuildInfoShape(parsed)) return normalizeBuildInfo(parsed);
  } catch {
    // build-info.jsonが無い/壊れている場合は既知のfallbackへ。起動を止めない。
  }
  return { ...UNKNOWN_BUILD_INFO, platform: process.platform, arch: process.arch };
}
