import type { IpcMainInvokeEvent, WebContents } from "electron";
import { businessBridgeOrigins, httpOrigin } from "../services/auth/businessOrigins";
export { businessBridgeOrigins } from "../services/auth/businessOrigins";

/** 社区版维持原有 HTTP(S) 桥；商业版仅在受信 origin 初次挂载。 */
export function shouldInjectWebviewPerfBridge(url: string, product: string): boolean {
  const origin = httpOrigin(url);
  return !!origin && (product !== "nuwax" || businessBridgeOrigins().includes(origin));
}

/** 导航后的 frame 和顶层页面必须同时仍在当前受信域内。 */
export function isBusinessBridgeSender(event: IpcMainInvokeEvent): boolean {
  const frame = httpOrigin(event.senderFrame?.url);
  const top = httpOrigin(event.sender?.getURL());
  const allowed = businessBridgeOrigins();
  return !!frame && !!top && allowed.includes(frame) && allowed.includes(top);
}

/** 壳自身的 preload 仅在顶层本地 renderer 生效。 */
export function isHostRendererSender(
  event: IpcMainInvokeEvent,
  host: WebContents | undefined,
  packaged: boolean,
): boolean {
  if (!host || event.sender !== host || event.senderFrame !== host.mainFrame)
    return false;
  try {
    const url = new URL(host.getURL());
    return url.protocol === "file:" || url.protocol === "app:" ||
      (!packaged && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        ["http:", "https:"].includes(url.protocol));
  } catch {
    return false;
  }
}

export function canUseUpdater(
  event: IpcMainInvokeEvent,
  host: WebContents | undefined,
  packaged: boolean,
  product: string,
): boolean {
  return product !== "nuwax" ||
    isHostRendererSender(event, host, packaged) ||
    isBusinessBridgeSender(event);
}
