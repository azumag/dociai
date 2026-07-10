import type { IpcMainInvokeEvent } from "electron";
import { PublicIpcError } from "../../shared/errors";
import type { WindowRole } from "../../shared/ipc-contract";
import { isTrustedAppUrl } from "../security/navigation";
import { getWindowRole } from "../window-roles";

export function assertTrustedSender(event: IpcMainInvokeEvent, devServerUrl: string | undefined, allowedRoles: WindowRole[] = ["console"]): void {
  if (!event.senderFrame || event.senderFrame !== event.senderFrame.top) throw new PublicIpcError("FORBIDDEN", "subframeからのIPCは許可されていません");
  if (!isTrustedAppUrl(event.sender.getURL(), devServerUrl)) throw new PublicIpcError("FORBIDDEN", "信頼できないoriginです");
  const role = getWindowRole(event.sender);
  if (!role || !allowedRoles.includes(role)) throw new PublicIpcError("FORBIDDEN", "このwindow roleではIPCを利用できません");
}
