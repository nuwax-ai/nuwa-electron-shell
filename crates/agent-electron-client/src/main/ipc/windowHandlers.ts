import { BrowserWindow, ipcMain, webContents } from "electron";
import type { HandlerContext } from "@shared/types/ipc";

/** 编辑菜单动作集合：菜单项/自绘菜单共用，作用于活跃 webContents。 */
export type EditAction =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll";

export const EDIT_ACTIONS: Record<
  EditAction,
  (wc: Electron.WebContents) => void
> = {
  undo: (wc) => wc.undo(),
  redo: (wc) => wc.redo(),
  cut: (wc) => wc.cut(),
  copy: (wc) => wc.copy(),
  paste: (wc) => wc.paste(),
  selectAll: (wc) => wc.selectAll(),
};

/**
 * 编辑命令的目标 webContents 路由器。
 *
 * 裸 role 在 webview 场景不可用（enable 校验与命令分发都落在宿主页面，
 * 可编辑内容全在 guest 里，菜单恒灰且 Cmd+C/V/Z/A 失灵），因此编辑命令
 * 一律显式路由：
 * 1. 焦点 webContents（guest 聚焦时即 guest——二级窗口聚焦时为其自身 guest，
 *    保留"在哪编辑就作用在哪"的语义）；
 * 2. 焦点无效时兜底主窗口的 webview guest（覆盖 Win 自绘菜单点击后焦点
 *    已被宿主按钮抢走的场景），经 hostWebContents 归属精确筛选；
 * 3. 最后兜底主窗口宿主 webContents 自身（无 guest 时的壳内输入场景）。
 */
export function resolveEditTargetWebContents(
  getMainWindow: () => BrowserWindow | null,
): Electron.WebContents | null {
  const focused = webContents.getFocusedWebContents();
  if (focused && !focused.isDestroyed()) {
    return focused;
  }
  const mainWin = getMainWindow();
  if (!mainWin || mainWin.isDestroyed()) {
    return null;
  }
  const guest = webContents
    .getAllWebContents()
    .find(
      (wc) =>
        !wc.isDestroyed() &&
        wc.hostWebContents === mainWin.webContents &&
        wc !== mainWin.webContents,
    );
  return guest ?? mainWin.webContents;
}

export function registerWindowHandlers(ctx: HandlerContext): void {
  ipcMain.handle("window:minimize", () => {
    ctx.getMainWindow()?.minimize();
  });

  ipcMain.handle("window:maximize", () => {
    const win = ctx.getMainWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  // 自绘三键据此切换 最大化/还原 图标（此前 preload 已调用但主进程漏注册，
  // renderer 端 .catch(()=>{}) 静默吞掉，状态恒不同步）
  ipcMain.handle("window:isMaximized", () => {
    return ctx.getMainWindow()?.isMaximized() ?? false;
  });

  ipcMain.handle("window:close", () => {
    ctx.getMainWindow()?.close();
  });

  // 自绘菜单栏「编辑」动作：路由到活跃 webContents（见 resolveEditTargetWebContents）
  ipcMain.handle("menu:editAction", (_e, action: EditAction) => {
    const fn = EDIT_ACTIONS[action];
    if (!fn) return false;
    const target = resolveEditTargetWebContents(ctx.getMainWindow);
    if (!target) return false;
    fn(target);
    return true;
  });
}
