/**
 * 单元测试: auth（webview 登录态为唯一事实源）
 *
 * 覆盖场景:
 * - isLoggedIn / getCurrentAuth 的 configKey 判定
 * - syncConfigToServer 的凭证 guard：webview token（桥键空间）优先，savedKey 兜底
 * - JWT sub 补齐 username、域名级 savedKey 选取
 * - logout 清登录态（savedKey 属派生缓存保留，主进程 auth:clear 负责全清）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ==================== Mocks ====================

// In-memory settings store (模拟 SQLite)
let store: Record<string, unknown> = {};

const mockSettingsGet = vi.fn(async (key: string) => store[key] ?? null);
const mockSettingsSet = vi.fn(async (key: string, value: unknown) => {
  if (value === null || value === undefined) {
    delete store[key];
  } else {
    store[key] = value;
  }
});

// Mock window.electronAPI
vi.stubGlobal("window", {
  electronAPI: {
    app: {
      getDeviceId: vi.fn(async () => "mock-device-id"),
    },
    settings: {
      get: mockSettingsGet,
      set: mockSettingsSet,
    },
  },
});

// Mock antd message
vi.mock("antd", () => ({
  message: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock registerClient API
const mockRegisterClient = vi.fn();
vi.mock("./api", () => ({
  registerClient: (...args: unknown[]) => mockRegisterClient(...args),
}));

// ==================== Helpers ====================

const DOMAIN = "https://testagent.xspaceagi.com";
const TOKEN_KEY = `nuwax.accessToken.${DOMAIN}`;
const SAVED_KEY = "test-saved-key-abc123";
const CONFIG_KEY_FROM_SERVER = "server-returned-config-key";

/** 伪造 JWT（payload 含 sub），auth.ts 仅解码不验签 */
function makeJwt(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `header.${payload}.signature`;
}

function makeRegisterResponse(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 1,
    scope: "default",
    userId: 1,
    name: "TestUser",
    configKey: CONFIG_KEY_FROM_SERVER,
    configValue: {},
    description: "",
    isActive: true,
    online: true,
    created: "",
    modified: "",
    serverHost: "proxy.example.com",
    serverPort: 4900,
    ...overrides,
  };
}

// ==================== Tests ====================

