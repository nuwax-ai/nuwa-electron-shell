/**
 * Webview / iframe 浏览器策略统一管理
 *
 * 集中处理：
 * 1. 权限请求（剪贴板、媒体、全屏等）
 * 2. window.open 弹窗（应用内打开，尺寸在页面请求基础上 ×2）
 * 3. 文件下载（导出等场景，支持进度条）
 */

import { app, session as electronSession, BrowserWindow } from "electron";
import type { HandlerDetails, BrowserWindowConstructorOptions, Session, WebContents, WebPreferences } from "electron";
import { randomUUID } from "crypto";
import * as path from "path";
import log from "electron-log";
import {
  APP_NAME_IDENTIFIER,
  WEBVIEW_POPUP_BASE_WIDTH,
  WEBVIEW_POPUP_BASE_HEIGHT,
  WEBVIEW_POPUP_MIN_WIDTH,
  WEBVIEW_POPUP_MIN_HEIGHT,
} from "@shared/constants";
import { businessBridgeOrigins } from "../../ipc/bridgeTrust";

// ---------- 权限白名单 ----------

const ALLOWED_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "media",
  "mediaKeySystem",
  "notifications",
  "fullscreen",
  "pointerLock",
  "openExternal",
]);
// 外部网站仍可使用普通复制/全屏；设备、通知、剪贴板读取等需留在业务会话。
const ALLOWED_ISOLATED_PERMISSIONS = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
]);
const configuredPermissionSessions = new WeakSet<Session>();
const guardedBusinessContents = new WeakSet<WebContents>();

// ---------- 权限 ----------

function configurePermissionHandlers(ses: Session, allowed: ReadonlySet<string>): void {
  if (configuredPermissionSessions.has(ses)) return;
  ses.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const trusted = ses !== electronSession.defaultSession ||
        APP_NAME_IDENTIFIER !== "nuwax" ||
        isTrustedPermissionSource(contents, details?.requestingUrl);
      if (allowed.has(permission) && trusted) {
        callback(true);
      } else {
        log.warn(`[WebviewPolicy] Denied permission request: ${permission}`);
        callback(false);
      }
    },
  );

  ses.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      if (!allowed.has(permission)) return false;
      if (ses !== electronSession.defaultSession || APP_NAME_IDENTIFIER !== "nuwax") return true;
      return isTrustedPermissionSource(contents, requestingOrigin) &&
        (!details?.requestingUrl || isTrustedBusinessUrl(details.requestingUrl)) &&
        (!details?.embeddingOrigin || isTrustedBusinessUrl(details.embeddingOrigin)) &&
        (!details?.securityOrigin || isTrustedBusinessUrl(details.securityOrigin));
    },
  );
  configuredPermissionSessions.add(ses);
}

function setupPermissions(): void {
  configurePermissionHandlers(electronSession.defaultSession, ALLOWED_PERMISSIONS);
}

/** 必须在创建外链窗口之前设置其独立会话权限；Electron 不从 defaultSession 继承。 */
export function configureIsolatedWebSession(partition: string): Session {
  if (!partition.startsWith("temp:nuwax-") || partition.startsWith("persist:"))
    throw new Error("Invalid isolated web partition");
  const ses = electronSession.fromPartition(partition);
  configurePermissionHandlers(ses, ALLOWED_ISOLATED_PERMISSIONS);
  ses.setSpellCheckerEnabled(false);
  return ses;
}

// ---------- 拼写检查 ----------

/**
 * 在 session 级别禁用拼写检查。
 *
 * BrowserWindow 的 webPreferences.spellcheck:false 只对该窗口自身的 webContents
 * 生效；而应用内打开网页用的是 <webview>，它是独立的 webContents、不会继承该设置，
 * 因此 Windows 上网页输入框仍会出现红色拼写波浪线。这里在 default session（所有
 * 未指定 partition 的 webview 与主窗口共用）上关闭拼写检查器，一次性覆盖全部。
 */
function setupSpellCheck(): void {
  electronSession.defaultSession.setSpellCheckerEnabled(false);
}

// ---------- window.open ----------

