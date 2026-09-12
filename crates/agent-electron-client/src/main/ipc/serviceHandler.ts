import { ipcMain } from "electron";
import { APP_NAME_IDENTIFIER } from "@shared/constants";
import { commercialLifecycle } from "../services/auth/lifecycle";
const guarded = new Set([
  "agent:init",
  "agentRunner:start",
  "lanproxy:start",
  "fileServer:start",
  "computerServer:start",
  "mcp:start",
  "ttyd:start",
  "guiServer:start",
  "sandbox:create",
  "services:restartAllExceptLanproxy",
]);
/** 单服务启动也进入会话队列，避免登出后迟到的 IPC 绕开聚合门禁。 */
export const registerServiceHandler: typeof ipcMain.handle = (
  channel,
  handler,
) => {
  ipcMain.handle(channel, async (event, ...args) => {
    if (APP_NAME_IDENTIFIER !== "nuwax" || !guarded.has(channel))
      return handler(event, ...args);
    if (!commercialLifecycle)
      return { success: false, error: "Authentication not initialized" };
    try {
      return await commercialLifecycle.run(async () => handler(event, ...args));
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
};
