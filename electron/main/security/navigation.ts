import { shell, type BrowserWindow } from "electron";

export function isTrustedAppUrl(raw: string, devServerUrl?: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === "dociai:" && url.hostname === "app") return true;
    return Boolean(devServerUrl && url.origin === new URL(devServerUrl).origin);
  } catch {
    return false;
  }
}

export function installNavigationPolicy(window: BrowserWindow, devServerUrl?: string): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url, devServerUrl)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

export async function openAllowedExternalUrl(raw: string): Promise<{ scheme: "https"; host: string }> {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("external URL is not allowed");
  await shell.openExternal(url.toString());
  return { scheme: "https", host: url.host };
}
