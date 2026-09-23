import type { IpcMainInvokeEvent, WebContents } from "electron";
import { readSetting } from "../db";
import { DEFAULT_SERVER_HOST } from "@shared/constants";

function httpOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/** 商业宿主当前明确配置的业务页、回环页和开发覆盖页。 */
export function businessBridgeOrigins(): string[] {
  const step1 = readSetting("step1_config") as { serverHost?: string } | null;
  const loopback = readSetting("nuwax.loopback") as { enabled?: boolean; origin?: string } | null;
  const override = readSetting("nuwax.webviewOverride") as { origin?: string } | null;
  return [...new Set([
    httpOrigin(step1?.serverHost || DEFAULT_SERVER_HOST),
    loopback?.enabled ? httpOrigin(loopback.origin) : null,
    httpOrigin(override?.origin),
  ].filter((origin): origin is string => origin !== null))];
}

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
