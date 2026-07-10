import type { WebContents } from "electron";
import type { WindowRole } from "../shared/ipc-contract";

const roles = new WeakMap<WebContents, WindowRole>();

export function registerWindowRole(contents: WebContents, role: WindowRole): void { roles.set(contents, role); }
export function unregisterWindowRole(contents: WebContents): void { roles.delete(contents); }
export function getWindowRole(contents: WebContents): WindowRole | null { return roles.get(contents) ?? null; }
