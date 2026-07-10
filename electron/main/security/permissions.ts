import { session, type WebContents } from "electron";
import { getWindowRole } from "../window-roles";
import { isTrustedAppUrl } from "./navigation";

function canUseMedia(webContents: WebContents | null, permission: string, devServerUrl?: string): boolean {
  if (!webContents || permission !== "media") return false;
  return getWindowRole(webContents) === "console" && isTrustedAppUrl(webContents.getURL(), devServerUrl);
}

export function installPermissionPolicy(devServerUrl?: string): void {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(canUseMedia(webContents, permission, devServerUrl)));
  defaultSession.setPermissionCheckHandler((webContents, permission) => canUseMedia(webContents, permission, devServerUrl));
}
