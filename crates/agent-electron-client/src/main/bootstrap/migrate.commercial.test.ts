/**
 * 单元测试: migrate + 品牌注入（商业版 identifier=nuwawork）
 *
 * 模拟 NUWAX_APP_IDENTIFIER=nuwawork 构建产物行为：
 * 1. APP_DATA_DIR_NAME 派生为 .nuwawork
 * 2. .nuwaclaw → .nuwawork 整目录迁移（rename + DB/config 改名）
 * 3. 目标已有数据 → 跳过
 * 4. migrateSettingsPaths 重写 step1_config.workspaceDir 的 .nuwaclaw 前缀
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as path from "path";

// 必须在动态 import constants/migrate 之前设置（构建期 define 的运行时等价物）
process.env.NUWAX_APP_IDENTIFIER = "nuwawork";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/mock/home") },
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockExistsSync = vi.fn(() => false);
const mockRenameSync = vi.fn();
const mockCopyFileSync = vi.fn();

vi.mock("fs", () => ({
  existsSync: (p: string) => mockExistsSync(p),
  renameSync: (o: string, n: string) => mockRenameSync(o, n),
  copyFileSync: (o: string, n: string) => mockCopyFileSync(o, n),
}));

const mockReadSetting = vi.fn(() => null);
const mockWriteSetting = vi.fn();

vi.mock("../db", () => ({
  readSetting: (...args: unknown[]) => mockReadSetting(...args),
  writeSetting: (...args: unknown[]) => mockWriteSetting(...args),
}));

const mockDbPrepare = vi.fn();
const mockDbClose = vi.fn();

vi.mock("better-sqlite3", () => ({
  default: vi.fn(() => ({
    prepare: mockDbPrepare,
    close: mockDbClose,
  })),
}));

afterAll(() => {
  delete process.env.NUWAX_APP_IDENTIFIER;
});

describe("commercial branding (identifier=nuwawork)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbPrepare.mockReturnValue({ get: () => ({ count: 0 }) });
  });

  it("derives APP_DATA_DIR_NAME from injected identifier", async () => {
    const { APP_DATA_DIR_NAME } = await import("@shared/constants");
    expect(APP_DATA_DIR_NAME).toBe(".nuwawork");
  });

  it("renames .nuwaclaw → .nuwawork with db/config renames when target missing", async () => {
    const legacyDir = path.join("/mock/home", ".nuwaclaw");
    const targetDir = path.join("/mock/home", ".nuwawork");
    mockExistsSync.mockImplementation((p: string) => {
      if (p === legacyDir) return true;
      // rename 之后在同一新目录里检查旧 DB / config 文件名
      if (p === path.join(targetDir, "nuwaclaw.db")) return true;
      if (p === path.join(targetDir, "nuwawork.db")) return false;
      if (p === path.join(targetDir, "nuwaclaw.json")) return true;
      if (p === path.join(targetDir, "nuwawork.json")) return false;
      return false;
    });

    const { migrateDataDir } = await import("./migrate");
    migrateDataDir();

    expect(mockRenameSync).toHaveBeenCalledWith(legacyDir, targetDir);
    expect(mockRenameSync).toHaveBeenCalledWith(
      path.join(targetDir, "nuwaclaw.db"),
      path.join(targetDir, "nuwawork.db"),
    );
    expect(mockRenameSync).toHaveBeenCalledWith(
      path.join(targetDir, "nuwaclaw.json"),
      path.join(targetDir, "nuwawork.json"),
    );
  });

  it("skips migration when target .nuwawork already has data", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes(".nuwawork")) return true;
      return false;
    });
    mockDbPrepare.mockReturnValue({ get: () => ({ count: 5 }) });

    const { migrateDataDir } = await import("./migrate");
    migrateDataDir();

    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it("rewrites step1_config.workspaceDir legacy prefix to .nuwawork", async () => {
    mockReadSetting.mockReturnValue({
      workspaceDir: path.join("/mock/home", ".nuwaclaw", "workspace"),
    });

    const { migrateSettingsPaths } = await import("./migrate");
    migrateSettingsPaths();

    expect(mockWriteSetting).toHaveBeenCalledWith("step1_config", {
      workspaceDir: path.join("/mock/home", ".nuwawork", "workspace"),
    });
  });
});
