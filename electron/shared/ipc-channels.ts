export const CHANNELS = Object.freeze({
  CONFIG_GET: "config:get",
  CONFIG_SAVE: "config:save",
  CONFIG_IMPORT_LEGACY: "config:import-legacy",
  SECRET_STATUS: "secrets:status",
  SECRET_SET: "secrets:set",
  SECRET_REMOVE: "secrets:remove",
  AI_CHAT: "ai:chat",
  AI_CANCEL: "ai:cancel",
  PLATFORM_GET_INFO: "platform:get-info",
  WINDOW_OBS_OPEN: "window:obs:open",
  WINDOW_OBS_CLOSE: "window:obs:close",
  WINDOW_STATE_GET: "window:state:get",
  SYSTEM_OPEN_EXTERNAL: "system:open-external",
  SYSTEM_SHOW_ITEM: "system:show-item",
  APP_EVENT: "app:event",
});

export type IpcChannel = typeof CHANNELS[keyof typeof CHANNELS];
