import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../shared/ipc-channels";
import { toPublicError, PublicIpcError } from "../../shared/errors";
import type { Result, ShowItemKind, WindowRole } from "../../shared/ipc-contract";
import { expectExternalHttpsUrl, expectNoInput, expectRecord, expectString } from "../../shared/validation";
import { assertTrustedSender } from "./guard";
import { getWindowRole } from "../window-roles";
import { openAllowedExternalUrl } from "../security/navigation";
import type { AppPaths } from "../paths";
import { ConfigRepository } from "../config/config-repository";
import type { SecretStore } from "../../shared/secret-contract";
import { parseSecretKey } from "../secrets/secret-keys";
import { AiService } from "../services/ai/ai-service";
import type { AiChatInput, AiMessage } from "../../shared/services/ai-contract";
import { FeedService } from "../services/feeds/feed-service";
import { TopicService } from "../services/topics/topic-service";
import type { FeedFetchInput } from "../../shared/services/feed-contract";
import type { SpeechBackendService } from "../services/speech/speech-backend-service";
import type { TwitchChatService } from "../services/twitch/twitch-chat-service";
import type { ShortcutService } from "../services/shortcut-service";
import type { CaptureService } from "../services/capture/capture-service";
import type { BuildInfo } from "../../shared/build-info";
import type { ModelRepository } from "../services/local-llm/models/model-repository";
import type { DownloadStartInput, ModelLicense } from "../../shared/local-llm/model-contract";
import type { StreamEventBus } from "../services/stream-events/stream-event-bus";
import type { TwitchComposition } from "../services/twitch/twitch-composition";

type WindowController = ReturnType<typeof import("../windows").createWindowController>;
type RegisterOptions = { controller: WindowController; paths: AppPaths; configRepository: ConfigRepository; secretStore: SecretStore; aiService: AiService; feedService: FeedService; topicService: TopicService; speechService: SpeechBackendService; twitchService: TwitchChatService; twitchComposition: TwitchComposition; shortcutService: ShortcutService; captureService: CaptureService; modelRepository: ModelRepository; streamEventBus: StreamEventBus; buildInfo: BuildInfo; devServerUrl?: string };
type Handler<T> = (event: IpcMainInvokeEvent, input: unknown) => Promise<T> | T;

function parseAiMessages(value: unknown): AiMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new PublicIpcError("INVALID_INPUT", "messagesは1〜64件の配列で指定してください");
  return value.map((raw) => {
    const message = expectRecord(raw, "AI message");
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") throw new PublicIpcError("INVALID_INPUT", "message roleが不正です");
    if (!("content" in message)) throw new PublicIpcError("INVALID_INPUT", "message contentが必要です");
    return { role: message.role, content: message.content };
  });
}

function requestMetadata(payload: Record<string, unknown>): Pick<FeedFetchInput, "requestId" | "generation" | "ownerId"> {
  return {
    ...(typeof payload.requestId === "string" ? { requestId: payload.requestId } : {}),
    ...(typeof payload.generation === "number" && Number.isSafeInteger(payload.generation) ? { generation: payload.generation } : {}),
    ...(typeof payload.ownerId === "string" ? { ownerId: payload.ownerId } : {}),
  };
}

function parseOptionalFeatures(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  const payload = expectRecord(input, "Twitch auth request");
  if (payload.features === undefined) return undefined;
  if (!Array.isArray(payload.features) || payload.features.length > 16 || !payload.features.every((entry) => typeof entry === "string")) throw new PublicIpcError("INVALID_INPUT", "featuresは文字列配列で指定してください");
  return payload.features as string[];
}

function sourceIndex(payload: Record<string, unknown>): number {
  if (typeof payload.sourceIndex !== "number" || !Number.isSafeInteger(payload.sourceIndex) || payload.sourceIndex < 0 || payload.sourceIndex > 1_000) throw new PublicIpcError("INVALID_INPUT", "sourceIndexが不正です");
  return payload.sourceIndex;
}

function parseModelLicense(value: unknown): ModelLicense {
  const record = expectRecord(value, "license");
  if (typeof record.id !== "string" || !record.id) throw new PublicIpcError("INVALID_INPUT", "license.idが必要です");
  if (typeof record.name !== "string" || !record.name) throw new PublicIpcError("INVALID_INPUT", "license.nameが必要です");
  if (record.url !== undefined && typeof record.url !== "string") throw new PublicIpcError("INVALID_INPUT", "license.urlが不正です");
  return { id: record.id, name: record.name, ...(typeof record.url === "string" ? { url: record.url } : {}) };
}

