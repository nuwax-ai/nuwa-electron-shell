/**
 * 单元测试: windowHandlers - 编辑命令目标路由
 *
 * resolveEditTargetWebContents 是「编辑命令一律显式路由活跃 webContents」的
 * 唯一裁定点（裸 role 在 webview 场景恒灰的修复）：
 * 1. 焦点 webContents 有效 → 直接用（guest 聚焦即 guest；二级窗口聚焦为其自身）；
 * 2. 焦点无效（Win 自绘菜单点击后焦点被宿主按钮抢走）→ 兜底主窗口的
 *    webview guest（按 hostWebContents 归属精确筛选，排除宿主自身）；
 * 3. 无 guest → 兜底主窗口宿主 webContents；
 * 4. 主窗口不存在/已销毁 → null。
 * 另覆盖 EDIT_ACTIONS 六命令到 webContents 方法的映射。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserWindow, WebContents } from "electron";

let mockFocused: WebContents | null = null;
let mockAll: WebContents[] = [];

vi.mock("electron", () => ({
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
  webContents: {
    getFocusedWebContents: () => mockFocused,
    getAllWebContents: () => mockAll,
  },
}));

import { EDIT_ACTIONS, resolveEditTargetWebContents } from "./windowHandlers";

function createMockWebContents(
  overrides: Partial<{
    destroyed: boolean;
    hostWebContents: WebContents | null;
  }> = {},
): WebContents {
  const { destroyed = false, hostWebContents = null } = overrides;
  return {
    isDestroyed: () => destroyed,
    hostWebContents,
  } as unknown as WebContents;
}

function createMockMainWindow(destroyed = false): BrowserWindow {
  const wc = createMockWebContents();
  return {
    isDestroyed: () => destroyed,
    webContents: wc,
  } as unknown as BrowserWindow;
}

describe("resolveEditTargetWebContents", () => {
  beforeEach(() => {
    mockFocused = null;
    mockAll = [];
  });

  it("焦点 webContents 有效时直接返回（guest 聚焦即 guest）", () => {
    const focused = createMockWebContents();
    mockFocused = focused;
    const win = createMockMainWindow();
    expect(resolveEditTargetWebContents(() => win)).toBe(focused);
  });

  it("焦点已销毁时跳过，兜底主窗口 guest", () => {
    mockFocused = createMockWebContents({ destroyed: true });
    const win = createMockMainWindow();
    const guest = createMockWebContents({
      hostWebContents: win.webContents,
    });
    mockAll = [win.webContents, guest];
    expect(resolveEditTargetWebContents(() => win)).toBe(guest);
  });

  it("无焦点时兜底主窗口 guest（Win 自绘菜单点击后焦点失守场景）", () => {
    const win = createMockMainWindow();
    const otherGuest = createMockWebContents(); // 他窗 guest，不匹配
    const guest = createMockWebContents({
      hostWebContents: win.webContents,
    });
    mockAll = [otherGuest, win.webContents, guest];
    expect(resolveEditTargetWebContents(() => win)).toBe(guest);
  });

  it("已销毁的 guest 不入选", () => {
    const win = createMockMainWindow();
    const dead = createMockWebContents({
      destroyed: true,
      hostWebContents: win.webContents,
    });
    mockAll = [dead];
    expect(resolveEditTargetWebContents(() => win)).toBe(win.webContents);
  });

  it("无 guest 时兜底主窗口宿主 webContents", () => {
    const win = createMockMainWindow();
    expect(resolveEditTargetWebContents(() => win)).toBe(win.webContents);
  });

  it("主窗口不存在返回 null", () => {
    expect(resolveEditTargetWebContents(() => null)).toBeNull();
  });

  it("主窗口已销毁返回 null", () => {
    const win = createMockMainWindow(true);
    expect(resolveEditTargetWebContents(() => win)).toBeNull();
  });
});

describe("EDIT_ACTIONS", () => {
  it.each([
    ["undo", "undo"],
    ["redo", "redo"],
    ["cut", "cut"],
    ["copy", "copy"],
    ["paste", "paste"],
    ["selectAll", "selectAll"],
  ] as const)("%s 调用 webContents.%s()", (action, method) => {
    const fn = vi.fn();
    const wc = { [method]: fn } as unknown as WebContents;
    EDIT_ACTIONS[action](wc);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
