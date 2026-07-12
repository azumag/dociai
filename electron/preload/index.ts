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
    importLegacy: (confirm = false) => invoke(CHANNELS.CONFIG_IMPORT_LEGACY, { confirm }),
  },
  secrets: {
    status: (keys) => invoke(CHANNELS.SECRET_STATUS, keys),
    set: (input) => invoke(CHANNELS.SECRET_SET, input),
    remove: (key) => invoke(CHANNELS.SECRET_REMOVE, key),
  },
  ai: {
    chat: (input) => invoke(CHANNELS.AI_CHAT, input),
    cancel: (requestId) => invoke(CHANNELS.AI_CANCEL, requestId),
  },
  feeds: {
    fetch: (input) => invoke(CHANNELS.FEED_FETCH, input),
    cancel: (requestId) => invoke(CHANNELS.FEED_CANCEL, requestId),
  },
  topics: {
    fetch: (input) => invoke(CHANNELS.TOPIC_FETCH, input),
    complete: (input) => invoke(CHANNELS.TOPIC_COMPLETE, input),
    cancel: (requestId) => invoke(CHANNELS.TOPIC_CANCEL, requestId),
  },
  speech: {
    voicevox: { speakers: (input) => invoke(CHANNELS.SPEECH_VOICEVOX_SPEAKERS, input), synthesize: (input) => invoke(CHANNELS.SPEECH_VOICEVOX_SYNTHESIZE, input) },
    bouyomi: { talk: (input) => invoke(CHANNELS.SPEECH_BOUYOMI_TALK, input), clear: (input) => invoke(CHANNELS.SPEECH_BOUYOMI_CLEAR, input) },
    cancel: (requestId) => invoke(CHANNELS.SPEECH_CANCEL, requestId),
  },
  twitch: {
    start: (config) => invoke(CHANNELS.TWITCH_START, config),
    stop: () => invoke(CHANNELS.TWITCH_STOP),
    reconnect: () => invoke(CHANNELS.TWITCH_RECONNECT),
  },
  bouyomi: {
    talk: (input) => invoke(CHANNELS.SPEECH_BOUYOMI_TALK, input),
    clear: (input) => invoke(CHANNELS.SPEECH_BOUYOMI_CLEAR, input),
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
  shortcuts: { status: () => invoke(CHANNELS.SHORTCUT_STATUS) },
  localLlm: {
    catalog: { list: () => invoke(CHANNELS.LOCAL_LLM_CATALOG_LIST) },
    installed: {
      list: () => invoke(CHANNELS.LOCAL_LLM_INSTALLED_LIST),
      get: (modelId) => invoke(CHANNELS.LOCAL_LLM_INSTALLED_GET, modelId),
    },
    import: {
      begin: () => invoke(CHANNELS.LOCAL_LLM_IMPORT_BEGIN),
      commit: (token) => invoke(CHANNELS.LOCAL_LLM_IMPORT_COMMIT, token),
      cancel: (token) => invoke(CHANNELS.LOCAL_LLM_IMPORT_CANCEL, token),
    },
    download: {
      start: (input) => invoke(CHANNELS.LOCAL_LLM_DOWNLOAD_START, input),
      cancel: (input) => invoke(CHANNELS.LOCAL_LLM_DOWNLOAD_CANCEL, input),
      retry: (jobId) => invoke(CHANNELS.LOCAL_LLM_DOWNLOAD_RETRY, jobId),
      list: () => invoke(CHANNELS.LOCAL_LLM_DOWNLOAD_LIST),
      status: (jobId) => invoke(CHANNELS.LOCAL_LLM_DOWNLOAD_STATUS, jobId),
    },
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
  obs: {
    send(message) {
      if (!message || typeof message !== "object") return false;
      ipcRenderer.send(CHANNELS.OBS_MESSAGE, message);
      return true;
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      const callback = (_event: Electron.IpcRendererEvent, payload: { type?: string; event?: unknown }) => { if (payload?.type === "obs:message") listener(payload.event); };
      ipcRenderer.on(CHANNELS.APP_EVENT, callback);
      return () => ipcRenderer.removeListener(CHANNELS.APP_EVENT, callback);
    },
  },
};

contextBridge.exposeInMainWorld("dociai", deepFreeze(api));
