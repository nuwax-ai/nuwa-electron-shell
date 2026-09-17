/**
 * 单元测试: constants 默认后端域覆写（NUWAX_DEFAULT_SERVER_HOST）
 *
 * nuwax-client 测试期商业构建注入测试环境域，默认域整体切换
 * （首启种子 + reg/网关反代/i18n/lanproxy 探测兜底）；不注入时回落
 * 正式域 agent.nuwax.com，社区版行为不变。构建期 define 的运行时等价物。
 */

import { describe, it, expect, afterEach, vi } from "vitest";

describe("NUWAX_DEFAULT_SERVER_HOST 注入", () => {
  afterEach(() => {
    delete process.env.NUWAX_DEFAULT_SERVER_HOST;
    vi.resetModules();
  });

  it("未注入时回落正式域", async () => {
    delete process.env.NUWAX_DEFAULT_SERVER_HOST;
    const c = await import("./constants");
    expect(c.DEFAULT_SERVER_HOST).toBe("https://agent.nuwax.com");
  });

  it("注入测试域时整体生效", async () => {
    process.env.NUWAX_DEFAULT_SERVER_HOST = "https://testagent.xspaceagi.com";
    const c = await import("./constants");
    expect(c.DEFAULT_SERVER_HOST).toBe("https://testagent.xspaceagi.com");
  });

  it("空串/纯空白按未注入处理", async () => {
    for (const raw of ["", "   "]) {
      process.env.NUWAX_DEFAULT_SERVER_HOST = raw;
      const c = await import("./constants");
      expect(c.DEFAULT_SERVER_HOST).toBe("https://agent.nuwax.com");
      vi.resetModules();
    }
  });
});
