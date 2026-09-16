/**
 * 单元测试：frontendDistVersion —— 内置 dist 的 version.json 读取与路径解析。
 * 路径优先级须与 overlay 网关 resolveNuwaxDistDir 同口径（packaged → resources、
 * dev → env NUWAX_FRONTEND_DIST → 缺省壳仓 nuwax/dist）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mocks = vi.hoisted(() => ({
  isPackaged: { value: false },
  appPath: { value: "/app/crates/agent-electron-client" },
  resourcesPath: { value: "/app/Contents/Resources" },
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged.value;
    },
    getAppPath: () => mocks.appPath.value,
    getPath: () => "/tmp",
  },
}));

import {
  getBundledDistVersion,
  resolveFrontendDistDir,
} from "./frontendDistVersion";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dist-version-"));
const originalResourcesPath = process.resourcesPath;
const setResourcesPath = (value: string | undefined) => {
  // 只读属性的测试桩写入（node 环境无 Electron resourcesPath）
  (process as { resourcesPath?: string }).resourcesPath = value;
};

beforeEach(() => {
  mocks.isPackaged.value = false;
  mocks.appPath.value = path.join(tempRoot, "crates/agent-electron-client");
  fs.mkdirSync(mocks.appPath.value, { recursive: true });
  delete process.env.NUWAX_FRONTEND_DIST;
  // process.resourcesPath 仅 Electron 运行时存在，node 测试环境补 stub
  setResourcesPath(mocks.resourcesPath.value);
});

afterEach(() => {
  // 模块级缓存按进程驻留：用 vi.resetModules + 动态 re-import 复位
  vi.resetModules();
  setResourcesPath(originalResourcesPath);
});

/** 带缓存复位的重新加载（每个用例独立模块态）。 */
async function fresh() {
  const mod = await import("./frontendDistVersion");
  return mod;
}

function writeDist(distDir: string, payload: unknown) {
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, "version.json"),
    JSON.stringify(payload),
    "utf8",
  );
}

describe("resolveFrontendDistDir", () => {
  it("packaged → resources/nuwax-dist", async () => {
    mocks.isPackaged.value = true;
    const { resolveFrontendDistDir } = await fresh();
    expect(resolveFrontendDistDir()).toBe(
      path.join(mocks.resourcesPath.value, "nuwax-dist"),
    );
  });

  it("dev + NUWAX_FRONTEND_DIST env → env 指定目录（优先于缺省路径）", async () => {
    const envDir = path.join(tempRoot, "custom-dist");
    process.env.NUWAX_FRONTEND_DIST = envDir;
    const { resolveFrontendDistDir } = await fresh();
    expect(resolveFrontendDistDir()).toBe(path.resolve(envDir));
  });

  it("dev 缺省 → 壳仓根/nuwax/dist", async () => {
    const { resolveFrontendDistDir } = await fresh();
    expect(resolveFrontendDistDir()).toBe(
      path.resolve(tempRoot, "nuwax", "dist"),
    );
  });
});

describe("getBundledDistVersion", () => {
  it("读取 version.json 的 version/gitHash", async () => {
    const distDir = path.resolve(tempRoot, "custom-dist");
    writeDist(distDir, {
      name: "nuwax-frontend",
      version: "1.2.0",
      gitHash: "abc1234",
    });
    process.env.NUWAX_FRONTEND_DIST = distDir;
    const { getBundledDistVersion } = await fresh();
    expect(getBundledDistVersion()).toEqual({
      name: "nuwax-frontend",
      version: "1.2.0",
      gitHash: "abc1234",
    });
  });

  it("version.json 缺失 → null", async () => {
    process.env.NUWAX_FRONTEND_DIST = path.join(tempRoot, "empty-dist");
    const { getBundledDistVersion } = await fresh();
    expect(getBundledDistVersion()).toBeNull();
  });

  it("载荷损坏/缺 version 字段 → null（不抛）", async () => {
    const distDir = path.resolve(tempRoot, "bad-dist");
    writeDist(distDir, { name: "nuwax-frontend" });
    process.env.NUWAX_FRONTEND_DIST = distDir;
    const { getBundledDistVersion } = await fresh();
    expect(getBundledDistVersion()).toBeNull();
  });
});
