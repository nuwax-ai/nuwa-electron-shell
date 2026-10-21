/**
 * 单元测试: autoUpdater - 安装类型检测
 *
 * 测试 Windows 安装类型检测逻辑（NSIS vs MSI）
 * 通过 mock electron 和 fs 模块验证 getInstallerType() / canAutoUpdate() 的行为
 *
 * 注意: detectInstallerType 是私有函数，但 getInstallerType / canAutoUpdate 已导出
 * 每个测试重置模块缓存以清除 cachedInstallerType
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──

const mockExistsSync = vi.fn((...args: unknown[]) => false);
const mockReaddirSync = vi.fn((...args: unknown[]) => [] as string[]);
const mockAppOnce = vi.fn();
const mockAppVersion = vi.fn(() => "0.9.4");
let lastFakeUpdater: any;
const mockPowerMonitorOn = vi.fn();
const mockNetRequest = vi.fn();
const mockUpdaterOn = vi.fn();
const mockUpdaterSetFeedURL = vi.fn();
const mockUpdaterCheckForUpdates = vi.fn();
const mockUpdaterDownloadUpdate = vi.fn();
const mockUpdaterQuitAndInstall = vi.fn();
const mockReadFileSync = vi.fn((..._args: unknown[]): string => {
  throw new Error("ENOENT");
});
const mockAppRelaunch = vi.fn();
const mockAppQuit = vi.fn();
const mockShowMessageBox = vi.fn();
const mockInstallLinuxDeb = vi.fn();

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

vi.mock("./linuxDebInstaller", () => ({
  installLinuxDeb: (...args: unknown[]) => mockInstallLinuxDeb(...args),
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getName: () => "NuwaClaw",
    getPath: (name: string) => {
      if (name === "exe")
        return "C:\\Users\\user\\AppData\\Local\\Programs\\NuwaClaw\\NuwaClaw.exe";
      if (name === "home") return "/home/u";
      return "";
    },
    getAppPath: () => "/app",
    getVersion: () => mockAppVersion(),
    once: (...args: unknown[]) => mockAppOnce(...args),
    relaunch: (...args: unknown[]) => mockAppRelaunch(...args),
    quit: (...args: unknown[]) => mockAppQuit(...args),
  },
  BrowserWindow: class {},
  shell: {},
  dialog: {
    showMessageBox: (...args: unknown[]) => mockShowMessageBox(...args),
  },
  net: {
    request: (...args: unknown[]) => mockNetRequest(...args),
  },
  powerMonitor: {
    on: (...args: unknown[]) => mockPowerMonitorOn(...args),
  },
}));

// electron-updater 走 require 直加载，vi.mock 拦不住（vitest 限制），
// 测试经 _setAutoUpdaterModuleLoaderForTest 注入下面这份 fake 模块
const fakeElectronUpdaterModule = () => ({
  autoUpdater: (lastFakeUpdater = {
    allowPrerelease: false,
    allowDowngrade: false,
    get channel() {
      return "latest";
    },
    set channel(_value: string) {
      this.allowDowngrade = true;
    },
    on: (...args: unknown[]) => mockUpdaterOn(...args),
    setFeedURL: (...args: unknown[]) => mockUpdaterSetFeedURL(...args),
    checkForUpdates: (...args: unknown[]) =>
      mockUpdaterCheckForUpdates(...args),
    downloadUpdate: (...args: unknown[]) => mockUpdaterDownloadUpdate(...args),
    quitAndInstall: (...args: unknown[]) => mockUpdaterQuitAndInstall(...args),
    autoDownload: false,
    autoInstallOnAppQuit: true,
  }),
});

vi.mock("@shared/constants", () => ({
  APP_DATA_DIR_NAME: ".nuwaclaw",
  LOGS_DIR_NAME: "logs",
}));

vi.mock("../db", () => ({
  readSetting: vi.fn(),
}));

vi.mock("./i18n", () => ({
  t: (key: string) => key,
}));

vi.mock("./updatePlatformUtils", () => ({
  getWindowsDownloadUrl: vi.fn(),
  getMacosDownloadUrl: vi.fn(),
  getLinuxDownloadUrl: vi.fn(),
}));

// ── Helper ──

/** 重置模块缓存并重新导入，确保 cachedInstallerType 被清除 */
async function importFresh() {
  vi.resetModules();
  return import("./autoUpdater");
}

/** 重置并导入，同时注入 fake 的 electron-updater（require 路径需走加载缝） */
async function importFreshWithUpdaterMock() {
  const mod = await importFresh();
  mod._setAutoUpdaterModuleLoaderForTest(fakeElectronUpdaterModule);
  return mod;
}

/** 让 process.platform 模拟为 win32 */
function mockWin32() {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
}

/** 让 process.platform 模拟为 darwin */
function mockDarwin() {
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
}

/** 让 process.platform 模拟为 linux */
function mockLinux() {
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
}

/** 恢复 platform */
function restorePlatform() {
  // vitest 在 Node 中 process.platform 原值已丢失，记录初始值
  // 这里不做恢复，每个测试自己设 platform
}

// ── Tests ──

