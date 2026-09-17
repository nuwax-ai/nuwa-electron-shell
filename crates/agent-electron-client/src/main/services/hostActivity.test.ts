/**
 * 单元测试: hostActivity - 宿主可见性状态机（休眠控制）
 *
 * 覆盖：
 * - 纯函数：computeHostVisible / isDormancyEnabled / shouldPushHostActivity
 * - 窗口沿（minimize/restore/hide/show）→ guest 收到 host-activity 变化沿
 * - powerMonitor 沿（lock-screen/unlock-screen/suspend/resume）
 * - 去抖（同态重复事件不重复推）、休眠开关门控、resume 强制重推
 * - guest 隐藏期 attach 初始同步、销毁 guest 跳过
 *
 * 通过 mock electron / electron-log / ../db 驱动事件回调验证
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserWindow, WebContents } from "electron";

const mockPowerMonitorOn = vi.fn();

vi.mock("electron", () => ({
  BrowserWindow: class {},
  powerMonitor: {
    on: (...args: unknown[]) => mockPowerMonitorOn(...args),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let mockSettingValue: unknown = null;

vi.mock("../db", () => ({
  readSetting: (_key: string) => mockSettingValue,
}));

import {
  initHostActivity,
  attachHostActivityWindow,
  computeHostVisible,
  isDormancyEnabled,
  shouldPushHostActivity,
  _resetHostActivityForTest,
} from "./hostActivity";

// ── 测试替身 ──

type Handler = (...args: unknown[]) => void;

interface MockGuest {
  guest: WebContents;
  sent: Array<{ channel: string; payload: { type: string; visible: boolean } }>;
  destroy(): void;
}

function createMockGuest(): MockGuest {
  const sent: MockGuest["sent"] = [];
  let destroyed = false;
  const guest = {
    isDestroyed: () => destroyed,
    send: (channel: string, payload: { type: string; visible: boolean }) => {
      sent.push({ channel, payload });
    },
    once: vi.fn(),
  };
  return {
    guest: guest as unknown as WebContents,
    sent,
    destroy: () => {
      destroyed = true;
    },
  };
}

function createMockWindow(visible = true) {
  const winHandlers = new Map<string, Handler[]>();
  const wcHandlers = new Map<string, Handler[]>();
  const win = {
    isVisible: () => visible,
    on: vi.fn((ev: string, h: Handler) => {
      winHandlers.set(ev, [...(winHandlers.get(ev) ?? []), h]);
    }),
    webContents: {
      on: vi.fn((ev: string, h: Handler) => {
        wcHandlers.set(ev, [...(wcHandlers.get(ev) ?? []), h]);
      }),
    },
  };
  return {
    win: win as unknown as BrowserWindow,
    fireWin: (ev: string) => (winHandlers.get(ev) ?? []).forEach((h) => h()),
    fireAttach: (guest: WebContents) =>
      (wcHandlers.get("did-attach-webview") ?? []).forEach((h) => h({}, guest)),
  };
}

/** 从 mockPowerMonitorOn 捕获的注册里按事件名取回调 */
function firePowerEvent(name: string): void {
  const calls = mockPowerMonitorOn.mock.calls.filter(
    (c) => c[0] === name,
  ) as unknown as Array<[string, Handler]>;
  calls.forEach(([, h]) => h());
}

function hostActivityPayloads(g: MockGuest) {
  return g.sent
    .filter((s) => s.channel === "nuwax:host-command")
    .map((s) => s.payload);
}

beforeEach(() => {
  _resetHostActivityForTest();
  mockPowerMonitorOn.mockClear();
  mockSettingValue = null;
});

// ── 纯函数 ──

describe("computeHostVisible", () => {
  it("窗口可见且未锁屏 → true", () => {
    expect(computeHostVisible({ windowVisible: true, locked: false })).toBe(
      true,
    );
  });

  it("窗口隐藏/最小化 或 锁屏 → false", () => {
    expect(computeHostVisible({ windowVisible: false, locked: false })).toBe(
      false,
    );
    expect(computeHostVisible({ windowVisible: true, locked: true })).toBe(
      false,
    );
    expect(computeHostVisible({ windowVisible: false, locked: true })).toBe(
      false,
    );
  });
});

