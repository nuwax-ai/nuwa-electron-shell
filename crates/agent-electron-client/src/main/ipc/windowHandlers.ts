import { ipcMain, webContents } from "electron";
import type { HandlerContext } from "@shared/types/ipc";

/** 自绘菜单栏「编辑」动作集合（作用于当前聚焦的 webContents）。 */
type EditAction = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

const EDIT_ACTIONS: Record<EditAction, (wc: Electron.WebContents) => void> = {
  undo: (wc) => wc.undo(),
  redo: (wc) => wc.redo(),
  cut: (wc) => wc.cut(),
  copy: (wc) => wc.copy(),
  paste: (wc) => wc.paste(),
  selectAll: (wc) => wc.selectAll(),
};

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

  // 自绘菜单栏「编辑」动作：路由到焦点 webContents（webview guest 聚焦时即 guest，
  // 壳 renderer 聚焦时为壳自身），无焦点时静默忽略（与原生菜单行为一致）
  ipcMain.handle("menu:editAction", (_e, action: EditAction) => {
    const fn = EDIT_ACTIONS[action];
    if (!fn) return false;
    const focused = webContents.getFocusedWebContents();
    if (!focused || focused.isDestroyed()) return false;
    fn(focused);
    return true;
  });
}