describe("autoUpdater - getInstallerType & canAutoUpdate", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockReaddirSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
  });

  describe("macOS / Linux 平台", () => {
    it("macOS 应返回 'mac'", async () => {
      mockDarwin();
      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("mac");
    });

    it("Linux 应返回 'linux'", async () => {
      mockLinux();
      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("linux");
    });
  });

  describe("Windows NSIS 检测", () => {
    beforeEach(() => {
      mockWin32();
    });

    it("标准 NSIS: 存在 'Uninstall NuwaClaw.exe' 应返回 'nsis'", async () => {
      mockExistsSync.mockImplementation((...args: unknown[]) =>
        String(args[0]).includes("Uninstall NuwaClaw.exe"),
      );

      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("nsis");
    });

    it("通用 NSIS: 存在 unins000.exe 应返回 'nsis'", async () => {
      mockReaddirSync.mockReturnValue(["app.exe", "resources", "unins000.exe"]);

      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("nsis");
    });

    it("通用 NSIS: unins001.exe 也应返回 'nsis'", async () => {
      mockReaddirSync.mockReturnValue(["app.exe", "unins001.exe"]);

      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("nsis");
    });

    it("方式3: Uninstall.exe (无产品名) 应返回 'nsis'", async () => {
      mockReaddirSync.mockReturnValue(["app.exe", "Uninstall.exe"]);

      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("nsis");
    });

    it("方式3: unins.exe 应返回 'nsis'", async () => {
      mockReaddirSync.mockReturnValue(["app.exe", "unins.exe"]);

      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("nsis");
    });

    it("优先级: 标准 NSIS 优先于通用 NSIS", async () => {
      mockExistsSync.mockImplementation((...args: unknown[]) =>
        String(args[0]).includes("Uninstall NuwaClaw.exe"),
      );
      // 即使目录中也有 unins000.exe，应该先走 existsSync 的标准检测
      mockReaddirSync.mockReturnValue(["app.exe", "unins000.exe"]);

      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("nsis");
      // readdirSync 不应被调用（标准检测先命中）
      expect(mockReaddirSync).not.toHaveBeenCalled();
    });
  });

  describe("Windows MSI 检测 (注册表证据)", () => {
    beforeEach(() => {
      mockWin32();
    });

    afterEach(async () => {
      const { _setRegistryAdapterForTest } = await import("./autoUpdater");
      _setRegistryAdapterForTest(null);
    });

    /**
     * 注入 fake 注册表：keys = DisplayName 命中的键路径列表，values = 键路径 → {值名 → 数据}。
     * 须在 importFresh 之后调用（操作的是当前模块实例的注入缝）。
     */
    function stubRegistry(
      mod: typeof import("./autoUpdater"),
      keys: string[],
      values: Record<string, Record<string, string>>,
    ) {
      mod._setRegistryAdapterForTest({
        searchUninstallKeysByDisplayName: () => keys,
        queryValue: (key: string, valueName: string) =>
          values[key]?.[valueName] ?? null,
      });
    }

    it("无卸载程序文件 + 注册表 MSI 证据（msiexec）应返回 'msi'", async () => {
      mockReaddirSync.mockReturnValue(["app.exe", "resources", "locales"]);
      const mod = await importFresh();
      stubRegistry(
        mod,
        [
          "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}",
        ],
        {
          "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}":
            {
              DisplayName: "NuwaClaw",
              UninstallString:
                "MsiExec.exe /I{12345678-AAAA-BBBB-CCCC-DDDDEEEEFFFF}",
            },
        },
      );
      expect(mod.getInstallerType()).toBe("msi");
    });

    it("无卸载程序文件 + 注册表无任何证据应兜底 'nsis'（解压/绿色部署）", async () => {
      mockReaddirSync.mockReturnValue(["app.exe", "resources", "locales"]);
      const mod = await importFresh();
      stubRegistry(mod, [], {});
      expect(mod.getInstallerType()).toBe("nsis");
    });

    it("readdirSync 抛出异常 + 注册表无证据应兜底 'nsis'", async () => {
      mockReaddirSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const mod = await importFresh();
      stubRegistry(mod, [], {});
      expect(mod.getInstallerType()).toBe("nsis");
    });

    it("DisplayName 确实不存在的残留键（只是数据里带产品名）不构成证据不全：兜底 'nsis' 并缓存", async () => {
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      stubRegistry(mod, ["HKLM\\...\\Uninstall\\{STALE}"], {
        "HKLM\\...\\Uninstall\\{STALE}": {
          InstallLocation: "C:\\Apps\\NuwaClaw",
        },
      });
      expect(mod.getInstallerType()).toBe("nsis");
      expect(mod.canAutoUpdate()).toBe(true);
      // 已缓存：之后即便 reg 故障也不再探测
      mod._setRegistryAdapterForTest({
        searchUninstallKeysByDisplayName: () => {
          throw new mod.RegistryProbeError("late failure");
        },
        queryValue: () => null,
      });
      expect(mod.getInstallerType()).toBe("nsis");
    });

    it("名称匹配但没有 UninstallString 的键不是 MSI，兜底 'nsis'", async () => {
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      stubRegistry(mod, ["HKLM\\...\\Uninstall\\{K}"], {
        "HKLM\\...\\Uninstall\\{K}": { DisplayName: "NuwaClaw" },
      });
      expect(mod.getInstallerType()).toBe("nsis");
    });

    it("读取键值时 reg 瞬时故障（超时 / 无法启动）：保守判 'msi'、禁用自动更新、不抛错", async () => {
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      mod._setRegistryAdapterForTest({
        searchUninstallKeysByDisplayName: () => ["HKLM\\...\\Uninstall\\{K}"],
        queryValue: () => {
          throw new mod.RegistryProbeError(
            "reg query did not complete (ETIMEDOUT)",
          );
        },
      });
      expect(() => mod.getInstallerType()).not.toThrow();
      expect(mod.getInstallerType()).toBe("msi");
      expect(mod.canAutoUpdate()).toBe(false);
    });

    it("搜索阶段 reg 瞬时故障同样保守判 'msi'", async () => {
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      mod._setRegistryAdapterForTest({
        searchUninstallKeysByDisplayName: () => {
          throw new mod.RegistryProbeError(
            "reg query did not complete (ETIMEDOUT)",
          );
        },
        queryValue: () => null,
      });
      expect(mod.getInstallerType()).toBe("msi");
      expect(mod.canAutoUpdate()).toBe(false);
    });

    it("故障结果有退避：窗口内复用不重复同步探测，窗口后重新探测，注册表恢复即得确定结果", async () => {
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
        let searches = 0;
        let healthy = false;
        mod._setRegistryAdapterForTest({
          searchUninstallKeysByDisplayName: () => {
            searches += 1;
            if (!healthy) throw new mod.RegistryProbeError("timeout");
            return [];
          },
          queryValue: () => null,
        });
        expect(mod.getInstallerType()).toBe("msi");
        expect(mod.getInstallerType()).toBe("msi");
        expect(mod.canAutoUpdate()).toBe(false);
        expect(searches).toBe(1);

        healthy = true;
        vi.advanceTimersByTime(59_000);
        expect(mod.getInstallerType()).toBe("msi");
        expect(searches).toBe(1);

        vi.advanceTimersByTime(1_001);
        expect(mod.getInstallerType()).toBe("nsis");
        expect(searches).toBe(2);
        expect(mod.getInstallerType()).toBe("nsis");
        expect(searches).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("DisplayName 不存在的候选键不阻断后续真 MSI 键的判定，且确定结果会被缓存", async () => {
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      stubRegistry(
        mod,
        ["HKLM\\...\\Uninstall\\{NO_NAME}", "HKLM\\...\\Uninstall\\{REAL}"],
        {
          "HKLM\\...\\Uninstall\\{REAL}": {
            DisplayName: "NuwaClaw",
            UninstallString: "MsiExec.exe /I{REAL}",
          },
        },
      );
      expect(mod.getInstallerType()).toBe("msi");
      stubRegistry(mod, [], {});
      expect(mod.getInstallerType()).toBe("msi");
    });

    it("可读且名称不匹配的无关键不构成证据不全，仍按 'nsis' 兜底", async () => {
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      stubRegistry(mod, ["HKLM\\...\\Uninstall\\{OTHER}"], {
        "HKLM\\...\\Uninstall\\{OTHER}": {
          DisplayName: "Some Other Product",
          UninstallString: "MsiExec.exe /I{OTHER}",
        },
      });
      expect(mod.getInstallerType()).toBe("nsis");
    });

    it("isTransientRegFailure：reg 的非零退出码是明确的查不到，超时 / 无法启动才是瞬时故障", async () => {
      const { isTransientRegFailure } = await importFresh();
      expect(
        isTransientRegFailure(
          Object.assign(new Error("Command failed"), {
            status: 1,
            signal: null,
          }),
        ),
      ).toBe(false);
      expect(
        isTransientRegFailure(
          Object.assign(new Error("spawnSync reg ETIMEDOUT"), {
            code: "ETIMEDOUT",
            status: null,
            signal: "SIGTERM",
          }),
        ),
      ).toBe(true);
      expect(
        isTransientRegFailure(
          Object.assign(new Error("spawnSync reg ENOENT"), { code: "ENOENT" }),
        ),
      ).toBe(true);
      expect(isTransientRegFailure(undefined)).toBe(true);
    });

    it("目录为空 + 注册表无证据应兜底 'nsis'", async () => {
      mockReaddirSync.mockReturnValue([]);
      const mod = await importFresh();
      stubRegistry(mod, [], {});
      expect(mod.getInstallerType()).toBe("nsis");
    });

    it("注册表 DisplayName 带版本后缀（win-pc 真机形态 'Nuwax 1.0.24'）且 msiexec 应判 MSI", async () => {
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      stubRegistry(mod, ["HKLM\\...\\Uninstall\\{GUID}"], {
        "HKLM\\...\\Uninstall\\{GUID}": {
          DisplayName: "NuwaClaw 1.0.24",
          UninstallString: "MsiExec.exe /I{GUID}",
        },
      });
      expect(mod.getInstallerType()).toBe("msi");
    });

    it("注册表 DisplayName 子串命中他款产品（非精确匹配）不算 MSI", async () => {
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      stubRegistry(mod, ["HKLM\\...\\Uninstall\\OtherSoft"], {
        "HKLM\\...\\Uninstall\\OtherSoft": {
          DisplayName: "Some Other NuwaClaw Helper",
          UninstallString: "MsiExec.exe /I{OTHER}",
        },
      });
      expect(mod.getInstallerType()).toBe("nsis");
    });

    it("注册表命中但 UninstallString 非 msiexec（win-pc 真机 NSIS 键，tar 部署丢了卸载文件）不算 MSI", async () => {
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      stubRegistry(mod, ["HKCU\\...\\Uninstall\\Nuwax"], {
        "HKCU\\...\\Uninstall\\Nuwax": {
          DisplayName: "NuwaClaw 1.0.24",
          UninstallString:
            '"C:\\Users\\user\\AppData\\Local\\Programs\\NuwaClaw\\Uninstall NuwaClaw.exe" /currentuser',
        },
      });
      expect(mod.getInstallerType()).toBe("nsis");
    });

    it("无关文件（非卸载程序形态）不阻断注册表 MSI 判定", async () => {
      mockReaddirSync.mockReturnValue([
        "app.exe",
        "nuwaclaw.exe",
        "setup.exe",
        "uninstall.dat",
        "uninstall", // 无扩展名
        "helper.dll",
      ]);
      const mod = await importFresh();
      stubRegistry(mod, ["HKLM\\...\\Uninstall\\{GUID}"], {
        "HKLM\\...\\Uninstall\\{GUID}": {
          DisplayName: "NuwaClaw",
          UninstallString: "msiexec /X{GUID}",
        },
      });
      expect(mod.getInstallerType()).toBe("msi");
    });
  });

  describe("canAutoUpdate", () => {
    it("NSIS 应支持自动更新", async () => {
      mockWin32();
      mockExistsSync.mockImplementation((...args: unknown[]) =>
        String(args[0]).includes("Uninstall NuwaClaw.exe"),
      );

      const { canAutoUpdate } = await importFresh();
      expect(canAutoUpdate()).toBe(true);
    });

    it("真 MSI（注册表证据）不支持自动更新", async () => {
      mockWin32();
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      mod._setRegistryAdapterForTest({
        searchUninstallKeysByDisplayName: () => ["HKLM\\...\\Uninstall\\{G}"],
        queryValue: (key: string, valueName: string) =>
          key.includes("{G}") && valueName === "DisplayName"
            ? "NuwaClaw"
            : key.includes("{G}") && valueName === "UninstallString"
              ? "MsiExec.exe /I{G}"
              : null,
      });
      expect(mod.canAutoUpdate()).toBe(false);
      mod._setRegistryAdapterForTest(null);
    });

    it("解压态（无卸载程序 + 无注册表证据）应支持自动更新（2026-09-22 修复回归）", async () => {
      mockWin32();
      mockReaddirSync.mockReturnValue(["app.exe"]);
      const mod = await importFresh();
      mod._setRegistryAdapterForTest({
        searchUninstallKeysByDisplayName: () => [],
        queryValue: () => null,
      });
      expect(mod.canAutoUpdate()).toBe(true);
      mod._setRegistryAdapterForTest(null);
    });

    it("macOS 应支持自动更新", async () => {
      mockDarwin();
      const { canAutoUpdate } = await importFresh();
      expect(canAutoUpdate()).toBe(true);
    });
  });
});

