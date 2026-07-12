// パッケージ工程(#72)がresourcesへ埋め込むbuild metadataの形。Main/Renderer両方で読む。
export type BuildInfo = {
  version: string;
  gitSha: string;
  buildTime: string;
  channel: string;
  platform: string;
  arch: string;
};

export const UNKNOWN_BUILD_INFO: BuildInfo = {
  version: "0.0.0-dev",
  gitSha: "unknown",
  buildTime: "",
  channel: "dev",
  platform: "unknown",
  arch: "unknown",
};
