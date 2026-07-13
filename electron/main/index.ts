import fs from "node:fs/promises";
import path from "node:path";
import { app, desktopCapturer, dialog, globalShortcut, protocol, safeStorage, session } from "electron";
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
import { SpeechBackendService } from "./services/speech/speech-backend-service";
import { TwitchChatService } from "./services/twitch/twitch-chat-service";
import { TwitchComposition } from "./services/twitch/twitch-composition";
import { openAllowedExternalUrl } from "./security/navigation";
import { TWITCH_AUTH_EVENT_TYPE, TWITCH_CONNECTION_EVENT_TYPE, TWITCH_RECONNECT_DIAGNOSTIC_EVENT_TYPE, TWITCH_SUBSCRIPTIONS_EVENT_TYPE } from "../shared/twitch/overview-contract";
import { ShortcutService } from "./services/shortcut-service";
import { CaptureService } from "./services/capture/capture-service";
import { installDisplayMediaHandler } from "./services/capture/display-media-handler";
import { ModelRepository } from "./services/local-llm/models/model-repository";
import { resolveRuntimeLayout, readBuildInfo } from "./runtime-layout";
import { StreamEventBus } from "./services/stream-events/stream-event-bus";
import { STREAM_EVENT_APP_EVENT_TYPE } from "../shared/services/stream-event-ipc-contract";
import { UpdateService, type AutoUpdaterLike } from "./services/update/update-service";
import { UPDATE_APP_EVENT_TYPE } from "../shared/services/update-ipc-contract";

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
    const runtimeLayout = resolveRuntimeLayout({ isPackaged: app.isPackaged, appPath, resourcesPath: process.resourcesPath });
    const buildInfo = readBuildInfo(runtimeLayout.buildInfoFile);
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
    const speechService = new SpeechBackendService(fetch);
    const TwitchWebSocket = require("ws") as new (url: string) => { readyState?: number; send(data: string): void; close(): void; on(event: string, listener: (...args: any[]) => void): void };
    const twitchService = new TwitchChatService(TwitchWebSocket, (event) => controller?.emitToConsole(event.type, event.payload));
    const shortcutService = new ShortcutService(globalShortcut, (event) => controller?.emitToConsole("shortcut:status", event), (event) => controller?.emitToConsole("shortcut:trigger", event));
    const captureService = new CaptureService(desktopCapturer);
    const uninstallDisplayMediaHandler = installDisplayMediaHandler(session, captureService);
    // Single fan-out bus (#89) — every subscriber category (future Trigger engine per #91/#92,
    // console window, OBS window) observes the identical validated/deduped event. Trigger/UI/OBS
    // delivery for the two windows is wired here as ordinary bus subscribers, same shape as
    // aiService's "ai:token"/twitchService's own forwarding just above.
    const streamEventBus = new StreamEventBus();
    streamEventBus.subscribe((published) => controller?.emitToConsole(STREAM_EVENT_APP_EVENT_TYPE, published));
    streamEventBus.subscribe((published) => controller?.emitToObs(STREAM_EVENT_APP_EVENT_TYPE, published));
    // Auto-update is macOS-only for now (see update-service.ts's header comment) and only ever
    // makes sense for a packaged, real (non-"dev") build — a dev run has no `app-update.yml` and
    // nothing published for its own "version" to compare against. `electron-updater`'s `autoUpdater`
    // export is a lazy getter that constructs the real platform-specific updater singleton (which
    // throws outside a packaged app) the first time the `autoUpdater` binding is actually read —
    // `require("electron-updater")` alone (module evaluation) never touches it. Reached via
    // `require(...)` INSIDE this conditional, rather than a top-level `import { autoUpdater } from
    // "electron-updater"`, purely so the module is never even required/evaluated at all on a
    // dev/non-mac run (skips pulling in its dependency graph for a build that will never use it) —
    // not because a static import would itself trigger the getter, which it would not.
    const updateServiceEnabled = process.platform === "darwin" && app.isPackaged && buildInfo.channel !== "dev";
    const updateService = new UpdateService(
      updateServiceEnabled ? (require("electron-updater").autoUpdater as AutoUpdaterLike) : null,
      (state) => controller?.emitToConsole(UPDATE_APP_EVENT_TYPE, state),
      { allowPrerelease: buildInfo.channel === "beta" },
    );
    // No separate "shortly after launch" initial check here: the console window's own boot
    // sequence (src/app/boot.js's setupUpdateStatus()) already calls update.check() as soon as its
    // page loads — which, since index.html only ever loads into the console window, correlates
    // with an operator actually having the window open, unlike a bare startup timer. Confirmed live
    // (real packaged run): an initial 30s main-process timer running ALONGSIDE that renderer-driven
    // check fired two redundant checkForUpdates() calls seconds apart at every launch. The interval
    // below exists only to keep checking while a console window stays open without ever reloading
    // (a multi-hour stream is the normal case here).
    let updateCheckInterval: ReturnType<typeof setInterval> | null = null;
    if (updateService.enabled) updateCheckInterval = setInterval(() => void updateService.check(), 4 * 60 * 60 * 1000);
    // The native file dialog runs here, in Main, so the renderer only ever gets an opaque import
    // token back (electron/main/services/local-llm/models/local-import.ts) — it never learns or
    // chooses an arbitrary filesystem path itself.
    const chooseGgufFile = async (): Promise<string | null> => {
      const dialogOptions = { title: "Import GGUF Model", properties: ["openFile" as const], filters: [{ name: "GGUF Models", extensions: ["gguf"] }] };
      const activeWindow = controller?.getWindows().console;
      const result = activeWindow ? await dialog.showOpenDialog(activeWindow, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    };
    const modelRepository = new ModelRepository({
      modelsDir: paths.modelsDir,
      catalogFile: path.join(appPath, "resources/catalog/local-models.json"),
      chooseFile: chooseGgufFile,
      secretStore,
      emitDownloadProgress: (event) => controller?.emitToConsole("local-llm:download:progress", event),
    });
    // Reclassifies any download job an unclean shutdown left mid-flight into resumable/cleanup
    // candidates (#76) before any IPC request can observe a stale "downloading" job with no
    // active controller behind it.
    await modelRepository.initializeDownloads();
    const currentConfig = await configRepository.getPublic();
    shortcutService.sync((currentConfig.config.triggers ?? {}) as Record<string, unknown>);
    const screenCapture = object(object(currentConfig.config.context).screenCapture);
    captureService.setPreferredSourceName(screenCapture.sourceName);
    // Issue #94: constructs the real TwitchAuthCoordinator/ReconnectCoordinator/SubscriptionReconciler
    // graph (electron/main/services/twitch/twitch-composition.ts) — the first place #83-88's
    // Main-process services are wired into anything real. `TWITCH_CLIENT_ID` is a build/deploy-time
    // env var (a Device Code Grant public client id, not a secret — see twitch-composition.ts's own
    // doc comment); `config.twitch.{broadcasterUserId,enabledFeatures}` persist across restarts.
    const twitchOverviewConfig = object(currentConfig.config.twitch);
    const twitchBroadcasterUserId = typeof twitchOverviewConfig.broadcasterUserId === "string" && twitchOverviewConfig.broadcasterUserId ? twitchOverviewConfig.broadcasterUserId : null;
    const twitchEnabledFeatures = Array.isArray(twitchOverviewConfig.enabledFeatures)
      ? twitchOverviewConfig.enabledFeatures.filter((entry): entry is string => typeof entry === "string")
      : ["bits", "subscriptions", "redemptions"];
    const persistTwitchBroadcasterUserId = (broadcasterUserId: string): void => {
      void (async () => {
        try {
          const loaded = await configRepository.getPublic();
          const nextTwitch = { ...object(loaded.config.twitch), broadcasterUserId };
          await configRepository.save({ ...loaded.config, twitch: nextTwitch }, loaded.revision);
        } catch (error) {
          logError("twitch-broadcaster-persist", error);
        }
      })();
    };
    const twitchComposition = new TwitchComposition({
      clientId: process.env.TWITCH_CLIENT_ID ?? "",
      secretStore,
      broadcasterUserId: twitchBroadcasterUserId,
      enabledFeatures: twitchEnabledFeatures,
      socketFactory: TwitchWebSocket,
      openVerificationUri: (url) => openAllowedExternalUrl(url).then(() => ({ opened: true })),
      onAuthEvent: (overview) => controller?.emitToConsole(TWITCH_AUTH_EVENT_TYPE, overview),
      onConnectionEvent: (overview) => controller?.emitToConsole(TWITCH_CONNECTION_EVENT_TYPE, overview),
      onSubscriptionsEvent: (overview) => controller?.emitToConsole(TWITCH_SUBSCRIPTIONS_EVENT_TYPE, overview),
      onReconnectDiagnostic: (push) => controller?.emitToConsole(TWITCH_RECONNECT_DIAGNOSTIC_EVENT_TYPE, push),
      onBroadcasterConfirmed: persistTwitchBroadcasterUserId,
      // Issue #177: the EventSub notification -> normalizer -> StreamEvent bridge (twitch-
      // composition.ts's own EventSubToStreamEventBridge) publishes onto the SAME StreamEventBus
      // instance constructed above (line ~164) and already exposed to the Renderer over IPC — never
      // a second bus. A normalize failure is diagnosed (never silently dropped) via the SAME
      // console.error convention every other service in this file already uses.
      onStreamEvent: (event) => { streamEventBus.publish(event, "production"); },
      onEventSubDiagnostic: (diagnostic) => console.error(`[dociai:eventsub-bridge] notification not normalized`, diagnostic),
      log: (message, fields) => console.error(`[dociai:twitch-composition] ${message}`, fields ?? {}),
    });
    await twitchComposition.initialize();
    const unregisterIpcHandlers = registerIpcHandlers({ controller, paths, configRepository, secretStore, aiService, feedService, topicService, speechService, twitchService, twitchComposition, shortcutService, captureService, modelRepository, streamEventBus, updateService, buildInfo, devServerUrl });
    app.once("before-quit", unregisterIpcHandlers);
    app.once("before-quit", () => aiService.dispose());
    app.once("before-quit", () => feedService.dispose());
    app.once("before-quit", () => topicService.dispose());
    app.once("before-quit", () => speechService.dispose());
    app.once("before-quit", () => twitchService.dispose());
    app.once("before-quit", () => twitchComposition.dispose());
    app.once("before-quit", () => shortcutService.dispose());
    app.once("before-quit", () => { uninstallDisplayMediaHandler(); captureService.dispose(); });
    app.once("before-quit", () => modelRepository.dispose());
    app.once("before-quit", () => streamEventBus.dispose());
    app.once("before-quit", () => { if (updateCheckInterval) clearInterval(updateCheckInterval); updateService.dispose(); });
    controller.createConsoleWindow();
    app.on("activate", () => controller?.createConsoleWindow());
  }).catch((error) => { logError("startup", error); if (!quitting) app.quit(); });
}