describe("shouldDisableDifferentialDownload", () => {
  it("win32 未设 env 时应关闭差分下载", async () => {
    const { shouldDisableDifferentialDownload } = await importFresh();
    expect(shouldDisableDifferentialDownload("win32", {})).toBe(true);
  });

  it("win32 设 NUWAX_DISABLE_DIFF_UPDATE=0 时应开启差分下载", async () => {
    const { shouldDisableDifferentialDownload } = await importFresh();
    expect(
      shouldDisableDifferentialDownload("win32", {
        NUWAX_DISABLE_DIFF_UPDATE: "0",
      }),
    ).toBe(false);
  });

  it("win32 设 NUWAX_DISABLE_DIFF_UPDATE=1 时应关闭差分下载", async () => {
    const { shouldDisableDifferentialDownload } = await importFresh();
    expect(
      shouldDisableDifferentialDownload("win32", {
        NUWAX_DISABLE_DIFF_UPDATE: "1",
      }),
    ).toBe(true);
  });

  it("darwin 不应强制关闭差分下载", async () => {
    const { shouldDisableDifferentialDownload } = await importFresh();
    expect(shouldDisableDifferentialDownload("darwin", {})).toBe(false);
  });

  it("linux 不应强制关闭差分下载", async () => {
    const { shouldDisableDifferentialDownload } = await importFresh();
    expect(shouldDisableDifferentialDownload("linux", {})).toBe(false);
  });
});