function parseDownloadStartInput(value: unknown): DownloadStartInput {
  const payload = expectRecord(value, "download start");
  const licenseAccepted = payload.licenseAccepted === true;
  if (payload.kind === "catalog") {
    return { kind: "catalog", catalogModelId: expectString(payload.catalogModelId, "catalogModelId", 256), licenseAccepted };
  }
  if (payload.kind === "huggingface") {
    if (typeof payload.expectedSizeBytes !== "number" || !Number.isFinite(payload.expectedSizeBytes) || payload.expectedSizeBytes <= 0) throw new PublicIpcError("INVALID_INPUT", "expectedSizeBytesが不正です");
    if (payload.expectedSha256 !== undefined && typeof payload.expectedSha256 !== "string") throw new PublicIpcError("INVALID_INPUT", "expectedSha256が不正です");
    return {
      kind: "huggingface",
      repo: expectString(payload.repo, "repo", 256),
      revision: expectString(payload.revision, "revision", 256),
      filename: expectString(payload.filename, "filename", 256),
      displayName: expectString(payload.displayName, "displayName", 256),
      expectedSizeBytes: payload.expectedSizeBytes,
      ...(typeof payload.expectedSha256 === "string" ? { expectedSha256: payload.expectedSha256 } : {}),
      license: parseModelLicense(payload.license),
      licenseAccepted,
    };
  }
  throw new PublicIpcError("INVALID_INPUT", "download start kindが不正です");
}

function register<T>(channel: string, handler: Handler<T>, options: RegisterOptions, roles: WindowRole[] = ["console"]): void {
  ipcMain.handle(channel, async (event, input): Promise<Result<T>> => {
    try {
      assertTrustedSender(event, options.devServerUrl, roles);
      return { ok: true, value: await handler(event, input) };
    } catch (error) {
      return { ok: false, error: toPublicError(error) };
    }
  });
}