describe("isDormancyEnabled", () => {
  it("缺省/形态异常 → 默认开", () => {
    expect(isDormancyEnabled(null)).toBe(true);
    expect(isDormancyEnabled(undefined)).toBe(true);
    expect(isDormancyEnabled("garbage")).toBe(true);
    expect(isDormancyEnabled({ enabled: "yes" })).toBe(true);
    expect(isDormancyEnabled({})).toBe(true);
  });

  it("{ enabled: boolean } 按值解析", () => {
    expect(isDormancyEnabled({ enabled: false })).toBe(false);
    expect(isDormancyEnabled({ enabled: true })).toBe(true);
  });
});

describe("shouldPushHostActivity", () => {
  it("visible 沿总是下发；invisible 沿受开关门控", () => {
    expect(shouldPushHostActivity(true, false)).toBe(true);
    expect(shouldPushHostActivity(true, true)).toBe(true);
    expect(shouldPushHostActivity(false, true)).toBe(true);
    expect(shouldPushHostActivity(false, false)).toBe(false);
  });
});

// ── 窗口沿 ──

describe("attachHostActivityWindow", () => {
  it("minimize → 推 invisible；restore → 推 visible", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);

    mock.fireWin("minimize");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);

    mock.fireWin("restore");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
      { type: "host-activity", visible: true },
    ]);
  });

  it("hide（托盘隐藏）→ invisible；show → visible", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);

    mock.fireWin("hide");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);

    mock.fireWin("show");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
      { type: "host-activity", visible: true },
    ]);
  });

  it("同态重复事件去抖：minimize 后再 hide 只推一次 invisible", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);

    mock.fireWin("minimize");
    mock.fireWin("hide");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);
  });

  it("休眠控制关闭（{enabled:false}）→ minimize 不下发 invisible", () => {
    mockSettingValue = { enabled: false };
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);

    mock.fireWin("minimize");
    expect(hostActivityPayloads(g)).toEqual([]);

    // visible 沿不受开关影响：恢复仍要推，保证前端不会卡在暂停态
    mock.fireWin("restore");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: true },
    ]);
  });

  it("隐藏期 attach 的 guest 立即收到初始 invisible（--hidden 冷启动）", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    mock.fireWin("minimize");

    const g = createMockGuest();
    mock.fireAttach(g.guest);
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);
  });

  it("可见期 attach 的 guest 不收初始推送（前端默认 visible，免噪）", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    expect(hostActivityPayloads(g)).toEqual([]);
  });

  it("已销毁的 guest 被跳过且不抛错，其余 guest 正常收推", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const dead = createMockGuest();
    const alive = createMockGuest();
    mock.fireAttach(dead.guest);
    mock.fireAttach(alive.guest);

    dead.destroy();
    mock.fireWin("minimize");

    expect(hostActivityPayloads(dead)).toEqual([]);
    expect(hostActivityPayloads(alive)).toEqual([
      { type: "host-activity", visible: false },
    ]);
  });

  it("窗口创建即隐藏（isVisible=false）→ attach 后首个 guest 初始同步 invisible", () => {
    const mock = createMockWindow(false);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);
  });

  it("closed 清理 guest 登记态", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);

    mock.fireWin("closed");
    // closed 后 guests 已清空，即使状态沿再变化也无推送目标（不抛错）
    mock.fireWin("minimize");
    expect(hostActivityPayloads(g)).toEqual([]);
  });
});

// ── powerMonitor 沿 ──

describe("initHostActivity", () => {
  it("注册 lock-screen/unlock-screen/suspend/resume 四个事件，且幂等", () => {
    initHostActivity();
    initHostActivity();
    const registered = mockPowerMonitorOn.mock.calls.map((c) => c[0]);
    expect(registered).toEqual([
      "lock-screen",
      "unlock-screen",
      "suspend",
      "resume",
    ]);
  });

  it("lock-screen → invisible；unlock-screen → visible", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    initHostActivity();

    firePowerEvent("lock-screen");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);

    firePowerEvent("unlock-screen");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
      { type: "host-activity", visible: true },
    ]);
  });

  it("resume 强制重推当前态（同态也重发，治愈漂移）", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    initHostActivity();

    firePowerEvent("lock-screen");
    firePowerEvent("resume");
    // 锁屏未解锁即唤醒：状态仍 invisible，resume 强制重发一次
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
      { type: "host-activity", visible: false },
    ]);
  });

  it("锁屏 + 窗口隐藏叠加后，需 unlock 与 show 双沿才回 visible", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    initHostActivity();

    mock.fireWin("hide");
    firePowerEvent("lock-screen");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);

    firePowerEvent("unlock-screen"); // 仍隐藏 → 保持 invisible（去抖不重发）
    mock.fireWin("show"); // 可见 → visible
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
      { type: "host-activity", visible: true },
    ]);
  });
});