// ── yml URL 处理逻辑测试 ──
// 测试 electron-updater generic provider 的 URL 构造行为：
// setFeedURL({ provider: "generic", url: "https://.../dir/" }) 会自动拼接 {channel}.yml
// 因此传入的 URL 必须是目录路径（以 / 结尾），而不是文件 URL

describe("autoUpdater - yml URL 处理", () => {
  // 纯函数测试：模拟 doCheckViaLatestJson 中的 URL 推导逻辑
  function deriveFeedUrl(params: {
    ymlUrl: string | null;
    updateChannel: "stable" | "beta";
    version: string;
  }): string {
    const OSS_BASE =
      "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron";
    const { ymlUrl, updateChannel, version } = params;
    // 从 yml 文件 URL 提取目录路径（electron-updater generic provider 期望目录 URL）
    const ymlDir = ymlUrl ? ymlUrl.replace(/\/[^/]+\.yml$/, "/") : null;
    return ymlDir
      ? ymlDir
      : updateChannel === "beta"
        ? `${OSS_BASE}/beta-build/prerelease-v${version}`
        : `${OSS_BASE}/electron-v${version}`;
  }

  describe("yml 文件 URL → 目录 URL 转换（供 electron-updater generic provider 使用）", () => {
    it("Windows: yml 文件 URL 应提取为目录 URL", () => {
      const ymlUrl =
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/latest.yml";
      const result = deriveFeedUrl({
        ymlUrl,
        updateChannel: "beta",
        version: "0.10.7",
      });
      expect(result).toBe(
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/",
      );
    });

    it("macOS: yml 文件 URL 应提取为目录 URL", () => {
      const ymlUrl =
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/latest-mac.yml";
      const result = deriveFeedUrl({
        ymlUrl,
        updateChannel: "beta",
        version: "0.10.7",
      });
      expect(result).toBe(
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/",
      );
    });

    it("Linux: yml 文件 URL 应提取为目录 URL", () => {
      const ymlUrl =
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/latest-linux.yml";
      const result = deriveFeedUrl({
        ymlUrl,
        updateChannel: "beta",
        version: "0.10.7",
      });
      expect(result).toBe(
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/",
      );
    });

    it("stable 通道: yml 文件 URL 应提取为目录 URL", () => {
      const ymlUrl =
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/electron-v0.10.7/latest.yml";
      const result = deriveFeedUrl({
        ymlUrl,
        updateChannel: "stable",
        version: "0.10.7",
      });
      expect(result).toBe(
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/electron-v0.10.7/",
      );
    });
  });

  describe("降级逻辑（yml 字段缺失时的 fallback）", () => {
    it("yml 字段缺失时，beta 通道应使用 beta-build/prerelease-v{version} 路径", () => {
      const result = deriveFeedUrl({
        ymlUrl: null,
        updateChannel: "beta",
        version: "0.10.7",
      });
      expect(result).toBe(
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7",
      );
    });

    it("yml 字段缺失时，stable 通道应使用 electron-v{version} 路径", () => {
      const result = deriveFeedUrl({
        ymlUrl: null,
        updateChannel: "stable",
        version: "0.10.7",
      });
      expect(result).toBe(
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/electron-v0.10.7",
      );
    });
  });

  describe("electron-updater generic provider URL 拼接验证", () => {
    // 模拟 GenericProvider 的 URL 构造行为：
    // new URL(channelFile, newBaseUrl(directoryUrl))
    // newBaseUrl 会确保目录 URL 以 / 结尾
    function simulateGenericProvider(
      channelFile: string,
      feedUrl: string,
    ): string {
      const url = new URL(feedUrl);
      if (!url.pathname.endsWith("/")) {
        url.pathname += "/";
      }
      return new URL(channelFile, url).toString();
    }

    it("目录 URL 传给 electron-updater 应拼接出正确的 yml 文件路径", () => {
      const feedUrl =
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/";
      const windowsResult = simulateGenericProvider("latest.yml", feedUrl);
      const macResult = simulateGenericProvider("latest-mac.yml", feedUrl);
      const linuxResult = simulateGenericProvider("latest-linux.yml", feedUrl);

      expect(windowsResult).toBe(
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/latest.yml",
      );
      expect(macResult).toBe(
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/latest-mac.yml",
      );
      expect(linuxResult).toBe(
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/latest-linux.yml",
      );
    });

    it("文件 URL 传给 electron-updater 会导致路径重复（Bug 演示）", () => {
      // 这是之前错误的做法：直接传文件 URL
      const fileUrl =
        "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwaclaw-electron/beta-build/prerelease-v0.10.7/latest.yml";
      const result = simulateGenericProvider("latest.yml", fileUrl);

      // URL 构造器会将 /latest.yml 当作文件名，拼接后变成 /beta-build/prerelease-v0.10.7//latest.yml/latest.yml
      // 最终标准化为 .../beta-build/prerelease-v0.10.7/latest.yml/latest.yml（路径重复）
      expect(result).toContain("latest.yml/latest.yml");
    });
  });
});

// ── 后台定时复检（获取新版本逻辑）──

describe("resolveRecheckIntervalMs", () => {
  it("未设置 env 时回默认 1h", async () => {
    const { resolveRecheckIntervalMs } = await importFresh();
    expect(resolveRecheckIntervalMs({})).toBe(60 * 60 * 1000);
  });

  it("合法值生效（QA/dev 短间隔验证）", async () => {
    const { resolveRecheckIntervalMs } = await importFresh();
    expect(
      resolveRecheckIntervalMs({ NUWAX_UPDATE_CHECK_INTERVAL_MS: "120000" }),
    ).toBe(120_000);
  });

  it("非法字符串回默认", async () => {
    const { resolveRecheckIntervalMs } = await importFresh();
    expect(
      resolveRecheckIntervalMs({ NUWAX_UPDATE_CHECK_INTERVAL_MS: "abc" }),
    ).toBe(60 * 60 * 1000);
  });

  it("0/负数视为非法回默认", async () => {
    const { resolveRecheckIntervalMs } = await importFresh();
    expect(
      resolveRecheckIntervalMs({ NUWAX_UPDATE_CHECK_INTERVAL_MS: "0" }),
    ).toBe(60 * 60 * 1000);
    expect(
      resolveRecheckIntervalMs({ NUWAX_UPDATE_CHECK_INTERVAL_MS: "-5000" }),
    ).toBe(60 * 60 * 1000);
  });

  it("正值低于下限 60s 时按下限 clamp", async () => {
    const { resolveRecheckIntervalMs } = await importFresh();
    expect(
      resolveRecheckIntervalMs({ NUWAX_UPDATE_CHECK_INTERVAL_MS: "1000" }),
    ).toBe(60_000);
  });
});

