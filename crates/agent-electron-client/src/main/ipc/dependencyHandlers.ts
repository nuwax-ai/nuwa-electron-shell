import { ipcMain } from "electron";
import log from "electron-log";
import { isDepsSyncInProgress } from "../bootstrap/startup";

export function registerDependencyHandlers(): void {
  ipcMain.handle(
    "dependencies:checkAll",
    async (_, options?: { checkLatest?: boolean }) => {
      const { checkAllDependencies } =
        await import("../services/system/dependencies");
      log.info("[IPC] Checking all dependencies...");
      try {
        const results = await checkAllDependencies(options);
        return {
          success: true,
          results,
          syncInProgress: isDepsSyncInProgress(),
        };
      } catch (error) {
        log.error("[IPC] Dependency check failed:", error);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle("dependencies:checkNode", async () => {
    const { checkNodeVersion } =
      await import("../services/system/dependencies");
    try {
      const result = await checkNodeVersion();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle("dependencies:checkUv", async () => {
    const { checkUvVersion } = await import("../services/system/dependencies");
    try {
      const result = await checkUvVersion();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  /** 检测应用包内集成的 @nuwax-ai/mcp-proxy-ts，与 Node/uv 一起在系统环境中展示 */
  ipcMain.handle("dependencies:checkMcpProxyBundled", async () => {
    const { checkMcpProxyBundled } =
      await import("../services/system/dependencies");
    try {
      const result = await checkMcpProxyBundled();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, available: false, error: String(error) };
    }
  });

  /** 检测应用包内集成的 nuwaxcode 引擎二进制 */
  ipcMain.handle("dependencies:checkNuwaxcodeBundled", async () => {
    const { checkNuwaxcodeBundled } =
      await import("../services/system/dependencies");
    try {
      const result = await checkNuwaxcodeBundled();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, available: false, error: String(error) };
    }
  });

  /** 检测应用包内集成的 claude-code-acp-ts */
  ipcMain.handle("dependencies:checkClaudeCodeAcpBundled", async () => {
    const { checkClaudeCodeAcpBundled } =
      await import("../services/system/dependencies");
    try {
      const result = await checkClaudeCodeAcpBundled();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, available: false, error: String(error) };
    }
  });

  /** 检测应用包内集成的 nuwax-codex-acp */
  ipcMain.handle("dependencies:checkCodexAcpBundled", async () => {
    const { checkCodexAcpBundled } =
      await import("../services/system/dependencies");
    try {
      const result = await checkCodexAcpBundled();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, available: false, error: String(error) };
    }
  });

  /** 检测应用包内集成的 nuwax-file-server */
  ipcMain.handle("dependencies:checkNuwaxFileServerBundled", async () => {
    const { checkNuwaxFileServerBundled } =
      await import("../services/system/dependencies");
    try {
      const result = await checkNuwaxFileServerBundled();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, available: false, error: String(error) };
    }
  });

  ipcMain.handle(
    "dependencies:detectPackage",
    async (_, packageName: string, binName?: string) => {
      const { detectNpmPackage } =
        await import("../services/system/dependencies");
      try {
        const result = await detectNpmPackage(packageName, binName);
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    "dependencies:installPackage",
    async (
      _,
      packageName: string,
      options?: { registry?: string; version?: string },
    ) => {
      const deps = await import("../services/system/dependencies");
      const { installNpmPackage } = deps;
      log.info(`[IPC] Installing package: ${packageName}`);

      // nuwaxcode：原生二进制，走 OSS 依赖下载通道（非 npm）
      if (packageName === "nuwaxcode") {
        try {
          const { downloadNuwaxcode } =
            await import("../services/system/nuwaxcodeDownloader");
          const result = await downloadNuwaxcode();
          return {
            success: result.success,
            version: result.version,
            error: result.error,
          };
        } catch (error) {
          log.error("[IPC] nuwaxcode download failed:", error);
          return { success: false, error: String(error) };
        }
      }

      // bundled 依赖的 npm 兜底：按 required 清单映射到真实 npm 包名与版本
      const npmFallback = deps.getNpmFallbackFor(packageName);
      const target = npmFallback
        ? {
            name: npmFallback.packageName,
            version: options?.version ?? npmFallback.version,
          }
        : { name: packageName, version: options?.version };

      try {
        const result = await installNpmPackage(
          target.name,
          target.version ? { version: target.version } : undefined,
        );
        return result;
      } catch (error) {
        log.error("[IPC] Install failed:", error);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle("dependencies:installMissing", async () => {
    const { installMissingDependencies } =
      await import("../services/system/dependencies");
    log.info("[IPC] Installing missing dependencies...");
    try {
      const result = await installMissingDependencies();
      return result;
    } catch (error) {
      log.error("[IPC] Install missing failed:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle("dependencies:getAppDataDir", async () => {
    const { getAppDataDir } =
      await import("../services/system/workspaceManager");
    return getAppDataDir();
  });

  ipcMain.handle("dependencies:getRequiredList", async () => {
    const { getSetupRequiredDependencies } =
      await import("../services/system/dependencies");
    return getSetupRequiredDependencies();
  });
}
