/**
 * 禅道 2526（终端目录不对）：ttydGateway 路由 cwd 推导测试。
 *
 * 行为口径：
 * - 拼接目录 computer-project-workspace/<userId>/<projectId> 存在且非空
 *   （标识符轨道且引擎已在本机跑过）→ 原样使用（存量行为不回归）；
 * - 目录不存在 / 存在但为空（云端沙箱会话、绝对路径轨道会话的空壳）
 *   → 回退 getTtydInitialCwd()（最近活跃引擎工作区 → 配置工作区 → HOME）。
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === "home") return os.tmpdir();
      return "/mock/appdata";
    }),
    isPackaged: false,
  },
}));

vi.mock("../../db", () => ({
  readSetting: vi.fn(() => null),
}));

vi.mock("../engines/unifiedAgent", () => ({
  agentService: {
    getAgentConfig: vi.fn(() => null),
    getRecentWorkspaceDir: vi.fn(() => null),
  },
}));

const initialCwdMock = vi.fn(() => "/fallback/workspace");
vi.mock("./ttydHelper", () => ({
  getTtydInitialCwd: () => initialCwdMock(),
}));

import { isUsableWorkspaceDir, resolveRouteCwd } from "./ttydGateway";
import { agentService } from "../engines/unifiedAgent";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ttyd-gw-cwd-"));
// agentService.getAgentConfig 返回 null 时 getBaseWorkspaceDir 用 appData 兜底，
// 为可控改为直接断言拼接形态：这里通过 workspaceDir 形态构造命中目录。
const baseWorkspace = path.join(tmpRoot, "ws");
fs.mkdirSync(baseWorkspace, { recursive: true });

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("isUsableWorkspaceDir", () => {
  it("空目录 → false（QA 场景：空壳 computer-project-workspace）", () => {
    const dir = path.join(tmpRoot, "empty");
    fs.mkdirSync(dir);
    expect(isUsableWorkspaceDir(dir)).toBe(false);
  });

  it("有内容的目录 → true", () => {
    const dir = path.join(tmpRoot, "has-content");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "file.txt"), "x");
    expect(isUsableWorkspaceDir(dir)).toBe(true);
  });

  it("不存在的路径 → false", () => {
    expect(isUsableWorkspaceDir(path.join(tmpRoot, "nope"))).toBe(false);
  });

  it("文件路径（非目录）→ false", () => {
    const file = path.join(tmpRoot, "afile");
    fs.writeFileSync(file, "x");
    expect(isUsableWorkspaceDir(file)).toBe(false);
  });
});

describe("resolveRouteCwd · 禅道 2526 回退链", () => {
  it("拼接目录存在且非空 → 原样使用（存量行为不回归）", () => {
    const projDir = path.join(
      baseWorkspace,
      "computer-project-workspace",
      "1",
      "1694106",
    );
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "README.md"), "content");

    const cwd = resolveRouteCwdWithBase(baseWorkspace, "1", "1694106");
    expect(cwd).toBe(projDir);
    expect(initialCwdMock).not.toHaveBeenCalled();
    initialCwdMock.mockClear();
  });

  it("拼接目录为空（QA 场景）→ 回退 getTtydInitialCwd", () => {
    const projDir = path.join(
      baseWorkspace,
      "computer-project-workspace",
      "1",
      "1694106-empty",
    );
    fs.mkdirSync(projDir, { recursive: true }); // 存在但空
    const cwd = resolveRouteCwdWithBase(baseWorkspace, "1", "1694106-empty");
    expect(cwd).toBe("/fallback/workspace");
    expect(initialCwdMock).toHaveBeenCalled();
    initialCwdMock.mockClear();
  });

  it("拼接目录不存在（绝对路径轨道 / 云端会话）→ 回退 getTtydInitialCwd", () => {
    const cwd = resolveRouteCwdWithBase(baseWorkspace, "1", "404404");
    expect(cwd).toBe("/fallback/workspace");
    initialCwdMock.mockClear();
  });

  it("userId 轨道不对（开发代理写死 local）→ 按 projectId 反查唯一工作区", () => {
    const projDir = path.join(
      baseWorkspace,
      "computer-project-workspace",
      "6",
      "1694288",
    );
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "a.txt"), "x");

    const cwd = resolveRouteCwdWithBase(baseWorkspace, "local", "1694288");
    expect(cwd).toBe(projDir);
    expect(initialCwdMock).not.toHaveBeenCalled();
    initialCwdMock.mockClear();
  });

  it("projectId 反查多命中不猜 → 回退 getTtydInitialCwd", () => {
    for (const uid of ["8", "9"]) {
      const d = path.join(
        baseWorkspace,
        "computer-project-workspace",
        uid,
        "multi",
      );
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "a.txt"), "x");
    }
    const cwd = resolveRouteCwdWithBase(baseWorkspace, "local", "multi");
    expect(cwd).toBe("/fallback/workspace");
    initialCwdMock.mockClear();
  });
});

/**
 * 测试辅助：以指定 baseWorkspace 解析路由 cwd。
 * （getBaseWorkspaceDir 读 readSetting/agentConfig，前者 mock null，
 * 后者经 agentService.getAgentConfig 动态注入 base。）
 */
function resolveRouteCwdWithBase(
  base: string,
  userId: string,
  projectId: string,
): string {
  vi.mocked(agentService.getAgentConfig).mockReturnValue({
    workspaceDir: base,
  } as never);
  return resolveRouteCwd(userId, projectId);
}