export function registerIpcHandlers(options: RegisterOptions): () => void {
  register(CHANNELS.PLATFORM_GET_INFO, (event, input) => {
    expectNoInput(input);
    return { runtime: "electron", platform: process.platform, arch: process.arch, appVersion: require("electron").app.getVersion(), isPackaged: require("electron").app.isPackaged, buildInfo: options.buildInfo };
  }, options);
  register(CHANNELS.CONFIG_GET, (event, input) => { expectNoInput(input); return options.configRepository.getPublic(); }, options);
  register(CHANNELS.CONFIG_SAVE, async (event, input) => {
    const payload = expectRecord(input, "config save");
    const config = expectRecord(payload.config, "config");
    if (payload.expectedRevision !== undefined && typeof payload.expectedRevision !== "string") throw new PublicIpcError("INVALID_INPUT", "expectedRevisionが不正です");
    const saved = await options.configRepository.save(config, payload.expectedRevision as string | undefined);
    options.shortcutService.sync((config.triggers ?? {}) as Record<string, unknown>);
    const context = config.context && typeof config.context === "object" && !Array.isArray(config.context) ? config.context as Record<string, unknown> : {};
    const screenCapture = context.screenCapture && typeof context.screenCapture === "object" && !Array.isArray(context.screenCapture) ? context.screenCapture as Record<string, unknown> : {};
    options.captureService.setPreferredSourceName(screenCapture.sourceName);
    return saved;
  }, options);
  register(CHANNELS.CONFIG_IMPORT_LEGACY, async (event, input) => {
    const payload = input === undefined || input === null ? {} : expectRecord(input, "legacy import");
    const preview = await options.configRepository.previewLegacy();
    if (payload.confirm !== true) return { imported: false, secretKeys: preview.secretEntries.map((entry) => entry.key) };
    for (const entry of preview.secretEntries) await options.secretStore.set(parseSecretKey(entry.key), entry.value);
    const current = await options.configRepository.getPublic();
    const saved = await options.configRepository.save(preview.config, current.revision);
    options.shortcutService.sync((preview.config.triggers ?? {}) as Record<string, unknown>);
    const context = preview.config.context && typeof preview.config.context === "object" && !Array.isArray(preview.config.context) ? preview.config.context as Record<string, unknown> : {};
    const screenCapture = context.screenCapture && typeof context.screenCapture === "object" && !Array.isArray(context.screenCapture) ? context.screenCapture as Record<string, unknown> : {};
    options.captureService.setPreferredSourceName(screenCapture.sourceName);
    return { imported: true, secretKeys: preview.secretEntries.map((entry) => entry.key), revision: saved.revision };
  }, options);
  register(CHANNELS.SECRET_STATUS, (event, input) => {
    if (input !== undefined && input !== null && !Array.isArray(input)) throw new PublicIpcError("INVALID_INPUT", "keysは配列で指定してください");
    const keys = (input ?? []) as unknown[];
    return options.secretStore.listStatus(keys.map(parseSecretKey));
  }, options);
  register(CHANNELS.SECRET_SET, async (event, input) => {
    const payload = expectRecord(input, "secret");
    const key = parseSecretKey(payload.key);
    const value = expectString(payload.value, "secret value", 16_384);
    await options.secretStore.set(key, value);
    return { saved: true, persistent: options.secretStore.isPersistentAvailable() };
  }, options);
  register(CHANNELS.SECRET_REMOVE, async (event, input) => {
    const key = parseSecretKey(input);
    await options.secretStore.remove(key);
    return { removed: true };
  }, options);
  register(CHANNELS.AI_CHAT, async (event, input) => {
    const payload = expectRecord(input, "AI request");
    const connectorId = expectString(payload.connectorId, "connectorId", 128);
    const messages = parseAiMessages(payload.messages);
    const optionsValue = payload.options === undefined ? undefined : expectRecord(payload.options, "AI options");
    if (optionsValue && optionsValue.stream !== undefined && typeof optionsValue.stream !== "boolean") throw new PublicIpcError("INVALID_INPUT", "streamが不正です");
    return options.aiService.chat({ connectorId, messages, ...(optionsValue ? { options: optionsValue as AiChatInput["options"] } : {}), ...(typeof payload.requestId === "string" ? { requestId: payload.requestId } : {}), ...(typeof payload.generation === "number" && Number.isSafeInteger(payload.generation) ? { generation: payload.generation } : {}), ...(typeof payload.ownerId === "string" ? { ownerId: payload.ownerId } : {}) });
  }, options);
  register(CHANNELS.AI_CANCEL, (event, input) => ({ cancelled: options.aiService.cancel(expectString(input, "requestId", 256)) }), options);
  register(CHANNELS.FEED_FETCH, (event, input) => {
    const payload = expectRecord(input, "feed request");
    return options.feedService.fetch({ sourceIndex: sourceIndex(payload), ...requestMetadata(payload) });
  }, options);
  register(CHANNELS.FEED_CANCEL, (event, input) => ({ cancelled: options.feedService.cancel(expectString(input, "requestId", 256)) }), options);
  register(CHANNELS.TOPIC_FETCH, (event, input) => {
    const payload = expectRecord(input, "topic request");
    return options.topicService.fetchTopics({ sourceIndex: sourceIndex(payload), ...requestMetadata(payload) });
  }, options);
  register(CHANNELS.TOPIC_COMPLETE, (event, input) => {
    const payload = expectRecord(input, "topic completion");
    return options.topicService.completeTask({ sourceIndex: sourceIndex(payload), taskId: expectString(payload.taskId, "taskId", 256), ...requestMetadata(payload) });
  }, options);
  register(CHANNELS.TOPIC_CANCEL, (event, input) => ({ cancelled: options.topicService.cancel(expectString(input, "requestId", 256)) }), options);
  register(CHANNELS.SPEECH_VOICEVOX_SPEAKERS, (event, input) => options.speechService.voicevox.speakers(input === undefined ? {} : expectRecord(input, "VOICEVOX speakers")), options);
  register(CHANNELS.SPEECH_VOICEVOX_SYNTHESIZE, (event, input) => options.speechService.voicevox.synthesize(expectRecord(input, "VOICEVOX synthesis") as never), options);
  register(CHANNELS.SPEECH_BOUYOMI_TALK, (event, input) => options.speechService.bouyomi.talk(expectRecord(input, "Bouyomi talk") as never), options);
  register(CHANNELS.SPEECH_BOUYOMI_CLEAR, (event, input) => options.speechService.bouyomi.clear(input === undefined ? {} : expectRecord(input, "Bouyomi clear")), options);
  register(CHANNELS.SPEECH_CANCEL, (event, input) => ({ cancelled: options.speechService.cancel(expectString(input, "requestId", 256)) }), options);
  register(CHANNELS.TWITCH_START, (event, input) => options.twitchService.start(expectRecord(input, "Twitch config") as never), options);
  register(CHANNELS.TWITCH_STOP, (event, input) => { expectNoInput(input); return options.twitchService.stop(); }, options);
  register(CHANNELS.TWITCH_RECONNECT, (event, input) => { expectNoInput(input); return { reconnected: options.twitchService.reconnect() }; }, options);
  register(CHANNELS.TWITCH_AUTH_STATUS, (event, input) => { expectNoInput(input); return options.twitchComposition.authOverview; }, options);
  register(CHANNELS.TWITCH_AUTH_START, (event, input) => options.twitchComposition.startInitialAuth(parseOptionalFeatures(input)), options);
  register(CHANNELS.TWITCH_AUTH_CANCEL, (event, input) => { expectNoInput(input); return options.twitchComposition.cancelAuth(); }, options);
  register(CHANNELS.TWITCH_AUTH_UPGRADE_SCOPES, (event, input) => { expectNoInput(input); return options.twitchComposition.startScopeUpgrade(); }, options);
  register(CHANNELS.TWITCH_AUTH_OPEN_VERIFICATION_URI, (event, input) => { expectNoInput(input); return options.twitchComposition.openVerificationUri(); }, options);
  register(CHANNELS.TWITCH_AUTH_SWITCH_ACCOUNT, (event, input) => options.twitchComposition.switchAccount(parseOptionalFeatures(input)), options);
  register(CHANNELS.TWITCH_AUTH_LOGOUT, (event, input) => { expectNoInput(input); return options.twitchComposition.logout(); }, options);
  register(CHANNELS.TWITCH_EVENTSUB_STATUS, (event, input) => { expectNoInput(input); return options.twitchComposition.connectionOverview; }, options);
  register(CHANNELS.TWITCH_EVENTSUB_CONNECT, (event, input) => { expectNoInput(input); return options.twitchComposition.connect(); }, options);
  register(CHANNELS.TWITCH_EVENTSUB_RECONNECT, (event, input) => { expectNoInput(input); return options.twitchComposition.reconnect(); }, options);
  register(CHANNELS.TWITCH_EVENTSUB_STOP, (event, input) => { expectNoInput(input); return options.twitchComposition.stop(); }, options);
  register(CHANNELS.TWITCH_SUBSCRIPTIONS_STATUS, (event, input) => { expectNoInput(input); return options.twitchComposition.subscriptionsOverview; }, options);
  register(CHANNELS.TWITCH_REWARDS_LIST, (event, input) => { expectNoInput(input); return options.twitchComposition.listCustomRewards(); }, options);
  register(CHANNELS.WINDOW_OBS_OPEN, (event, input) => { expectNoInput(input); options.controller.openObsWindow(); return { opened: true }; }, options);
  register(CHANNELS.WINDOW_OBS_CLOSE, (event, input) => { expectNoInput(input); options.controller.closeObsWindow(); return { closed: true }; }, options);
  register(CHANNELS.WINDOW_STATE_GET, (event, input) => {
    expectNoInput(input);
    const windows = options.controller.getWindows();
    return { consoleOpen: Boolean(windows.console && !windows.console.isDestroyed()), obsOpen: Boolean(windows.obs && !windows.obs.isDestroyed()) };
  }, options);
  register(CHANNELS.SYSTEM_OPEN_EXTERNAL, async (event, input) => {
    const url = expectExternalHttpsUrl(input);
    return openAllowedExternalUrl(url.toString());
  }, options);
  register(CHANNELS.SYSTEM_SHOW_ITEM, (event, input) => {
    const kind = expectString(input, "kind") as ShowItemKind;
    const target = { logs: options.paths.logsDir, models: options.paths.modelsDir, config: options.paths.configRepositoryFile }[kind];
    if (!target) throw new PublicIpcError("INVALID_INPUT", "show item kindが不正です");
    require("electron").shell.showItemInFolder(target);
    return { shown: true };
  }, options);
  register(CHANNELS.SHORTCUT_STATUS, (event, input) => { expectNoInput(input); return options.shortcutService.status(); }, options);
  register(CHANNELS.CAPTURE_LIST_SOURCES, (event, input) => { expectNoInput(input); return options.captureService.listSources(); }, options);
  register(CHANNELS.CAPTURE_SELECT_SOURCE, async (event, input) => {
    const payload = expectRecord(input, "capture source");
    const id = payload.id === undefined ? undefined : expectString(payload.id, "source id", 512);
    const name = payload.name === undefined ? undefined : expectString(payload.name, "source name", 256);
    if (!id && !name) throw new PublicIpcError("INVALID_INPUT", "source idまたはnameが必要です");
    return options.captureService.selectSource({ ...(id ? { id } : {}), ...(name ? { name } : {}) });
  }, options);
  register(CHANNELS.CAPTURE_STATUS, (event, input) => { expectNoInput(input); return options.captureService.status(); }, options);
  register(CHANNELS.LOCAL_LLM_CATALOG_LIST, (event, input) => { expectNoInput(input); return options.modelRepository.listCatalog(); }, options);
  register(CHANNELS.LOCAL_LLM_INSTALLED_LIST, (event, input) => { expectNoInput(input); return options.modelRepository.listInstalled(); }, options);
  register(CHANNELS.LOCAL_LLM_INSTALLED_GET, async (event, input) => ({ model: await options.modelRepository.getInstalled(expectString(input, "modelId", 256)) }), options);
  register(CHANNELS.LOCAL_LLM_IMPORT_BEGIN, (event, input) => { expectNoInput(input); return options.modelRepository.beginImport(); }, options);
  register(CHANNELS.LOCAL_LLM_IMPORT_COMMIT, (event, input) => options.modelRepository.commitImport(expectString(input, "import token", 256)), options);
  register(CHANNELS.LOCAL_LLM_IMPORT_CANCEL, (event, input) => ({ cancelled: options.modelRepository.cancelImport(expectString(input, "import token", 256)) }), options);
  register(CHANNELS.LOCAL_LLM_DOWNLOAD_START, (event, input) => options.modelRepository.startDownload(parseDownloadStartInput(input)), options);
  register(CHANNELS.LOCAL_LLM_DOWNLOAD_CANCEL, async (event, input) => {
    const payload = expectRecord(input, "download cancel");
    const jobId = expectString(payload.jobId, "jobId", 256);
    if (payload.deletePartial !== undefined && typeof payload.deletePartial !== "boolean") throw new PublicIpcError("INVALID_INPUT", "deletePartialが不正です");
    return { cancelled: await options.modelRepository.cancelDownload(jobId, payload.deletePartial as boolean | undefined) };
  }, options);
  register(CHANNELS.LOCAL_LLM_DOWNLOAD_RETRY, (event, input) => options.modelRepository.retryDownload(expectString(input, "jobId", 256)), options);
  register(CHANNELS.LOCAL_LLM_DOWNLOAD_LIST, async (event, input) => { expectNoInput(input); return { jobs: await options.modelRepository.listDownloads() }; }, options);
  register(CHANNELS.LOCAL_LLM_DOWNLOAD_STATUS, async (event, input) => ({ job: await options.modelRepository.getDownload(expectString(input, "jobId", 256)) }), options);
  register(CHANNELS.STREAM_EVENTS_LIST, (event, input) => {
    const payload = input === undefined || input === null ? {} : expectRecord(input, "stream events list");
    let limit: number | undefined;
    if (payload.limit !== undefined) {
      if (typeof payload.limit !== "number" || !Number.isInteger(payload.limit) || payload.limit < 0 || payload.limit > 10_000) throw new PublicIpcError("INVALID_INPUT", "limitが不正です");
      limit = payload.limit;
    }
    const stats = options.streamEventBus.stats;
    return { events: options.streamEventBus.list(limit), stats: { totalPublished: stats.totalPublished, totalRejected: stats.totalRejected, totalDuplicates: stats.totalDuplicates, listenerCount: stats.listenerCount } };
  }, options, ["console", "obs"]);
  // Issue #96: "clear history対象を確認dialogで選択" — restricted to the "console" role only (the
  // operator-facing Event History UI lives in the main window; the OBS overlay window has no
  // business clearing the shared replay buffer other windows may still want to snapshot).
  register(CHANNELS.STREAM_EVENTS_CLEAR, (event, input) => {
    expectNoInput(input);
    options.streamEventBus.clearHistory();
    return { cleared: true };
  }, options, ["console"]);
  ipcMain.on(CHANNELS.OBS_MESSAGE, (event, message) => {
    try {
      assertTrustedSender(event, options.devServerUrl, ["console", "obs"]);
      if (!message || typeof message !== "object") return;
      const role = getWindowRole(event.sender);
      if (role === "console") options.controller.emitToObs("obs:message", message);
      if (role === "obs") options.controller.emitToConsole("obs:message", message);
    } catch { /* untrusted renderer messages are ignored */ }
  });

  return () => {
    for (const channel of Object.values(CHANNELS)) {
      if (channel !== CHANNELS.APP_EVENT) ipcMain.removeHandler(channel);
    }
    ipcMain.removeAllListeners(CHANNELS.OBS_MESSAGE);
  };
}
