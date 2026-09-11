/**
 * 单元测试: api (请求封装)
 *
 * 覆盖场景:
 * - fetch 超时：AbortSignal.timeout 触发后抛出可读错误（P0-3 修复验证）
 * - 正常请求：成功返回 data
 * - HTTP 错误：非 2xx 响应正确抛出
 * - API 业务错误码：非 0000 code 正确抛出
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ==================== Mocks ====================

// Mock antd message（避免 DOM 依赖）
vi.mock("antd", () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock @shared/constants
vi.mock("@shared/constants", () => ({
  DEFAULT_SERVER_HOST: "https://default.example.com",
  DEFAULT_API_TIMEOUT: 30000,
}));

// Mock i18n：让 Claw.Api.timeout 返回中文（与生产环境 Claw.Api.timeout key 的 zh-CN 翻译一致），
// 验证 P0-3 修复后抛出的错误信息确实是用户可读的中文，而不是原始的 AbortError。
vi.mock("./i18n", () => ({
  t: (key: string, ...values: unknown[]) => {
    const map: Record<string, string> = {
      "Claw.Api.timeout": "请求超时（>{0}ms），请检查网络或服务器状态",
      "Claw.Api.notLoggedIn": "未登录",
      "Claw.Api.loginExpired": "登录已过期",
      "Claw.Api.clientNotFound": "客户端不存在",
      "Claw.Api.systemError": "系统错误",
      "Claw.Errors.loginRedirect": "需要重新登录",
    };
    const template = map[key] ?? key;
    if (!values.length) return template;
    return template.replace(/\{(\d+)\}/g, (_, idx) =>
      String(values[Number(idx)] ?? ""),
    );
  },
}));

// ==================== Helpers ====================

/** 构造一个标准成功响应 */
function makeSuccessResponse<T>(data: T): Response {
  return new Response(
    JSON.stringify({ code: "0000", message: "ok", success: true, data }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** 构造一个业务错误响应（HTTP 200 但 code != 0000） */
function makeApiErrorResponse(code: string, msg: string): Response {
  return new Response(
    JSON.stringify({ code, message: msg, success: false, data: null }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// 每次需要 fresh module（避免 vi.mock 缓存影响）
async function loadApi() {
  vi.resetModules();
  return import("./api");
}

// ==================== Tests ====================

describe("apiRequest", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ---------- 正常请求 ----------

  it("请求成功时应返回 data 字段", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(makeSuccessResponse({ id: 1, name: "test" }));

    const { apiRequest } = await loadApi();
    const result = await apiRequest<{ id: number; name: string }>("/test", {
      method: "POST",
      showError: false,
    });

    expect(result).toEqual({ id: 1, name: "test" });
  });

  it("应将 AbortSignal.timeout 传入 fetch（P0-3 修复验证）", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeSuccessResponse({}));

    const { apiRequest } = await loadApi();
    await apiRequest("/test", { showError: false });

    const [, fetchOptions] = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    // 验证 signal 字段存在（AbortSignal.timeout 已挂载）
    expect(fetchOptions.signal).toBeDefined();
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });

  // ---------- 超时处理（P0-3）----------

  it('fetch 超时（TimeoutError）→ 应抛出包含"请求超时"的错误，不暴露原始 AbortError（P0-3 修复验证）', async () => {
    // 模拟 AbortSignal.timeout 触发后 fetch 抛出 TimeoutError
    const timeoutError = Object.assign(new Error("The operation timed out."), {
      name: "TimeoutError",
    });
    global.fetch = vi.fn().mockRejectedValue(timeoutError);

    const { apiRequest } = await loadApi();

    await expect(apiRequest("/test", { showError: false })).rejects.toThrow(
      /请求超时/,
    );
  });

  it("fetch AbortError → 同样转为可读超时错误（P0-3 修复验证）", async () => {
    const abortError = Object.assign(new Error("The user aborted a request."), {
      name: "AbortError",
    });
    global.fetch = vi.fn().mockRejectedValue(abortError);

    const { apiRequest } = await loadApi();

    await expect(apiRequest("/test", { showError: false })).rejects.toThrow(
      /请求超时/,
    );
  });

  it("超时时 showError=false 不弹 toast", async () => {
    const { message } = await import("antd");
    const timeoutError = Object.assign(new Error("timeout"), {
      name: "TimeoutError",
    });
    global.fetch = vi.fn().mockRejectedValue(timeoutError);

    const { apiRequest } = await loadApi();
    await expect(apiRequest("/test", { showError: false })).rejects.toThrow();

    expect(message.error).not.toHaveBeenCalled();
  });

  // ---------- HTTP 错误 ----------

  it("HTTP 非 2xx → 应抛出 HTTP 错误", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    const { apiRequest } = await loadApi();

    await expect(apiRequest("/test", { showError: false })).rejects.toThrow(
      "HTTP 500",
    );
  });

  // ---------- 业务错误码 ----------

  it("业务错误码非 0000 → 应抛出业务错误", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        makeApiErrorResponse("4010", "用户未登录，请重新登录"),
      );

    const { apiRequest } = await loadApi();

    await expect(apiRequest("/test", { showError: false })).rejects.toThrow(
      "用户未登录，请重新登录",
    );
  });

  // ---------- registerClient ----------

  it("registerClient 应正确透传参数并返回响应", async () => {
    const mockData = {
      id: 1,
      scope: "default",
      userId: 1,
      name: "Bot",
      configKey: "ck-abc",
      configValue: {},
      description: "",
      isActive: true,
      online: true,
      created: "",
      modified: "",
    };
    global.fetch = vi.fn().mockResolvedValue(makeSuccessResponse(mockData));

    const { registerClient } = await loadApi();
    const result = await registerClient(
      {
        username: "user1",
        password: "pass1",
        sandboxConfigValue: {
          agentPort: 4000,
          vncPort: 0,
          fileServerPort: 60000,
        },
      },
      { suppressToast: true },
    );

    expect(result.configKey).toBe("ck-abc");

    // 验证请求 body 包含正确参数
    const [, fetchOptions] = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const body = JSON.parse(fetchOptions.body);
    expect(body.username).toBe("user1");
    expect(body.password).toBe("pass1");
  });

  // ---------- baseUrl 前缀拼接（完整地址保障） ----------

  it("apiRequest 传 baseUrl: undefined 时应回落默认域名，不产生 undefined/ 前缀", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeSuccessResponse({}));

    const { apiRequest } = await loadApi();
    await apiRequest("/test", { baseUrl: undefined, showError: false });

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://default.example.com/test");
  });

  it("apiRequest 传空串 baseUrl 时应回落默认域名，不产生相对路径", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeSuccessResponse({}));

    const { apiRequest } = await loadApi();
    await apiRequest("/test", { baseUrl: "", showError: false });

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://default.example.com/test");
  });

  // ---------- Bearer 注入（webview 登录态为唯一事实源） ----------

  it("目标域存在 webview token 时应注入 Authorization: Bearer", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeSuccessResponse({}));
    const originalWindow = (global as any).window;
    (global as any).window = {
      electronAPI: {
        settings: {
          get: async (key: string) =>
            key === "nuwax.accessToken.https://default.example.com"
              ? "jwt-token-abc"
              : null,
        },
      },
    };

    try {
      const { apiRequest } = await loadApi();
      await apiRequest("/test", { showError: false });

      const [, fetchOptions] = (global.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(fetchOptions.headers.Authorization).toBe("Bearer jwt-token-abc");
    } finally {
      (global as any).window = originalWindow;
    }
  });

  it("目标域无 token 时不应注入 Authorization 头", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeSuccessResponse({}));
    const originalWindow = (global as any).window;
    (global as any).window = {
      electronAPI: { settings: { get: async () => null } },
    };

    try {
      const { apiRequest } = await loadApi();
      await apiRequest("/test", { showError: false });

      const [, fetchOptions] = (global.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(fetchOptions.headers.Authorization).toBeUndefined();
    } finally {
      (global as any).window = originalWindow;
    }
  });

  it("按请求的目标域取 token（跨域键空间隔离）", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeSuccessResponse({}));
    const originalWindow = (global as any).window;
    (global as any).window = {
      electronAPI: {
        settings: {
          get: async (key: string) =>
            key === "nuwax.accessToken.https://biz.example.com"
              ? "biz-jwt"
              : null,
        },
      },
    };

    try {
      const { apiRequest } = await loadApi();
      await apiRequest("/test", {
        baseUrl: "https://biz.example.com",
        showError: false,
      });

      const [, fetchOptions] = (global.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(fetchOptions.headers.Authorization).toBe("Bearer biz-jwt");
    } finally {
      (global as any).window = originalWindow;
    }
  });

  it("registerClient 配置域名为空时应回落默认域名拼出完整地址", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeSuccessResponse({
        id: 1,
        configKey: "ck-abc",
        configValue: {},
      }),
    );

    const { registerClient } = await loadApi();
    await registerClient(
      {
        username: "user1",
        password: "pass1",
        sandboxConfigValue: {
          agentPort: 4000,
          vncPort: 0,
          fileServerPort: 60000,
        },
      },
      { baseUrl: "", suppressToast: true },
    );

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://default.example.com/api/sandbox/config/reg");
  });

  it("registerClient 传入配置域名时应拼接为完整地址", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeSuccessResponse({
        id: 1,
        configKey: "ck-abc",
        configValue: {},
      }),
    );

    const { registerClient } = await loadApi();
    await registerClient(
      {
        username: "user1",
        password: "pass1",
        sandboxConfigValue: {
          agentPort: 4000,
          vncPort: 0,
          fileServerPort: 60000,
        },
      },
      { baseUrl: "https://biz.example.com", suppressToast: true },
    );

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://biz.example.com/api/sandbox/config/reg");
  });
});
