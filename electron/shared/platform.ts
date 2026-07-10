export type Runtime = "browser" | "electron";

export type PlatformInfo = {
  runtime: Runtime;
  platform: string;
  arch: string;
  appVersion: string;
  isPackaged: boolean;
};
