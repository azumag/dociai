import { contextBridge, ipcRenderer } from "electron";

const api = {
  platform: { getInfo: () => ipcRenderer.invoke("platform:get-info") },
  windows: {
    openObs: () => ipcRenderer.invoke("window:obs:open"),
    closeObs: () => ipcRenderer.invoke("window:obs:close"),
  },
};

contextBridge.exposeInMainWorld("dociai", Object.freeze(api));
