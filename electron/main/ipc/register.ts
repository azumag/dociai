import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS } from "../../shared/ipc-channels";
import { toPublicError, PublicIpcError } from "../../shared/errors";
import type { DociaiApi, Result, ShowItemKind } from "../../shared/ipc-contract";
import { expectExternalHttpsUrl, expectNoInput, expectRecord, expectString, redactConfig } from "../../shared/validation";
import { assertTrustedSender } from "./guard";
import { openAllowedExternalUrl } from "../security/navigation";
import type { AppPaths } from "../paths";

type WindowController = ReturnType<typeof import("../windows").createWindowController>;
type RegisterOptions = { controller: WindowController; paths: AppPaths; devServerUrl?: string };
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

function publicConfig(paths: AppPaths): Record<string, unknown> {
  try {
    const value = JSON.parse(require("node:fs").readFileSync(paths.configFile, "utf8"));
    return redactConfig(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function registerIpcHandlers(options: RegisterOptions): () => void {
  register(CHANNELS.PLATFORM_GET_INFO, (event, input) => {
    expectNoInput(input);
    return { runtime: "electron", platform: process.platform, arch: process.arch, appVersion: require("electron").app.getVersion(), isPackaged: require("electron").app.isPackaged };
  }, options);
  register(CHANNELS.CONFIG_GET, (event, input) => { expectNoInput(input); return publicConfig(options.paths); }, options);
  register(CHANNELS.CONFIG_SAVE, (event, input) => { expectRecord(input, "config"); throw new PublicIpcError("NOT_IMPLEMENTED", "設定保存はMain config service移管後に利用できます"); }, options);
  register(CHANNELS.SECRET_STATUS, (event, input) => {
    if (input !== undefined && input !== null && !Array.isArray(input)) throw new PublicIpcError("INVALID_INPUT", "keysは配列で指定してください");
    const keys = input ?? [];
    if (keys.some((key) => typeof key !== "string" || key.length > 128)) throw new PublicIpcError("INVALID_INPUT", "secret keyが不正です");
    return (keys.length ? keys : ["apiKey"]).map((key) => ({ key, configured: false }));
  }, options);
  register(CHANNELS.SECRET_SET, (event, input) => { expectRecord(input, "secret"); throw new PublicIpcError("NOT_IMPLEMENTED", "secret保存はMain secrets service移管後に利用できます"); }, options);
  register(CHANNELS.SECRET_REMOVE, (event, input) => { expectString(input, "key"); throw new PublicIpcError("NOT_IMPLEMENTED", "secret削除はMain secrets service移管後に利用できます"); }, options);
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
    const target = { logs: options.paths.logsDir, models: options.paths.modelsDir, config: options.paths.configFile }[kind];
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
