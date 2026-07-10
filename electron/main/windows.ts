import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, screen } from "electron";
import type { AppPaths } from "./paths";

type WindowState = { x?: number; y?: number; width: number; height: number };
type WindowControllerOptions = { appPath: string; preloadPath: string; paths: AppPaths; devServerUrl?: string };
const DEFAULT_CONSOLE_STATE: WindowState = { width: 1440, height: 960 };

function readWindowState(file: string): WindowState {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isFinite(state.width) || !Number.isFinite(state.height)) return DEFAULT_CONSOLE_STATE;
    return { x: state.x, y: state.y, width: state.width, height: state.height };
  } catch {
    return DEFAULT_CONSOLE_STATE;
  }
}

function fitToWorkArea(state: WindowState): WindowState {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.max(state.width, 960), workArea.width);
  const height = Math.min(Math.max(state.height, 640), workArea.height);
  const x = Math.min(Math.max(state.x ?? workArea.x + Math.round((workArea.width - width) / 2), workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(state.y ?? workArea.y + Math.round((workArea.height - height) / 2), workArea.y), workArea.y + workArea.height - height);
  return { x, y, width, height };
}

function saveWindowState(file: string, window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  try {
    fs.writeFileSync(file, JSON.stringify(window.getBounds(), null, 2), { mode: 0o600 });
  } catch {
    // Window persistence must never prevent orderly shutdown.
  }
}

function pageUrl(page: string, devServerUrl?: string): string {
  if (devServerUrl) return new URL(page, devServerUrl.endsWith("/") ? devServerUrl : `${devServerUrl}/`).toString();
  return `dociai://app/${page}`;
}

export function createWindowController(options: WindowControllerOptions) {
  const stateFile = path.join(options.paths.userDataDir, "window-state.json");
  let consoleWindow: BrowserWindow | null = null;
  let obsWindow: BrowserWindow | null = null;
  const webPreferences = { preload: options.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true };

  function createConsoleWindow(): BrowserWindow {
    if (consoleWindow && !consoleWindow.isDestroyed()) { consoleWindow.focus(); return consoleWindow; }
    consoleWindow = new BrowserWindow({ ...fitToWorkArea(readWindowState(stateFile)), minWidth: 960, minHeight: 640, show: false, webPreferences });
    consoleWindow.once("ready-to-show", () => consoleWindow?.show());
    consoleWindow.on("close", () => saveWindowState(stateFile, consoleWindow));
    consoleWindow.on("closed", () => { consoleWindow = null; });
    void consoleWindow.loadURL(pageUrl("index.html", options.devServerUrl));
    return consoleWindow;
  }

  function openObsWindow(): BrowserWindow {
    if (obsWindow && !obsWindow.isDestroyed()) { obsWindow.focus(); return obsWindow; }
    obsWindow = new BrowserWindow({ width: 960, height: 540, minWidth: 480, minHeight: 270, show: false, transparent: true, backgroundColor: "#00000000", webPreferences });
    obsWindow.once("ready-to-show", () => obsWindow?.show());
    obsWindow.on("closed", () => { obsWindow = null; });
    void obsWindow.loadURL(pageUrl("obs.html?transparent=1", options.devServerUrl));
    return obsWindow;
  }

  return {
    createConsoleWindow,
    openObsWindow,
    closeObsWindow() { if (obsWindow && !obsWindow.isDestroyed()) obsWindow.close(); obsWindow = null; },
    focusConsole() {
      if (!consoleWindow || consoleWindow.isDestroyed()) return;
      if (consoleWindow.isMinimized()) consoleWindow.restore();
      consoleWindow.focus();
    },
    dispose() {
      saveWindowState(stateFile, consoleWindow);
      if (obsWindow && !obsWindow.isDestroyed()) obsWindow.destroy();
      if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.destroy();
      obsWindow = null;
      consoleWindow = null;
    },
  };
}
