/**
 * i18n IPC 通道
 *
 * 提供主进程语言同步的 IPC 接口
 *
 * @version 1.0.0
 * @updated 2026-04-07
 */

import { ipcMain, webContents } from "electron";
import log from "electron-log";
import { setMainLang, getMainLang } from "../services/i18n";
import { getTrayManager } from "../window/trayManager";

/**
 * 注册 i18n IPC 通道
 */
export function registerI18nHandlers(): void {
  /**
   * 获取当前主进程语言
   * @channel i18n:getLang
   */
  ipcMain.handle("i18n:getLang", () => {
    return getMainLang();
  });

  /**
   * 切换主进程语言
   * @channel i18n:setLang
   * @param lang 语言代码
   */
  ipcMain.handle("i18n:setLang", async (_event, lang: string) => {
    try {
      const previous = getMainLang();
      const normalized =
        typeof lang === "string" && lang.trim() ? lang.trim().toLowerCase() : "";
      setMainLang(lang);
      // 通知托盘刷新菜单和 tooltip
      getTrayManager()?.refresh();
      log.info(`[IPC i18n] Language changed to: ${lang}`);
      // 壳语言切换同步 webview guest（禅道 bug 2428）：壳设置切语言只重载壳页，
      // 主界面（nuwax webview）不跟随，用户视角=「切换语言无效果」。经
      // nuwax:host-command 下发 set-lang（web 侧 hostBridgeEvents 应用并持久化
      // 到账号），短延迟后重载 guest 使新语言全量渲染（web 自身语言面板同为
      // 重载式切换）。无 webview guest（社区形态）时为 no-op。
      // 语种未变化时跳过转发：壳 renderer 启动 initI18n 每次都会 setLang 同步
      // 主进程（值与当前一致），盲目转发会让 guest 白白吃一次 set-lang+重载。
      if (normalized && normalized !== previous) {
        try {
          const guest = webContents
            .getAllWebContents()
            .find((wc) => !wc.isDestroyed() && wc.getType() === "webview");
          if (guest) {
            const guestId = guest.id;
            guest.send("nuwax:host-command", { type: "set-lang", lang });
            setTimeout(() => {
              try {
                const g = webContents.fromId(guestId);
                if (g && !g.isDestroyed()) g.reload();
              } catch {
                /* guest 已销毁则跳过重载 */
              }
            }, 800);
          }
        } catch (e) {
          log.warn("[IPC i18n] forward set-lang to webview failed:", e);
        }
      }
      return { success: true };
    } catch (error) {
      log.error("[IPC i18n] Failed to change language:", error);
      return { success: false, error: String(error) };
    }
  });

  log.info("[IPC] i18n handlers registered");
}
