import fs from "node:fs";
import path from "node:path";

export type AppPaths = {
  userDataDir: string;
  configFile: string;
  secretsFile: string;
  logsDir: string;
  modelsDir: string;
  cacheDir: string;
};

export function resolveAppPaths(userDataDir: string): AppPaths {
  return {
    userDataDir,
    configFile: path.join(userDataDir, "config.local.json"),
    secretsFile: path.join(userDataDir, "secrets.json"),
    logsDir: path.join(userDataDir, "logs"),
    modelsDir: path.join(userDataDir, "models"),
    cacheDir: path.join(userDataDir, "cache"),
  };
}

export function ensureAppPaths(paths: AppPaths): void {
  for (const directory of [paths.userDataDir, paths.logsDir, paths.modelsDir, paths.cacheDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}
