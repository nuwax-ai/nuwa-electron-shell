/**
 * 单元测试: NuwaClawBridge host 命名空间（宿主产品身份）
 *
 * 锁定契约：
 * 1. 桥上暴露 host.getProduct()，返回值 = APP_NAME_IDENTIFIER（构建期 define 注入），
 *    nuwax 前端凭此区分宿主是 nuwaclaw（社区版）还是 nuwax（商业版）。
 * 2. 测试进程不注入 NUWAX_APP_IDENTIFIER → 社区版缺省 "nuwaclaw"；
 *    商业版构建（nuwax）时 define 联动，同一断言自动跟随。
 */

import { describe, it, expect, vi } from "vitest";

// vi.mock 工厂会被提升到模块顶部执行，共享 Map 须经 vi.hoisted 创建
const { exposed } = vi.hoisted(() => ({
  exposed: new Map<string, Record<string, unknown>>(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, api: Record<string, unknown>) => {
      exposed.set(key, api);
    }),
  },
  ipcRenderer: {
    on: vi.fn(),
    send: vi.fn(),
    invoke: vi.fn(),
  },
}));

import "./webviewPerfBridge";
import { APP_NAME_IDENTIFIER } from "@shared/constants";

describe("NuwaClawBridge host 命名空间", () => {
  it("桥上暴露 host.getProduct()，值与 APP_NAME_IDENTIFIER 一致", () => {
    const bridge = exposed.get("NuwaClawBridge") as {
      host?: { getProduct(): string };
    };
    expect(bridge).toBeDefined();
    expect(typeof bridge?.host?.getProduct).toBe("function");
    expect(bridge?.host?.getProduct()).toBe(APP_NAME_IDENTIFIER);
  });

  it("未注入 env 时为社区版缺省身份 nuwaclaw", () => {
    expect(APP_NAME_IDENTIFIER).toBe("nuwaclaw");
  });
});