function parseHttpUrl(value: string | undefined): URL | null {
  try {
    const url = new URL(value || "");
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isTrustedBusinessUrl(value: string | undefined): boolean {
  const parsed = parseHttpUrl(value);
  return !!parsed && !parsed.username && !parsed.password &&
    businessBridgeOrigins().includes(parsed.origin);
}

function isTrustedPermissionSource(contents: WebContents | null, frameUrl: string | undefined): boolean {
  return !!contents && !contents.isDestroyed() &&
    contents.session === electronSession.defaultSession &&
    isTrustedBusinessUrl(contents.getURL()) && isTrustedBusinessUrl(frameUrl);
}

/** Keep a non-business initial <webview src> out of the shared session before its first request. */
export function isolateUntrustedInitialWebview(
  webPreferences: WebPreferences,
  params: Record<string, string>,
): boolean {
  if (APP_NAME_IDENTIFIER !== "nuwax" || !params.src || isTrustedBusinessUrl(params.src))
    return false;
  const partition = `temp:nuwax-webview-${randomUUID()}`;
  configureIsolatedWebSession(partition);
  delete webPreferences.session;
  delete webPreferences.preload;
  webPreferences.partition = partition;
  params.partition = partition;
  return true;
}

/**
 * 解析 window.open 的 features 字符串（如 "width=500,height=300"）。
 */
function parseWindowFeatures(features: string): {
  width?: number;
  height?: number;
} {
  const result: { width?: number; height?: number } = {};
  if (!features) return result;

  for (const part of features.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = parseInt(trimmed.slice(eq + 1).trim(), 10);
    if (Number.isNaN(value) || value <= 0) continue;

    if (key === "width") result.width = value;
    if (key === "height") result.height = value;
  }

  return result;
}

/**
 * 将页面请求的弹窗尺寸放大一倍；未指定时使用 Electron 常见默认 600×400 再 ×2。
 */
function resolveWebviewPopupSize(features: string): {
  width: number;
  height: number;
} {
  const parsed = parseWindowFeatures(features);
  const baseWidth = parsed.width ?? WEBVIEW_POPUP_BASE_WIDTH;
  const baseHeight = parsed.height ?? WEBVIEW_POPUP_BASE_HEIGHT;
  return { width: baseWidth * 2, height: baseHeight * 2 };
}

/** 应用内 http(s) 弹窗的 BrowserWindow 配置 */
function buildPopupWindowOptions(
  features: string,
  trustedBusiness: boolean,
): BrowserWindowConstructorOptions {
  const { width, height } = resolveWebviewPopupSize(features);
  const webPreferences: NonNullable<BrowserWindowConstructorOptions["webPreferences"]> = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
  if (APP_NAME_IDENTIFIER === "nuwax") {
    if (trustedBusiness) {
      webPreferences.session = electronSession.defaultSession;
      webPreferences.preload = path.join(__dirname, "..", "preload", "webviewPerfBridge.js");
      webPreferences.additionalArguments = [
        `--nuwax-host-product=${APP_NAME_IDENTIFIER}`,
        `--nuwax-trusted-origins=${encodeURIComponent(JSON.stringify(businessBridgeOrigins()))}`,
      ];
    } else {
      // 子窗口不继承默认业务 cookie；每次打开均用新的内存会话。
      webPreferences.partition = `temp:nuwax-popup-${randomUUID()}`;
      configureIsolatedWebSession(webPreferences.partition);
    }
  }
  return {
    width,
    height,
    minWidth: WEBVIEW_POPUP_MIN_WIDTH,
    minHeight: WEBVIEW_POPUP_MIN_HEIGHT,
    webPreferences,
    show: true,
    backgroundColor: "#ffffff",
  };
}

function handleHttpPopupOpen(details: HandlerDetails, opener: WebContents):
  | {
      action: "allow";
      overrideBrowserWindowOptions: BrowserWindowConstructorOptions;
    }
  | { action: "deny" } {
  const { url, features } = details;
  const target = parseHttpUrl(url);
  if (!target) {
    return { action: "deny" };
  }

  const openerUrl = parseHttpUrl(opener.getURL());
  const referrerUrl = parseHttpUrl(details.referrer?.url);
  const allowed = APP_NAME_IDENTIFIER === "nuwax" ? businessBridgeOrigins() : [];
  const trustedBusiness = APP_NAME_IDENTIFIER === "nuwax" &&
    opener.session === electronSession.defaultSession &&
    !!openerUrl && !!referrerUrl &&
    !openerUrl.username && !openerUrl.password &&
    !referrerUrl.username && !referrerUrl.password &&
    !target.username && !target.password &&
    openerUrl.origin === referrerUrl.origin &&
    allowed.includes(openerUrl.origin) && allowed.includes(target.origin);
  const options = buildPopupWindowOptions(features ?? "", trustedBusiness);
  log.debug(
    `[WebviewPolicy] Opening in-app popup: ${target.origin} (${options.width}x${options.height})`,
  );
  return { action: "allow", overrideBrowserWindowOptions: options };
}

/** A business document must not carry its defaultSession into an external top-level page. */
function guardBusinessNavigation(contents: WebContents): void {
  if (APP_NAME_IDENTIFIER !== "nuwax" ||
      contents.session !== electronSession.defaultSession ||
      guardedBusinessContents.has(contents)) return;
  guardedBusinessContents.add(contents);

  const handleTarget = (event: Electron.Event, targetUrl: string, isMainFrame: boolean) => {
    if (!isMainFrame || isTrustedBusinessUrl(targetUrl)) return;
    event.preventDefault();
    const target = parseHttpUrl(targetUrl);
    if (!target) {
      log.warn(`[WebviewPolicy] Blocked non-HTTP top-level navigation: ${targetUrl}`);
      return;
    }
    try {
      const win = new BrowserWindow(buildPopupWindowOptions("", false));
      void win.loadURL(target.href);
      win.focus();
      log.info(`[WebviewPolicy] Isolated external navigation: ${target.origin}`);
    } catch (error) {
      log.warn("[WebviewPolicy] Failed to open isolated external navigation", error);
    }
  };
  // will-frame-navigate covers _self / location changes, including named-frame
  // targeting the top frame. will-redirect covers server redirects from loadURL
  // and initial <webview src>, which do not emit will-frame-navigate.
  contents.on("will-frame-navigate", (event) =>
    handleTarget(event, event.url, event.isMainFrame));
  contents.on("will-redirect", (event) =>
    handleTarget(event, event.url, event.isMainFrame));
}

function setupWindowOpen(): void {
  app.on("web-contents-created", (_event, contents) => {
    // A guest can start loading its initial src before did-attach-webview.
    // Install the redirect guard at creation, then let attach be a fallback.
    if (contents.getType() === "webview") guardBusinessNavigation(contents);
    // <webview> tag 内部的 window.open
    contents.on("did-attach-webview", (_event, webContents) => {
      guardBusinessNavigation(webContents);
      webContents.setWindowOpenHandler((details) =>
        handleHttpPopupOpen(details, webContents),
      );

      // Webview captures keyboard events — they don't bubble to the host page.
      // Intercept Ctrl/Cmd+Shift+I here to open webview DevTools.
      // Ctrl/Cmd+N: "new task" — reserved by real browsers (new window) so the
      // guest page never receives it there; the shell takes over and forwards
      // it as a host command (HostCommand "new-task", see nuwax nuwaClawHostEvents).
      webContents.on("before-input-event", (event, input) => {
        if (
          input.type === "keyDown" &&
          !input.shift &&
          !input.alt &&
          (input.control || input.meta) &&
          input.key.toLowerCase() === "n"
        ) {
          event.preventDefault();
          webContents.send("nuwax:host-command", { type: "new-task" });
          return;
        }
        if (
          input.type === "keyDown" &&
          input.shift &&
          (input.control || input.meta) &&
          input.key.toLowerCase() === "i"
        ) {
          event.preventDefault();
          webContents.openDevTools();
        }
      });
    });

    // BrowserWindow 内部的 window.open（独立 webview 窗口等）
    if (contents.getType() === "window") {
      contents.setWindowOpenHandler((details) => handleHttpPopupOpen(details, contents));
      guardBusinessNavigation(contents);
    }
  });
}

// ---------- 文件下载 ----------

function setupDownloads(getMainWindow: () => BrowserWindow | null): void {
  electronSession.defaultSession.on("will-download", (_event, item) => {
    const filename = item.getFilename();
    log.info(
      `[WebviewPolicy] Download started: ${filename} (${item.getTotalBytes()} bytes)`,
    );

    item.on("updated", (_event, state) => {
      if (state === "progressing" && !item.isPaused()) {
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        if (total > 0) {
          getMainWindow()?.setProgressBar(received / total);
        }
      }
    });

    item.once("done", (_event, state) => {
      getMainWindow()?.setProgressBar(-1);
      if (state === "completed") {
        log.info(
          `[WebviewPolicy] Download completed: ${filename} → ${item.getSavePath()}`,
        );
      } else {
        log.warn(`[WebviewPolicy] Download failed: ${filename} (${state})`);
      }
    });
  });
}

// ---------- 统一入口 ----------

/**
 * 初始化 webview / iframe 浏览器策略。
 * 须在 createWindow() 之前调用，确保主窗口 webContents 能注册 did-attach-webview 监听。
 */
export function initWebviewPolicy(
  getMainWindow: () => BrowserWindow | null,
): void {
  setupPermissions();
  setupSpellCheck();
  setupWindowOpen();
  setupDownloads(getMainWindow);
  log.info(
    "[WebviewPolicy] Initialized (permissions, spellcheck off, window.open, downloads)",
  );
}
