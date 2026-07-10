import fs from "node:fs";
import path from "node:path";

export type AppPaths = {
  userDataDir: string;
  configFile: string;
  configRepositoryFile: string;
  configBackupFile: string;
  secretsFile: string;
  secretsBackupFile: string;
  migrationLogFile: string;
  logsDir: string;
  modelsDir: string;
  cacheDir: string;
};

export function resolveAppPaths(userDataDir: string): AppPaths {
  return {
    userDataDir,
    configFile: path.join(userDataDir, "config.local.json"),
    configRepositoryFile: path.join(userDataDir, "config.json"),
    configBackupFile: path.join(userDataDir, "config.json.bak"),
    secretsFile: path.join(userDataDir, "secrets.enc.json"),
    secretsBackupFile: path.join(userDataDir, "secrets.enc.json.bak"),
    migrationLogFile: path.join(userDataDir, "migrations", "migration.log.jsonl"),
    logsDir: path.join(userDataDir, "logs"),
    modelsDir: path.join(userDataDir, "models"),
    cacheDir: path.join(userDataDir, "cache"),
  };
}

export function ensureAppPaths(paths: AppPaths): void {
  for (const directory of [paths.userDataDir, paths.logsDir, paths.modelsDir, paths.cacheDir, path.dirname(paths.migrationLogFile)]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}