describe("shouldSkipBackgroundCheck", () => {
  it("checking/downloading/downloaded 应跳过", async () => {
    const { shouldSkipBackgroundCheck } = await importFresh();
    expect(shouldSkipBackgroundCheck("checking")).toBe(true);
    expect(shouldSkipBackgroundCheck("downloading")).toBe(true);
    expect(shouldSkipBackgroundCheck("downloaded")).toBe(true);
    expect(shouldSkipBackgroundCheck("installing")).toBe(true);
  });

  it("available 不跳过（允许刷新到更新的版本元数据）", async () => {
    const { shouldSkipBackgroundCheck } = await importFresh();
    expect(shouldSkipBackgroundCheck("available")).toBe(false);
  });

  it("idle/not-available/error 不跳过", async () => {
    const { shouldSkipBackgroundCheck } = await importFresh();
    expect(shouldSkipBackgroundCheck("idle")).toBe(false);
    expect(shouldSkipBackgroundCheck("not-available")).toBe(false);
    expect(shouldSkipBackgroundCheck("error")).toBe(false);
  });
});

describe("后台静默检查（checkForUpdates({background:true})）", () => {
  beforeEach(() => {
    mockDarwin();
    mockNetRequest.mockReset();
    mockUpdaterSetFeedURL.mockReset();
    mockUpdaterCheckForUpdates.mockReset();
    mockUpdaterCheckForUpdates.mockResolvedValue(undefined);
  });

  /** net.request 直接抛错（模拟 OSS 不可达） */
  function failNetRequest() {
    mockNetRequest.mockImplementation(() => {
      throw new Error("HTTP 502 fetching latest.json");
    });
  }

  /** net.request 回放一份 latest.json 响应 */
  function respondLatestJson(latest: Record<string, unknown>, chunks = [Buffer.from(JSON.stringify(latest))]) {
    mockNetRequest.mockImplementation((() => {
      const listeners: Record<string, (arg?: unknown) => void> = {};
      return {
        on: (event: string, cb: (arg?: unknown) => void) => {
          listeners[event] = cb;
        },
        abort: vi.fn(),
        end: () => {
          queueMicrotask(() => {
            listeners.response?.({
              statusCode: 200,
              on: (event: string, cb: (arg?: unknown) => void) => {
                if (event === "data") chunks.forEach((chunk) => cb(chunk));
                if (event === "end") cb();
              },
            });
          });
        },
      };
    }) as any);
  }

  it.each([1, 2, 3, 4, 7])("preserves UTF-8 release notes across %d-byte chunks", async (chunkSize) => {
    const latest = {
      version: "3.0.10",
      notes: "新版本就绪：更新并重启升级 🚀，繁體中文。",
      yml: { darwin: "https://example.invalid/v3.0.10/latest-mac.yml" },
    };
    const bytes = Buffer.from(JSON.stringify(latest), "utf8");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunks.push(bytes.subarray(offset, offset + chunkSize));
    }
    respondLatestJson(latest, chunks);
    const mod = await importFreshWithUpdaterMock();
    expect((await mod.checkForUpdates({ background: true })).hasUpdate).toBe(true);
    expect(mod.getUpdateState().releaseNotes).toBe(latest.notes);
  });

  it.each([
    ["3.0.10", "3.0.11-beta.1", "beta", true],
    ["3.0.11-beta.1", "3.0.11-beta.2", "beta", true],
    ["3.0.11-beta.2", "3.0.11-beta.10", "beta", true],
    ["3.0.11-beta.10", "3.0.11", "beta", true],
    ["3.0.11-beta.1", "3.0.10", "stable", false],
    ["3.0.10", "3.0.11-beta.1", "stable", false],
    ["3.0.11-beta.2", "3.0.11-beta.1", "beta", false],
    ["0.9.4", "3.0.10", "stable", true],
  ])(
    "version %s → %s, subscription %s",
    async (current, target, subscription, available) => {
      const { readSetting } = await import("../db");
      vi.mocked(readSetting).mockReturnValue(subscription);
      mockAppVersion.mockReturnValue(current as string);
      respondLatestJson({
        version: target,
        yml: { darwin: `https://example.invalid/v${target}/latest-mac.yml` },
      });
      try {
        const mod = await importFreshWithUpdaterMock();
        expect(
          (await mod.checkForUpdates({ background: true })).hasUpdate,
        ).toBe(available);
        expect(lastFakeUpdater.allowPrerelease).toBe(subscription === "beta");
        expect(lastFakeUpdater.allowDowngrade).toBe(false);
        if (available)
          expect(mockUpdaterSetFeedURL).toHaveBeenCalledWith({
            provider: "generic",
            url: `https://example.invalid/v${target}/`,
          });
        else expect(mockUpdaterCheckForUpdates).not.toHaveBeenCalled();
      } finally {
        vi.mocked(readSetting).mockReset();
        mockAppVersion.mockReturnValue("0.9.4");
      }
    },
  );

  it("rejects invalid SemVer before using the tolerant comparator", async () => {
    const { isValidUpdateVersion } = await importFresh();
    for (const value of [
      undefined,
      "",
      "3.0",
      "03.0.11",
      "3.0.11-beta.01",
      "3.0.11-beta..1",
      "3.0.11\n",
    ])
      expect(isValidUpdateVersion(value)).toBe(false);
    for (const value of [
      "3.0.11",
      "3.0.11-beta.1",
      "3.0.11-rc.1",
      "3.0.11+build.1",
    ])
      expect(isValidUpdateVersion(value)).toBe(true);
  });

  it("失败不置 error 态：保持初始 idle", async () => {
    failNetRequest();
    const mod = await importFreshWithUpdaterMock();
    const result = await mod.checkForUpdates({ background: true });
    expect(result.hasUpdate).toBe(false);
    expect(mod.getUpdateState().status).toBe("idle");
  });

  it("失败保住先前 available 状态（版本与 notes 不丢）", async () => {
    respondLatestJson({
      version: "0.9.5",
      notes: "release notes",
      pub_date: "2026-09-16T00:00:00Z",
    });
    const mod = await importFreshWithUpdaterMock();
    await mod.checkForUpdates();
    expect(mod.getUpdateState().status).toBe("available");

    mockNetRequest.mockReset();
    failNetRequest();
    await mod.checkForUpdates({ background: true });
    const state = mod.getUpdateState();
    expect(state.status).toBe("available");
    expect(state.version).toBe("0.9.5");
    expect(state.releaseNotes).toBe("release notes");
  });

  it("成功路径推 available 并携带全量元数据", async () => {
    respondLatestJson({
      version: "0.9.5",
      notes: "release notes",
      pub_date: "2026-09-16T00:00:00Z",
      yml: {
        darwin:
          "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron/beta-build/prerelease-v0.9.5/latest-mac.yml",
      },
    });
    const mod = await importFreshWithUpdaterMock();
    const result = await mod.checkForUpdates({ background: true });
    expect(result.hasUpdate).toBe(true);
    const state = mod.getUpdateState();
    expect(state.status).toBe("available");
    expect(state.version).toBe("0.9.5");
    expect(state.releaseDate).toBe("2026-09-16T00:00:00Z");
    expect(state.releaseNotes).toBe("release notes");
    expect(mockUpdaterSetFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron/beta-build/prerelease-v0.9.5/",
    });
  });

  it("手动检查（非 background）失败仍置 error 态（回归）", async () => {
    failNetRequest();
    const mod = await importFreshWithUpdaterMock();
    await mod.checkForUpdates();
    expect(mod.getUpdateState().status).toBe("error");
  });
});

