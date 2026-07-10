import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../shared/ipc-channels";
import { toPublicError, PublicIpcError } from "../../shared/errors";
import type { Result, ShowItemKind } from "../../shared/ipc-contract";
import { expectExternalHttpsUrl, expectNoInput, expectRecord, expectString } from "../../shared/validation";
import { assertTrustedSender } from "./guard";
import { openAllowedExternalUrl } from "../security/navigation";
import type { AppPaths } from "../paths";
import { ConfigRepository } from "../config/config-repository";
import type { SecretStore } from "../../shared/secret-contract";
import { parseSecretKey } from "../secrets/secret-keys";

type WindowController = ReturnType<typeof import("../windows").createWindowController>;
type RegisterOptions = { controller: WindowController; paths: AppPaths; configRepository: ConfigRepository; secretStore: SecretStore; devServerUrl?: string };
type Handler<T> = (event: IpcMainInvokeEvent, input: unknown) => Promise<T> | T;

function register<T>(channel: string, handler: Handler<T>, options: RegisterOptions, roles = ["console"] as const): void {
  ipcMain.handle(channel, async (event, input): Promise<Result<T>> => {
    try {
      assertTrustedSender(event, options.devServerUrl, [...roles]);
      return { ok: true, value: await handler(event, input) };
    } catch (error) {
      return { ok: false, error: toPublicError(error) };
    }
  });
}

export function registerIpcHandlers(options: RegisterOptions): () => void {
  register(CHANNELS.PLATFORM_GET_INFO, (event, input) => {
    expectNoInput(input);
    return { runtime: "electron", platform: process.platform, arch: process.arch, appVersion: require("electron").app.getVersion(), isPackaged: require("electron").app.isPackaged };
  }, options);
  register(CHANNELS.CONFIG_GET, (event, input) => { expectNoInput(input); return options.configRepository.getPublic(); }, options);
  register(CHANNELS.CONFIG_SAVE, (event, input) => {
    const payload = expectRecord(input, "config save");
    const config = expectRecord(payload.config, "config");
    if (payload.expectedRevision !== undefined && typeof payload.expectedRevision !== "string") throw new PublicIpcError("INVALID_INPUT", "expectedRevisionが不正です");
    return options.configRepository.save(config, payload.expectedRevision as string | undefined);
  }, options);
  register(CHANNELS.CONFIG_IMPORT_LEGACY, async (event, input) => {
    const payload = input === undefined || input === null ? {} : expectRecord(input, "legacy import");
    const preview = await options.configRepository.previewLegacy();
    if (payload.confirm !== true) return { imported: false, secretKeys: preview.secretEntries.map((entry) => entry.key) };
    for (const entry of preview.secretEntries) await options.secretStore.set(parseSecretKey(entry.key), entry.value);
    const current = await options.configRepository.getPublic();
    const saved = await options.configRepository.save(preview.config, current.revision);
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

  return () => {
    for (const channel of Object.values(CHANNELS)) {
      if (channel !== CHANNELS.APP_EVENT) ipcMain.removeHandler(channel);
    }
  };
}
