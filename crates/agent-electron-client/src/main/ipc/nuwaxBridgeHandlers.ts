/**
 * nuwax webview ↔ 壳的桥后端（产品中立部分）。
 *
 * 基座只承载与产品身份无关的宿主能力：
 * - localFiles:pickDirectory
 *     宿主原生目录选择器：仅返回绝对路径，数据面由 nuwax 走 file-server。
 * - native:saveImage
 *     右键另存图片：系统保存对话框 + net.fetch（走 defaultSession，携带登录态 cookie）写盘。
 * - native:openWindow
 *     新开独立窗口/同窗导航打开 nuwax 站内页面（智能体详情/工作流/网页应用开发/
 *     我的电脑等全屏页）。带系统标题栏（零遮挡）+ 同一 webview 桥 preload；URL
 *     追加 _shell=1 让 nuwax 解除沉浸式门控。仅接受站内相对路径并校验同源。
 * - nuwax:theme-sync
 *     nuwax 女娲主题状态推送（{ active, 调色板 }）→ 转发 nuwax:theme-changed 给壳
 *     renderer，壳给自己的 antd tokens / CSS 变量叠加同套米白调色板（原生 UI 统一）。
 * - nuwax:layout-sync
 *     nuwax 布局状态推送（{ secondMenuAvailable }）→ 转发 nuwax:layout-changed 给壳
 *     renderer，工具栏据此显隐「收起二级菜单」按钮（无二级菜单的页面按钮无意义）。
 *
 * 【商业扩展】nuwax 登录态同步（auth:getToken/persistToken/clear 的 token 持久化
 * 与服务生命周期联动、NUWAX_TOKEN_KEY_PREFIX/nuwaxTokenScopes 键空间）属商业
 * 专属实现，由 nuwa-work overlay 整文件覆写本文件补齐——覆写版本为本文件超集。
 *
 * 桥前端：preload/webviewPerfBridge.ts（注入到所有 http/https webview guest）。
 * 注册入口：ipc/index.ts 的 registerAllHandlers。
 */
import { ipcMain, dialog, net, BrowserWindow } from "electron";
import type { OpenDialogOptions } from "electron";
import * as fs from "fs";
import * as path from "path";
import log from "electron-log";
import type { HandlerContext } from "@shared/types/ipc";
import { readSetting } from "../db";

/** 桌面独立窗口注册表：持引用防 GC，closed 时清理。 */
const shellWindows = new Set<BrowserWindow>();

