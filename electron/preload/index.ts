import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "../shared/ipc-channels";
import type { DociaiApi } from "../shared/ipc-contract";
import type { Result } from "../shared/ipc-contract";
import type { PublicError } from "../shared/errors";

function failure(error: unknown): { ok: false; error: PublicError } {
  return { ok: false, error: { code: "INTERNAL_ERROR", message: "IPC呼び出しに失敗しました", retryable: false } };
}

function invoke<T>(channel: string, input?: unknown): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, input).then((result) => result as Result<T>).catch(failure);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

const api: DociaiApi = {
  platform: { getInfo: () => invoke(CHANNELS.PLATFORM_GET_INFO) },
  config: {
    get: () => invoke(CHANNELS.CONFIG_GET),
    save: (input) => invoke(CHANNELS.CONFIG_SAVE, input),
  },
  secrets: {
    status: (keys) => invoke(CHANNELS.SECRET_STATUS, keys),
    set: (input) => invoke(CHANNELS.SECRET_SET, input),
    remove: (key) => invoke(CHANNELS.SECRET_REMOVE, key),
  },
  windows: {
    openObs: () => invoke(CHANNELS.WINDOW_OBS_OPEN),
    closeObs: () => invoke(CHANNELS.WINDOW_OBS_CLOSE),
    getState: () => invoke(CHANNELS.WINDOW_STATE_GET),
  },
  system: {
    openExternal: (url) => invoke(CHANNELS.SYSTEM_OPEN_EXTERNAL, url),
    showItemInFolder: (kind) => invoke(CHANNELS.SYSTEM_SHOW_ITEM, kind),
  },
  events: {
    subscribe(type, listener) {
      if (typeof type !== "string" || type.length === 0 || type.length > 128 || typeof listener !== "function") return () => {};
      const callback = (_event: Electron.IpcRendererEvent, payload: { type?: string; event?: unknown }) => {
        if (payload?.type === type) listener(payload.event);
      };
      ipcRenderer.on(CHANNELS.APP_EVENT, callback);
      return () => ipcRenderer.removeListener(CHANNELS.APP_EVENT, callback);
    },
  },
};

contextBridge.exposeInMainWorld("dociai", deepFreeze(api));