describe("auth - webview 登录态为唯一事实源", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store = {};
    mockRegisterClient.mockResolvedValue(makeRegisterResponse());
  });

  // 每次需要 fresh module（避免内部状态缓存）
  async function loadAuth() {
    vi.resetModules();
    return import("./auth");
  }

  // ---------- isLoggedIn ----------

  describe("isLoggedIn", () => {
    it("应以 configKey 为准，不依赖 username", async () => {
      store["auth.config_key"] = "some-config-key";
      const { isLoggedIn } = await loadAuth();
      expect(await isLoggedIn()).toBe(true);
    });

    it("configKey 为空时应返回 false", async () => {
      store["auth.username"] = "user1";
      const { isLoggedIn } = await loadAuth();
      expect(await isLoggedIn()).toBe(false);
    });
  });

  // ---------- getCurrentAuth ----------

  describe("getCurrentAuth", () => {
    it("应以 configKey 判断 isLoggedIn，与 username 无关", async () => {
      store["auth.config_key"] = "key";
      store["auth.user_info"] = { username: "", displayName: "Bot" };
      const { getCurrentAuth } = await loadAuth();
      const auth = await getCurrentAuth();
      expect(auth.isLoggedIn).toBe(true);
      expect(auth.username).toBeNull(); // username key 未设置
    });
  });

  // ---------- decodeJwtSub ----------

  describe("decodeJwtSub", () => {
    it("应解出 JWT payload 的 sub", async () => {
      const { decodeJwtSub } = await loadAuth();
      expect(decodeJwtSub(makeJwt("1801147397"))).toBe("1801147397");
    });

    it("非 JWT 形态应返回 null", async () => {
      const { decodeJwtSub } = await loadAuth();
      expect(decodeJwtSub("not-a-jwt")).toBeNull();
      expect(decodeJwtSub("")).toBeNull();
    });
  });

  // ---------- syncConfigToServer ----------

  describe("syncConfigToServer", () => {
    it("无 webview token 且无 savedKey → 应拒绝（未登录且未注册）", async () => {
      store["auth.username"] = "user1";
      store["step1_config"] = { serverHost: DOMAIN };

      const { syncConfigToServer } = await loadAuth();
      const result = await syncConfigToServer({ suppressToast: true });

      expect(result).toBeNull();
      expect(mockRegisterClient).not.toHaveBeenCalled();
    });

    it("有 savedKey（无 token）→ 应正常同步（quickInit 部署种子场景）", async () => {
      store["auth.username"] = "user1";
      // domain+username 级键（多账号隔离设计：有 username 时不回退全局 key）
      store["auth.saved_keys.testagent.xspaceagi.com_user1"] = SAVED_KEY;
      store["step1_config"] = { serverHost: DOMAIN };

      const { syncConfigToServer } = await loadAuth();
      const result = await syncConfigToServer({ suppressToast: true });

      expect(result).not.toBeNull();
      expect(result!.configKey).toBe(CONFIG_KEY_FROM_SERVER);
      expect(mockRegisterClient).toHaveBeenCalledTimes(1);

      const [params] = mockRegisterClient.mock.calls[0];
      expect(params.username).toBe("user1");
      expect(params.password).toBe("");
      expect(params.savedKey).toBe(SAVED_KEY);
    });

    it("有 webview token（无 savedKey）→ 应同步且不携带 savedKey（首登注册路径）", async () => {
      // Bearer 由 apiRequest 按域注入（此处 mock 了 api 层），body 不需要凭证
      store[TOKEN_KEY] = makeJwt("1801147397");
      store["step1_config"] = { serverHost: DOMAIN };

      const { syncConfigToServer } = await loadAuth();
      const result = await syncConfigToServer({ suppressToast: true });

      expect(result).not.toBeNull();
      const [params] = mockRegisterClient.mock.calls[0];
      expect(params.username).toBe("1801147397"); // JWT sub 补齐
      expect(params.password).toBe("");
      expect(params.savedKey).toBeUndefined();
      // username 应从 sub 落库（域名级 savedKey 分键依赖）
      expect(store["auth.username"]).toBe("1801147397");
    });

    it("token 与 savedKey 并存 → username+savedKey 兼容发送", async () => {
      store[TOKEN_KEY] = makeJwt("1801147397");
      store["auth.username"] = "1801147397";
      store["auth.saved_keys.testagent.xspaceagi.com_1801147397"] = SAVED_KEY;
      store["step1_config"] = { serverHost: DOMAIN };

      const { syncConfigToServer } = await loadAuth();
      const result = await syncConfigToServer({ suppressToast: true });

      expect(result).not.toBeNull();
      const [params] = mockRegisterClient.mock.calls[0];
      expect(params.username).toBe("1801147397");
      expect(params.savedKey).toBe(SAVED_KEY);
    });

    it("有 username → 应使用域名级 savedKey 而非全局 key（多账号隔离）", async () => {
      store["auth.username"] = "user1";
      store["auth.saved_keys.testagent.xspaceagi.com_user1"] =
        "domain-specific-key";
      store["auth.saved_key"] = "global-key-different";
      store["step1_config"] = { serverHost: DOMAIN };

      const { syncConfigToServer } = await loadAuth();
      const result = await syncConfigToServer({ suppressToast: true });

      expect(result).not.toBeNull();
      const [params] = mockRegisterClient.mock.calls[0];
      expect(params.savedKey).toBe("domain-specific-key");
    });

    it("reg 成功后 configKey/savedKey 应落库（lanproxy 派生凭证）", async () => {
      store["auth.username"] = "user1";
      store["auth.saved_keys.testagent.xspaceagi.com_user1"] = SAVED_KEY;
      store["step1_config"] = { serverHost: DOMAIN };

      const { syncConfigToServer } = await loadAuth();
      await syncConfigToServer({ suppressToast: true });

      expect(store["auth.config_key"]).toBe(CONFIG_KEY_FROM_SERVER);
      expect(store["auth.saved_key"]).toBe(CONFIG_KEY_FROM_SERVER);
      expect(store["auth.saved_keys.testagent.xspaceagi.com_user1"]).toBe(
        CONFIG_KEY_FROM_SERVER,
      );
    });
  });

  // ---------- logout ----------

  describe("logout", () => {
    it("应清登录态键（configKey/username/userInfo），savedKey 派生缓存保留给主进程统一清理", async () => {
      store["auth.config_key"] = "key";
      store["auth.username"] = "user1";
      store["auth.saved_key"] = SAVED_KEY;

      const { logout, isLoggedIn } = await loadAuth();
      await logout();

      expect(await isLoggedIn()).toBe(false);
      expect(store["auth.config_key"]).toBeUndefined();
      expect(store["auth.username"]).toBeUndefined();
      // renderer 侧 logout 不动 savedKey；全清在 main 桥 auth:clear
      expect(store["auth.saved_key"]).toBe(SAVED_KEY);
    });
  });
});
