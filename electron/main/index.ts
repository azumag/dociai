import fs from "node:fs/promises";
import path from "node:path";
import { app, protocol, safeStorage } from "electron";
import { ensureAppPaths, resolveAppPaths } from "./paths";
import { createWindowController } from "./windows";
import { ConfigRepository } from "./config/config-repository";
import { SafeStorageSecretStore } from "./secrets/safe-storage-secret-store";
import { parseSecretKey } from "./secrets/secret-keys";
import { AiService } from "./services/ai/ai-service";
import { FeedService } from "./services/feeds/feed-service";
import { TopicService } from "./services/topics/topic-service";
import { installCspPolicy, securityHeaders } from "./security/csp";
import { installPermissionPolicy } from "./security/permissions";
import { registerIpcHandlers } from "./ipc/register";

protocol.registerSchemesAsPrivileged([{
  scheme: "dociai",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }

function moveConnectorSecrets(config: JsonRecord): { publicConfig: JsonRecord; secretEntries: Array<{ key: string; value: string }> } {
  const publicConfig = structuredClone(config);
  const connectors = object(publicConfig.connectors);
  const secretEntries: Array<{ key: string; value: string }> = [];
  for (const [id, value] of Object.entries(connectors)) {
    const connector = object(value);
    if (typeof connector.apiKey === "string" && connector.apiKey) {
      const key = `connectors.${id}.apiKey`;
      secretEntries.push({ key, value: connector.apiKey });
      delete connector.apiKey;
      connector.apiKeyConfigured = true;
      connector.apiKeySecretRef = key;
    }
    connectors[id] = connector;
  }
  publicConfig.connectors = connectors;
  const topics = object(publicConfig.topics);
  const sources = Array.isArray(topics.sources) ? topics.sources : [];
  topics.sources = sources.map((value, index) => {
    const source = object(value);
    if (typeof source.token === "string" && source.token) {
      const key = `topics.sources.${index}.token`;
      secretEntries.push({ key, value: source.token });
      delete source.token;
      source.tokenConfigured = true;
      source.tokenSecretRef = key;
    }
    return source;
  });
  if ("topics" in publicConfig) publicConfig.topics = topics;
  return { publicConfig, secretEntries };
}

async function readJsonRecord(file: string): Promise<JsonRecord | null> {
  try { return object(JSON.parse(await fs.readFile(file, "utf8"))); } catch { return null; }
}

async function exists(file: string): Promise<boolean> { return fs.access(file).then(() => true).catch(() => false); }

async function writePublicConfig(file: string, config: JsonRecord): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
}

async function seedAiConnectorConfig(configRepository: ConfigRepository, secretStore: SafeStorageSecretStore, paths: ReturnType<typeof resolveAppPaths>, appPath: string): Promise<string> {
  const source = await exists(paths.configFile) ? paths.configFile : path.join(appPath, "config.local.example.json");
  const raw = await readJsonRecord(source);
  if (!raw) return source;
  const migrated = moveConnectorSecrets(raw);
  // Mainへ移管済みの資格情報だけをsafeStorageへ移し、次のサービス移管までは他の値を触らない。
  for (const entry of migrated.secretEntries) await secretStore.set(parseSecretKey(entry.key), entry.value);
  const current = await configRepository.getPublic();
  if (!await exists(paths.configRepositoryFile) || !("news" in current.config) || !("topics" in current.config)) {
    const config = { ...current.config, schemaVersion: raw.schemaVersion ?? 1, connectors: migrated.publicConfig.connectors ?? {}, ...(migrated.publicConfig.news === undefined ? {} : { news: migrated.publicConfig.news }), ...(migrated.publicConfig.topics === undefined ? {} : { topics: migrated.publicConfig.topics }) };
    await configRepository.save(config, current.revision);
  }
  if (source === paths.configFile && migrated.secretEntries.length) await writePublicConfig(source, migrated.publicConfig);
  return source;
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  let controller: ReturnType<typeof createWindowController> | null = null;
  let quitting = false;
  const logError = (label: string, error: unknown) => console.error(`[dociai:${label}]`, error instanceof Error ? error.stack ?? error.message : String(error));
  process.on("uncaughtException", (error) => logError("uncaught-exception", error));
  process.on("unhandledRejection", (error) => logError("unhandled-rejection", error));

  app.on("second-instance", () => controller?.focusConsole());
  app.on("before-quit", () => { quitting = true; controller?.dispose(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

  app.whenReady().then(async () => {
    const paths = resolveAppPaths(app.getPath("userData"));
    ensureAppPaths(paths);
    const appPath = app.getAppPath();
    const devServerUrl = process.env.DOCIAI_DEV_SERVER_URL;
    const configRepository = new ConfigRepository(paths);
    const secretStore = new SafeStorageSecretStore(safeStorage, paths.secretsFile, paths.secretsBackupFile);
    const rendererConfigSource = await seedAiConnectorConfig(configRepository, secretStore, paths, appPath);
    installCspPolicy(devServerUrl);
    installPermissionPolicy(devServerUrl);

    if (!devServerUrl) {
      await protocol.handle("dociai", async (request) => {
        const requestUrl = new URL(request.url);
        const headers = securityHeaders(devServerUrl);
        if (requestUrl.hostname !== "app") return new Response("Not found", { status: 404, headers });
        const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
        if (relativePath === "config.local.json") {
          if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });
          const raw = await readJsonRecord(rendererConfigSource);
          if (!raw) return new Response("Not found", { status: 404, headers });
          const body = Buffer.from(`${JSON.stringify(moveConnectorSecrets(raw).publicConfig, null, 2)}\n`);
          return new Response(body, { headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
        }
        const candidate = path.resolve(appPath, relativePath);
        if (candidate !== appPath && !candidate.startsWith(`${appPath}${path.sep}`)) return new Response("Forbidden", { status: 403, headers });
        try {
          const body = await fs.readFile(candidate);
          const contentType = relativePath.endsWith(".html") ? "text/html; charset=utf-8" : relativePath.endsWith(".js") ? "text/javascript; charset=utf-8" : relativePath.endsWith(".css") ? "text/css; charset=utf-8" : relativePath.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream";
          return new Response(body, { headers: { ...headers, "Content-Type": contentType, "Cache-Control": "no-store" } });
        } catch {
          return new Response("Not found", { status: 404, headers });
        }
      });
    }

    controller = createWindowController({ appPath, preloadPath: path.join(appPath, "preload.cjs"), paths, devServerUrl, isPackaged: app.isPackaged });
    const aiService = new AiService(configRepository, secretStore, fetch, (event) => controller?.emitToConsole("ai:token", event));
    const feedService = new FeedService(configRepository);
    const topicService = new TopicService(configRepository, secretStore);
    const unregisterIpcHandlers = registerIpcHandlers({ controller, paths, configRepository, secretStore, aiService, feedService, topicService, devServerUrl });
    app.once("before-quit", unregisterIpcHandlers);
    app.once("before-quit", () => aiService.dispose());
    app.once("before-quit", () => feedService.dispose());
    app.once("before-quit", () => topicService.dispose());
    controller.createConsoleWindow();
    app.on("activate", () => controller?.createConsoleWindow());
  }).catch((error) => { logError("startup", error); if (!quitting) app.quit(); });
}
