import type { BuildInfo } from "./build-info";

export type Runtime = "browser" | "electron";

export type PlatformInfo = {
  runtime: Runtime;
  platform: string;
  arch: string;
  appVersion: string;
  isPackaged: boolean;
  buildInfo: BuildInfo;
};