describe("后台复检调度器（initAutoUpdater）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockDarwin();
    mockNetRequest.mockReset();
    mockNetRequest.mockImplementation(() => {
      throw new Error("HTTP 502 fetching latest.json");
    });
    mockUpdaterDownloadUpdate.mockReset();
    mockUpdaterDownloadUpdate.mockResolvedValue(undefined);
    mockAppOnce.mockReset();
    mockPowerMonitorOn.mockReset();
    process.env.NUWAX_UPDATE_CHECK_INTERVAL_MS = "60000";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.NUWAX_UPDATE_CHECK_INTERVAL_MS;
  });

  it("启动 1s 首查 + 间隔后复检 + before-quit 停摆", async () => {
    const mod = await importFreshWithUpdaterMock();
    mod.initAutoUpdater(() => null);
    expect(mockNetRequest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(mockNetRequest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockNetRequest).toHaveBeenCalledTimes(1);
    expect(
      mod.getBackgroundCheckDebugInfo().lastBackgroundCheckAt,
    ).not.toBeNull();
    expect(
      mod.getBackgroundCheckDebugInfo().nextBackgroundCheckAt,
    ).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockNetRequest).toHaveBeenCalledTimes(2);

    // before-quit 清定时器，调度链停止
    const quitHandler = mockAppOnce.mock.calls.find(
      (c) => c[0] === "before-quit",
    )?.[1] as (() => void) | undefined;
    expect(quitHandler).toBeTypeOf("function");
    quitHandler!();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockNetRequest).toHaveBeenCalledTimes(2);
    expect(mod.getBackgroundCheckDebugInfo().nextBackgroundCheckAt).toBeNull();
  });

  it("downloading 态跳过复检但调度链不断", async () => {
    const mod = await importFreshWithUpdaterMock();
    mod.initAutoUpdater(() => null);

    // 进入 downloading 态（electron-updater mock 不发事件，状态停在 downloading）
    await mod.downloadUpdate();
    expect(mod.getUpdateState().status).toBe("downloading");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockNetRequest).not.toHaveBeenCalled();
    expect(
      mod.getBackgroundCheckDebugInfo().nextBackgroundCheckAt,
    ).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockNetRequest).not.toHaveBeenCalled();
  });

  it("注册 powerMonitor resume 唤醒补查（30s 延迟）", async () => {
    const mod = await importFreshWithUpdaterMock();
    mod.initAutoUpdater(() => null);
    expect(mockPowerMonitorOn).toHaveBeenCalledWith(
      "resume",
      expect.any(Function),
    );

    const resumeCb = mockPowerMonitorOn.mock.calls.find(
      (c) => c[0] === "resume",
    )![1] as () => void;
    resumeCb();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mockNetRequest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockNetRequest).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// installUpdate：安装前清理必须 await 完成后才 quitAndInstall——
// fire-and-forget 会与秒级退出竞速，树杀（每引擎最长 5s）被截断而残留进程。
// ────────────────────────────────────────────────────────────────────────────
describe("installUpdate — 安装前清理 await 语义", () => {
  beforeEach(() => {
    mockWin32();
    mockExistsSync.mockImplementation((...args: unknown[]) =>
      String(args[0]).includes("Uninstall NuwaClaw.exe"),
    );
    mockUpdaterQuitAndInstall.mockClear();
  });

  it("cleanup 未完成前不调 quitAndInstall，完成后才安装", async () => {
    vi.useFakeTimers();
    try {
      const { initAutoUpdater, installUpdate } =
        await importFreshWithUpdaterMock();

      let resolveCleanup!: () => void;
      const cleanupGate = new Promise<void>((r) => (resolveCleanup = r));
      let cleanupFinished = false;
      initAutoUpdater(
        () => null,
        async () => {
          await cleanupGate;
          cleanupFinished = true;
        },
        () => {},
      );

      const pending = installUpdate();
      await Promise.resolve();
      // 清理挂起中：不得触发安装
      expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
      expect(cleanupFinished).toBe(false);

      resolveCleanup();
      const result = await pending;
      expect(result.success).toBe(true);
      expect(cleanupFinished).toBe(true);
      expect(mockUpdaterQuitAndInstall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("清理被卡死时 10s 上限放行安装（不拖死安装流程）", async () => {
    vi.useFakeTimers();
    try {
      const { initAutoUpdater, installUpdate } =
        await importFreshWithUpdaterMock();

      initAutoUpdater(
        () => null,
        () => new Promise<void>(() => {}), // 永不 resolve
        () => {},
      );

      const pending = installUpdate();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.success).toBe(true);
      expect(mockUpdaterQuitAndInstall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Linux deb：不走 electron-updater 的同步 pkexec，由 linuxDebInstaller 接管安装
// ────────────────────────────────────────────────────────────────────────────
describe("Linux deb 安装形态", () => {
  const DEB_PATH =
    "/home/u/.cache/nuwaclaw-updater/pending/NuwaClaw-0.9.5-amd64.deb";

  function mockDebPackage(type = "deb") {
    mockLinux();
    (process as any).resourcesPath = "/opt/NuwaClaw/resources";
    mockReadFileSync.mockImplementation((...args: unknown[]) => {
      if (String(args[0]) === "/opt/NuwaClaw/resources/package-type")
        return `${type}\n`;
      throw new Error("ENOENT");
    });
  }

  function emitUpdaterEvent(name: string, payload: unknown) {
    const handler = mockUpdaterOn.mock.calls.find((c) => c[0] === name)?.[1] as
      | ((info: unknown) => void)
      | undefined;
    expect(handler).toBeTypeOf("function");
    handler!(payload);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockUpdaterOn.mockClear();
    mockUpdaterQuitAndInstall.mockClear();
    mockAppRelaunch.mockClear();
    mockAppQuit.mockClear();
    mockInstallLinuxDeb.mockReset();
    mockReadFileSync.mockReset();
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockNetRequest.mockImplementation(() => {
      throw new Error("offline");
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (process as any).resourcesPath;
  });

  it("package-type 为 deb 时识别为 deb 安装，AppImage 与其他平台不是", async () => {
    mockDebPackage();
    expect((await importFresh()).isLinuxDebInstall()).toBe(true);

    mockDebPackage("AppImage");
    expect((await importFresh()).isLinuxDebInstall()).toBe(false);

    mockLinux();
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect((await importFresh()).isLinuxDebInstall()).toBe(false);

    mockDarwin();
    expect((await importFresh()).isLinuxDebInstall()).toBe(false);
  });

  it("deb 安装关闭退出时自动安装，避免普通退出触发同步 pkexec 卡住", async () => {
    mockDebPackage();
    const mod = await importFreshWithUpdaterMock();
    mod.initAutoUpdater(() => null);
    expect(lastFakeUpdater.autoInstallOnAppQuit).toBe(false);

    mockDebPackage("AppImage");
    const mod2 = await importFreshWithUpdaterMock();
    mod2.initAutoUpdater(() => null);
    expect(lastFakeUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("安装由 linuxDebInstaller 接管：授权后清理，成功后重启，不调 quitAndInstall", async () => {
    mockDebPackage();
    const mod = await importFreshWithUpdaterMock();
    const markQuitting = vi.fn();
    const cleanup = vi.fn(async () => {});
    mod.initAutoUpdater(() => null, cleanup, markQuitting);
    emitUpdaterEvent("update-downloaded", {
      version: "0.9.5",
      downloadedFile: DEB_PATH,
    });
    mockInstallLinuxDeb.mockImplementation(async (options: any) => {
      expect(markQuitting).not.toHaveBeenCalled();
      await options.beforeInstall();
      expect(markQuitting).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      return { ok: true };
    });

    const result = await mod.installUpdate();

    expect(result).toEqual({ success: true });
    expect(mockInstallLinuxDeb).toHaveBeenCalledWith(
      expect.objectContaining({
        debPath: DEB_PATH,
        logPath: "/home/u/.nuwaclaw/logs/update-install.log",
        askpassTitle: "Claw.AutoUpdater.linuxAuthTitle",
      }),
    );
    expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
    expect(mockAppRelaunch).toHaveBeenCalledTimes(1);
    expect(mockAppQuit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["auth-failed", "Claw.AutoUpdater.linuxAuthFailed"],
    ["no-askpass", "Claw.AutoUpdater.linuxManualInstall"],
    ["install-failed", "Claw.AutoUpdater.linuxInstallFailed"],
  ])("%s 时返回错误且不重启", async (reason, errorKey) => {
    mockDebPackage();
    const mod = await importFreshWithUpdaterMock();
    mod.initAutoUpdater(() => null);
    emitUpdaterEvent("update-downloaded", {
      version: "0.9.5",
      downloadedFile: DEB_PATH,
    });
    mockInstallLinuxDeb.mockResolvedValue({ ok: false, reason });

    const result = await mod.installUpdate();

    expect(result).toEqual({ success: false, error: errorKey });
    expect(mockAppRelaunch).not.toHaveBeenCalled();
    expect(mockAppQuit).not.toHaveBeenCalled();
    expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
  });

  it("尚未下载完成时不启动安装", async () => {
    mockDebPackage();
    const mod = await importFreshWithUpdaterMock();
    mod.initAutoUpdater(() => null);

    const result = await mod.installUpdate();

    expect(result.success).toBe(false);
    expect(mockInstallLinuxDeb).not.toHaveBeenCalled();
  });

  it("安装进行中重复点击不会再次启动安装", async () => {
    mockDebPackage();
    const mod = await importFreshWithUpdaterMock();
    mod.initAutoUpdater(() => null);
    emitUpdaterEvent("update-downloaded", {
      version: "0.9.5",
      downloadedFile: DEB_PATH,
    });
    let finish!: (value: unknown) => void;
    mockInstallLinuxDeb.mockReturnValue(new Promise((r) => (finish = r)));

    const first = mod.installUpdate();
    const second = await mod.installUpdate();
    expect(second.success).toBe(false);
    expect(mockInstallLinuxDeb).toHaveBeenCalledTimes(1);

    finish({ ok: true });
    expect(await first).toEqual({ success: true });
  });
});

describe("Windows / macOS 可选一键更新策略", () => {
  function emit(name: string, info: any = {}) {
    const handler = mockUpdaterOn.mock.calls.find(
      (call) => call[0] === name,
    )?.[1] as Function;
    expect(handler).toBeTypeOf("function");
    handler(info);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockWin32();
    mockExistsSync.mockImplementation((file) =>
      String(file).includes("Uninstall NuwaClaw.exe"),
    );
    mockUpdaterOn.mockClear();
    mockUpdaterDownloadUpdate.mockReset();
    mockUpdaterQuitAndInstall.mockReset();
    mockUpdaterCheckForUpdates.mockReset();
    mockShowMessageBox.mockReset().mockResolvedValue({ response: 0 });
    mockUpdaterDownloadUpdate.mockImplementation(async () => {
      emit("update-downloaded", {
        version: "0.9.5",
        downloadedFile: "C:/cache/update.exe",
      });
      return ["C:/cache/update.exe"];
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.NUWAX_UPDATE_SERVER;
  });

  async function setup(enabled = true, cleanup = vi.fn(async () => {})) {
    const mod = await importFreshWithUpdaterMock();
    mod.initAutoUpdater(
      () => null,
      cleanup,
      () => {},
      { installAfterDownload: enabled },
    );
    emit("update-available", { version: "0.9.5" });
    return { mod, cleanup };
  }

  it("默认分步策略只下载，不自动清理或安装", async () => {
    const { mod, cleanup } = await setup(false);
    await mod.downloadUpdate();
    expect(mod.getUpdateState()).toMatchObject({
      status: "downloaded",
      installAfterDownload: false,
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
  });

  it("一次下载操作串起校验、清理、可见安装，并保留当前目录", async () => {
    const { mod, cleanup } = await setup();
    expect(await mod.downloadUpdate()).toEqual({ success: true });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mockUpdaterQuitAndInstall).toHaveBeenCalledWith(false, true);
    expect(lastFakeUpdater.installDirectory).toBe(
      "C:\\Users\\user\\AppData\\Local\\Programs\\NuwaClaw",
    );
    expect(lastFakeUpdater.autoRunAppAfterInstall).toBe(true);
    expect(mod.getUpdateState()).toMatchObject({
      status: "installing",
      installAfterDownload: true,
    });
  });

  it("两个入口同时点击、检查更新及安装后的再次点击均不重复执行", async () => {
    let finish!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { mod } = await setup(true, cleanup);
    const first = mod.downloadUpdate();
    const second = mod.installUpdate();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    expect(await mod.checkForUpdates()).toMatchObject({
      alreadyChecking: true,
    });
    expect(mockUpdaterCheckForUpdates).not.toHaveBeenCalled();
    expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    await mod.downloadUpdate();
    expect(mockUpdaterDownloadUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdaterQuitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("已有已校验缓存时，安装入口直接复用，不再次下载", async () => {
    const { mod } = await setup();
    emit("update-downloaded", {
      version: "0.9.5",
      downloadedFile: "C:/cache/update.exe",
    });
    await mod.installUpdate();
    expect(mockUpdaterDownloadUpdate).not.toHaveBeenCalled();
    expect(mockUpdaterQuitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("下载或校验失败不清理、不安装，下一次点击可以重试", async () => {
    const { mod, cleanup } = await setup();
    mockUpdaterDownloadUpdate.mockRejectedValueOnce(
      new Error("checksum mismatch"),
    );
    expect(await mod.downloadUpdate()).toEqual({
      success: false,
      error: "checksum mismatch",
    });
    expect(mod.getUpdateState()).toMatchObject({
      status: "error",
      error: "checksum mismatch",
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
    expect(await mod.downloadUpdate()).toEqual({ success: true });
    expect(mockUpdaterDownloadUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdaterQuitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("macOS 未启用策略时保持分步安装", async () => {
    mockDarwin();
    const { mod, cleanup } = await setup(false);
    await mod.downloadUpdate();
    expect(mod.getUpdateState().installAfterDownload).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
  });

  it("macOS 下载校验完成前不退出，完成后一次清理并安装，不写入 NSIS 路径", async () => {
    mockDarwin();
    let finish!: () => void;
    mockUpdaterDownloadUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            emit("update-downloaded", {
              version: "0.9.5",
              downloadedFile: "/cache/update.zip",
            });
            resolve();
          };
        }),
    );
    const { mod, cleanup } = await setup();
    expect(mod.getUpdateState().installAfterDownload).toBe(true);
    const first = mod.downloadUpdate();
    const second = mod.installUpdate();
    await vi.waitFor(() =>
      expect(mockUpdaterDownloadUpdate).toHaveBeenCalledTimes(1),
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
    finish();
    expect(await first).toEqual({ success: true });
    expect(await second).toEqual({ success: true });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mockUpdaterQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(mockUpdaterQuitAndInstall).toHaveBeenCalledWith(false, true);
    expect(lastFakeUpdater.installDirectory).toBeUndefined();
    expect(lastFakeUpdater.autoRunAppAfterInstall).toBe(true);
    expect(mockShowMessageBox).not.toHaveBeenCalled();
    await mod.installUpdate();
    expect(mockUpdaterQuitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("macOS 已下载时直接复用缓存；下载校验失败留在当前版本并允许重试", async () => {
    mockDarwin();
    const { mod, cleanup } = await setup();
    mockUpdaterDownloadUpdate.mockRejectedValueOnce(
      new Error("checksum mismatch"),
    );
    expect(await mod.downloadUpdate()).toEqual({
      success: false,
      error: "checksum mismatch",
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
    emit("update-downloaded", {
      version: "0.9.5",
      downloadedFile: "/cache/update.zip",
    });
    expect(await mod.installUpdate()).toEqual({ success: true });
    expect(mockUpdaterDownloadUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdaterQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(lastFakeUpdater.installDirectory).toBeUndefined();
  });

  it("Linux 即使设置策略也保持分步安装", async () => {
    mockLinux();
    const { mod } = await setup();
    await mod.downloadUpdate();
    expect(mod.getUpdateState().installAfterDownload).toBe(false);
    expect(mockUpdaterQuitAndInstall).not.toHaveBeenCalled();
  });

  it.each(["win32", "darwin"])(
    "%s 菜单/托盘只确认一次，下载完成后不再弹第二次安装确认",
    async (platform) => {
      if (platform === "darwin") mockDarwin();
      process.env.NUWAX_UPDATE_SERVER = "http://127.0.0.1:45678";
      const { readSetting } = await import("../db");
      vi.mocked(readSetting).mockReturnValue("stable");
      const { mod } = await setup();
      mockUpdaterCheckForUpdates.mockResolvedValue({
        updateInfo: { version: "0.9.5" },
      });
      await mod.showUpdateDialogFlow();
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(mockUpdaterQuitAndInstall).toHaveBeenCalledTimes(1);
    },
  );

  it("后台复检遵循同一个自定义源，不覆盖为默认 OSS 源", async () => {
    process.env.NUWAX_UPDATE_SERVER = "http://127.0.0.1:45678";
    const { readSetting } = await import("../db");
    vi.mocked(readSetting).mockReturnValue("stable");
    mockNetRequest.mockClear();
    mockUpdaterCheckForUpdates.mockResolvedValue({
      updateInfo: { version: "0.9.5" },
    });
    const { mod } = await setup();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockUpdaterCheckForUpdates).toHaveBeenCalledTimes(1);
    expect(mockNetRequest).not.toHaveBeenCalled();
    expect(mod.getUpdateState()).toMatchObject({
      status: "available",
      version: "0.9.5",
    });
  });
});
