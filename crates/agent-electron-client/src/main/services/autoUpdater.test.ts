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
const mockPowerMonitorOn = vi.fn();
const mockNetRequest = vi.fn();
const mockUpdaterOn = vi.fn();
const mockUpdaterSetFeedURL = vi.fn();
const mockUpdaterCheckForUpdates = vi.fn();
const mockUpdaterDownloadUpdate = vi.fn();
const mockUpdaterQuitAndInstall = vi.fn();

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
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
      return "";
    },
    getAppPath: () => "/app",
    getVersion: () => "0.9.4",
    once: (...args: unknown[]) => mockAppOnce(...args),
  },
  BrowserWindow: class {},
  shell: {},
  dialog: {},
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
  autoUpdater: {
    on: (...args: unknown[]) => mockUpdaterOn(...args),
    setFeedURL: (...args: unknown[]) => mockUpdaterSetFeedURL(...args),
    checkForUpdates: (...args: unknown[]) =>
      mockUpdaterCheckForUpdates(...args),
    downloadUpdate: (...args: unknown[]) => mockUpdaterDownloadUpdate(...args),
    quitAndInstall: (...args: unknown[]) => mockUpdaterQuitAndInstall(...args),
    autoDownload: false,
    autoInstallOnAppQuit: true,
  },
});

vi.mock("@shared/constants", () => ({
  APP_DATA_DIR_NAME: ".nuwaclaw",
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

  describe("Windows MSI 检测 (fallback)", () => {
    beforeEach(() => {
      mockWin32();
    });

    it("目录中无卸载程序文件应返回 'msi'", async () => {
      mockReaddirSync.mockReturnValue(["app.exe", "resources", "locales"]);

      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("msi");
    });

    it("readdirSync 抛出异常应 fallback 为 'msi'", async () => {
      mockReaddirSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("msi");
    });

    it("目录为空应返回 'msi'", async () => {
      mockReaddirSync.mockReturnValue([]);

      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("msi");
    });

    it("不应将无关文件误判为 NSIS", async () => {
      mockReaddirSync.mockReturnValue([
        "app.exe",
        "nuwaclaw.exe",
        "setup.exe",
        "uninstall.dat",
        "uninstall", // 无扩展名
        "helper.dll",
      ]);

      const { getInstallerType } = await importFresh();
      expect(getInstallerType()).toBe("msi");
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

    it("MSI 不支持自动更新", async () => {
      mockWin32();
      mockReaddirSync.mockReturnValue(["app.exe"]);

      const { canAutoUpdate } = await importFresh();
      expect(canAutoUpdate()).toBe(false);
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
  function respondLatestJson(latest: Record<string, unknown>) {
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
                if (event === "data") cb(JSON.stringify(latest));
                if (event === "end") cb();
              },
            });
          });
        },
      };
    }) as any);
  }

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

  it("启动 10s 首查 + 间隔后复检 + before-quit 停摆", async () => {
    const mod = await importFreshWithUpdaterMock();
    mod.initAutoUpdater(() => null);
    expect(mockNetRequest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
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