export function registerNuwaxBridgeHandlers(ctx: HandlerContext): void {
  // localFiles 仅保留宿主原生目录选择器：返回绝对路径，数据面由 nuwax 走
  // file-server（customTargetDir）HTTP 通道，主进程不做持久化与文件操作。
  ipcMain.handle("localFiles:pickDirectory", async () => {
    const win = ctx.getMainWindow();
    const options: OpenDialogOptions = {
      properties: ["openDirectory", "multiSelections"],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled
      ? { canceled: true, paths: [] as string[] }
      : { canceled: false, paths: result.filePaths };
  });

  // ---- theme：nuwax 女娲主题 → 壳原生 UI 统一 ----
  // nuwax 主题生效/让位时推送 { active, 调色板 }，转发给壳 renderer 叠加/回落
  // （antd tokens + CSS 变量）。fire-and-forget（send），无返回值语义。
  ipcMain.on("nuwax:theme-sync", (_event, payload: unknown) => {
    const safe =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    if (!safe || typeof safe.active !== "boolean") return;
    ctx.getMainWindow()?.webContents.send("nuwax:theme-changed", safe);
  });

  // ---- layout：nuwax 布局状态 → 壳（工具栏收起按钮显隐/icon 态） ----
  // secondMenuAvailable：当前页是否有二级菜单（无则隐藏收起按钮）。
  // secondMenuCollapsed：二级菜单真实收起态（壳 icon 以此为准，修 reload 失同步）。
  ipcMain.on("nuwax:layout-sync", (_event, payload: unknown) => {
    const safe =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    if (!safe) return;
    const forward: Record<string, unknown> = {};
    if (typeof safe.secondMenuAvailable === "boolean") {
      forward.secondMenuAvailable = safe.secondMenuAvailable;
    }
    if (typeof safe.secondMenuCollapsed === "boolean") {
      forward.secondMenuCollapsed = safe.secondMenuCollapsed;
    }
    if (Object.keys(forward).length === 0) return;
    ctx.getMainWindow()?.webContents.send("nuwax:layout-changed", forward);
  });

  // ---- native：新开独立窗口打开 nuwax 页面 ----
  // 智能体详情/工作流/网页应用开发/我的电脑等全屏页在主窗口会被沉浸式工具栏遮挡
  //（fixed 头部/画布类布局也无法内嵌避让），改为独立窗口承载：带系统标题栏零遮挡，
  // 注入同一 webview 桥 preload（isNuwaClaw/主题等桥能力一致），URL 追加 _shell=1
  // 标记让 nuwax 解除沉浸式专属门控（菜单避让/隐藏 logo）。
  ipcMain.handle("native:openWindow", (event, opts: { path?: unknown }) => {
    try {
      const raw = opts?.path;
      if (typeof raw !== "string" || !raw) {
        return { success: false, error: "invalid path" };
      }
      const base = event.senderFrame?.url || event.sender?.getURL?.() || "";
      if (!base) return { success: false, error: "sender url missing" };
      let target: URL;
      if (/^https?:\/\//i.test(raw)) {
        // 绝对 http(s) URL：外链（如导航"文档"），仅校验协议
        target = new URL(raw);
      } else if (raw.startsWith("/") && !raw.startsWith("//")) {
        // 站内相对路径：与发起 webview 同源拼接，杜绝任意源打开
        target = new URL(raw, base);
        if (target.origin !== new URL(base).origin) {
          return { success: false, error: "cross-origin blocked" };
        }
        // 二级页承载：same-window（默认）= 主 webview 内同窗导航（沉浸式避让，
        // 见 nuwax 侧 header-area/page-container 退让）；new-window = 独立窗口
        // （系统标题栏零遮挡，_shell=1 恢复浏览器式布局）。
        const step1 = readSetting("step1_config") as {
          secondaryPages?: "same-window" | "new-window";
        } | null;
        if (step1?.secondaryPages !== "new-window") {
          ctx.getMainWindow()?.webContents.send("nuwax:open-same-window", {
            url: target.href,
          });
          log.info("[NuwaxBridge] native:openWindow same-window", {
            path: raw,
          });
          return { success: true };
        }
        // 独立窗口标记（nuwax 据此恢复浏览器式布局：显示 logo/收起按钮、不避让）
        target.searchParams.set("_shell", "1");
      } else {
        return { success: false, error: "invalid path" };
      }

      const win = new BrowserWindow({
        width: 1280,
        height: 832,
        autoHideMenuBar: true,
        webPreferences: {
          // 与 webview guest 同一桥 preload：NuwaClawBridge 全能力（auth/theme/layout）
          preload: path.join(
            __dirname,
            "..",
            "preload",
            "webviewPerfBridge.js",
          ),
        },
      });
      shellWindows.add(win);
      win.on("closed", () => shellWindows.delete(win));
      void win.loadURL(target.href);
      win.focus();
      log.info("[NuwaxBridge] native:openWindow", { path: raw });
      return { success: true };
    } catch (error) {
      log.error("[NuwaxBridge] native:openWindow failed", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // ---- native：右键另存图片 ----
  ipcMain.handle(
    "native:saveImage",
    async (_event, opts: { url: string; filename?: string }) => {
      try {
        const { url, filename } = opts || {};
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return { success: false, error: "invalid url" };
        }

        // 默认文件名：URL 末段；非法文件名字符替换为下划线；无扩展名补 .png
        const derived =
          filename ||
          decodeURIComponent(url.split("?")[0].split("/").pop() || "") ||
          "image";
        const safeName = derived.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
        const ext = path.extname(safeName) ? "" : ".png";
        const defaultPath = `${safeName}${ext}`;

        const win = ctx.getMainWindow();
        const res = win
          ? await dialog.showSaveDialog(win, { defaultPath })
          : await dialog.showSaveDialog({ defaultPath });
        if (res.canceled || !res.filePath) {
          return { success: false, canceled: true };
        }

        // net.fetch 走 defaultSession（与 webview 同会话，携带登录态 cookie）
        const resp = await net.fetch(url, { method: "GET" });
        if (!resp.ok) {
          return { success: false, error: `http ${resp.status}` };
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(res.filePath, buf);
        log.info("[NuwaxBridge] native:saveImage saved", {
          url,
          path: res.filePath,
          bytes: buf.length,
        });
        return { success: true, path: res.filePath };
      } catch (error) {
        log.error("[NuwaxBridge] native:saveImage failed", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}
