/**
 * 认证服务 (Electron 版)
 * 管理用户登录状态、ConfigKey/SavedKey 存储
 * 使用 window.electronAPI.settings 替代 Tauri Store
 */

import { message } from "antd";
import {
  registerClient,
  ClientRegisterParams,
  ClientRegisterResponse,
  SandboxValue,
} from "./api";
import {
  APP_NAME_IDENTIFIER,
  AUTH_KEYS,
  LOCAL_HOST_URL,
  DEFAULT_AGENT_RUNNER_PORT,
  DEFAULT_FILE_SERVER_PORT,
  DEFAULT_GUI_MCP_PORT,
  DEFAULT_ADMIN_SERVER_PORT,
  DEFAULT_TTYD_PORT,
} from "@shared/constants";
import { syncSessionCookie } from "../utils/sessionUrl";
import { logger } from "../utils/logService";
import {
  getDomainTokenKey,
  normalizeDomainForTokenKey,
  getNuwaxAccessTokenKey,
} from "@shared/utils/domain";
import { t } from "./i18n";

// ========== 类型定义 ===
export interface AuthUserInfo {
  id?: number;
  username: string;
  displayName?: string;
  avatar?: string;
  email?: string;
  phone?: string;
  currentDomain?: string;
}

// ========== 存储辅助函数 ===
async function settingsGet<T>(key: string): Promise<T | null> {
  try {
    const value = await window.electronAPI?.settings.get(key);
    return (value as T) ?? null;
  } catch {
    return null;
  }
}

async function settingsSet(key: string, value: unknown): Promise<void> {
  await window.electronAPI?.settings.set(key, value);
}

// 域名标准化使用共享函数 normalizeDomainForTokenKey
// 保留别名以兼容现有调用
const normalizeDomain = normalizeDomainForTokenKey;

// ========== 存储操作 ===
async function getUsername(): Promise<string | null> {
  return settingsGet<string>(AUTH_KEYS.USERNAME);
}

async function setUsername(value: string): Promise<void> {
  await settingsSet(AUTH_KEYS.USERNAME, value);
}

async function getConfigKey(): Promise<string | null> {
  return settingsGet<string>(AUTH_KEYS.CONFIG_KEY);
}

async function setConfigKey(value: string): Promise<void> {
  await settingsSet(AUTH_KEYS.CONFIG_KEY, value);
}

async function getSavedKey(
  domain?: string,
  username?: string,
): Promise<string | null> {
  // 域名级键未命中时必须回落全局 auth.saved_key：quickInit/手工种子只写全局键，
  // 而 username（JWT sub 补齐）常已存在——若无回落，reg 会带不上 savedKey，
  // 后端在无有效凭据时报「动态认证码或密码不能为空」。
  if (domain && username) {
    const key = `${AUTH_KEYS.SAVED_KEYS_PREFIX}${normalizeDomain(domain)}_${username}`;
    const domainKey = await settingsGet<string>(key);
    if (domainKey) return domainKey;
  }
  return settingsGet<string>(AUTH_KEYS.SAVED_KEY);
}

async function setSavedKey(
  value: string,
  domain?: string,
  username?: string,
): Promise<void> {
  if (domain && username) {
    const key = `${AUTH_KEYS.SAVED_KEYS_PREFIX}${normalizeDomain(domain)}_${username}`;
    await settingsSet(key, value);
  }
  await settingsSet(AUTH_KEYS.SAVED_KEY, value);
}

async function getUserInfo(): Promise<AuthUserInfo | null> {
  return settingsGet<AuthUserInfo>(AUTH_KEYS.USER_INFO);
}

async function setUserInfo(value: AuthUserInfo): Promise<void> {
  await settingsSet(AUTH_KEYS.USER_INFO, value);
}

async function setOnlineStatus(value: boolean): Promise<void> {
  await settingsSet(AUTH_KEYS.ONLINE_STATUS, value);
}

async function saveServerConfig(
  serverHost: string,
  serverPort: number,
): Promise<void> {
  await settingsSet(AUTH_KEYS.LANPROXY_SERVER_HOST, serverHost);
  await settingsSet(AUTH_KEYS.LANPROXY_SERVER_PORT, serverPort);

  // 同步到 lanproxy_config（LanproxySettings 可编辑的配置）
  // clientKey 不存入 lanproxy_config，始终从 auth.saved_key 读取（参考 Tauri 客户端）
  const existing =
    await settingsGet<Record<string, unknown>>("lanproxy_config");
  await settingsSet("lanproxy_config", {
    ...existing,
    serverIp: serverHost.replace(/^https?:\/\//, ""),
    serverPort,
    enabled: true,
  });

  logger.info("Lanproxy server config saved", "Auth", {
    serverHost,
    serverPort,
  });
}

async function clearAuthInfo(): Promise<void> {
  await settingsSet(AUTH_KEYS.USERNAME, null);
  await settingsSet(AUTH_KEYS.CONFIG_KEY, null);
  await settingsSet(AUTH_KEYS.USER_INFO, null);
  await settingsSet(AUTH_KEYS.ONLINE_STATUS, null);
  await settingsSet(AUTH_KEYS.AUTH_TOKEN, null);
  // savedKey 属派生缓存（lanproxy clientKey），主进程 auth:clear 统一清理
}

// ========== 获取本地沙箱配置 ===
async function getLocalSandboxValue(): Promise<SandboxValue> {
  const step1Config = (await window.electronAPI?.settings.get(
    "step1_config",
  )) as {
    agentPort?: number;
    fileServerPort?: number;
    guiMcpPort?: number;
    adminServerPort?: number;
    ttydPort?: number;
  } | null;

  return {
    hostWithScheme: LOCAL_HOST_URL,
    agentPort: step1Config?.agentPort ?? DEFAULT_AGENT_RUNNER_PORT,
    vncPort: 0, // vncPort 未启用
    fileServerPort: step1Config?.fileServerPort ?? DEFAULT_FILE_SERVER_PORT,
    guiMcpPort: step1Config?.guiMcpPort ?? DEFAULT_GUI_MCP_PORT,
    // Admin Server 已合并到 Computer Server，端口与 agentPort 相同
    adminServerPort: step1Config?.agentPort ?? DEFAULT_AGENT_RUNNER_PORT,
    // ttyd Web 终端端口（仅回环监听）
    ttydPort: step1Config?.ttydPort ?? DEFAULT_TTYD_PORT,
    apiKey: "",
    maxUsers: 1,
  };
}

// ========== 错误处理 ===
/**
 * 获取友好的错误信息
 */
export function getAuthErrorMessage(error: any): string {
  if (error?.message) {
    return error.message;
  }

  if (error?.data?.message) {
    return error.data.message;
  }

  const errorCodeMessages: Record<string, string> = {
    "1001": t("Claw.Auth.error.userNotFound"),
    "1002": t("Claw.Auth.error.wrongPassword"),
    "1003": t("Claw.Auth.error.accountDisabled"),
    "2001": t("Claw.Auth.error.clientNotFound"),
    "2002": t("Claw.Auth.error.clientDisabled"),
    "2003": t("Claw.Auth.error.configNotFound"),
    "4010": t("Claw.Auth.error.loginExpired"),
    "4011": t("Claw.Auth.error.loginExpired"),
    "9999": t("Claw.Auth.error.systemError"),
  };
  if (error?.data?.code && errorCodeMessages[error.data.code]) {
    return errorCodeMessages[error.data.code];
  }

  if (error?.status === 403) return t("Claw.Auth.error.forbidden");
  if (error?.status === 404) return t("Claw.Auth.error.notFound");
  if (error?.status === 500) return t("Claw.Auth.error.serverError");

  return t("Claw.Auth.error.loginFailed");
}

// ========== 域名标准化 ===
export function normalizeServerHost(input: string): string {
  let value = input.trim();
  if (!value) return value;
  value = value.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

/** 解 JWT payload 取 sub（用户名/手机号）。仅解码不验签——鉴权由后端完成，
 * 壳侧只取填充字段；非 JWT/解析失败返回 null。 */
export function decodeJwtSub(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof json.sub === "string" && json.sub ? json.sub : null;
  } catch {
    return null;
  }
}

/** 读指定域的 webview 登录 token（桥键空间 nuwax.accessToken.<origin>）。 */
async function getWebviewToken(domain: string): Promise<string | null> {
  const key = getNuwaxAccessTokenKey(domain);
  if (!key) return null;
  const token = await settingsGet<string>(key);
  return typeof token === "string" && token ? token : null;
}

/**
 * 检查是否已登录
 * savedKey 认证场景下 username/password 可为空，以 configKey 为准
 */
export async function isLoggedIn(): Promise<boolean> {
  const configKey = await getConfigKey();
  return !!configKey;
}

/**
 * 获取当前登录信息
 */
export async function getCurrentAuth(): Promise<{
  username: string | null;
  configKey: string | null;
  userInfo: AuthUserInfo | null;
  isLoggedIn: boolean;
}> {
  const username = await getUsername();
  const configKey = await getConfigKey();
  const userInfo = await getUserInfo();
  const isLogged = !!configKey;

  return {
    username,
    configKey,
    userInfo,
    isLoggedIn: isLogged,
  };
}

/**
 * 退出登录
 */
export async function logout(): Promise<void> {
  await clearAuthInfo();
  message.info(t("Claw.Auth.loggedOut"));
}

/**
 * 同步本地配置到后端（调用 reg 接口）。
 * reg 返回内容可能会变化（如 serverHost、serverPort 等），本函数会将本次返回的最新值写入配置并返回，调用方应在 reg 成功后再启动服务，以使用最新配置。
 * 凭证：webview 登录 token（Bearer，apiRequest 按域注入）优先；savedKey 为
 * 派生缓存兜底（quickInit 无界面部署仅种子 savedKey）。密码不持久化。
 */
export async function syncConfigToServer(options?: {
  suppressToast?: boolean;
}): Promise<ClientRegisterResponse | null> {
  if (APP_NAME_IDENTIFIER === "nuwax") {
    try {
      return await window.electronAPI!.services.syncConfig();
    } catch {
      return null;
    }
  }
  const suppressToast = options?.suppressToast === true;

  // 读取 domain，优先级：step1_config.serverHost > lanproxy.server_host。
  // 说明：
  // 1) step1_config.serverHost 表示"用户访问业务系统的域名"（企业登录/默认域名）；
  // 2) lanproxy.server_host 表示"代理链路连接地址"（reg 返回的 serverHost）；
  // 3) 这里仍保留旧优先级用于请求 reg 与读取 savedKey，避免影响既有同步流程。
  const step1Config = (await window.electronAPI?.settings.get(
    "step1_config",
  )) as {
    serverHost?: string;
  } | null;
  const lanproxyHost = await settingsGet<string>(
    AUTH_KEYS.LANPROXY_SERVER_HOST,
  );
  const rawDomain = step1Config?.serverHost || lanproxyHost || "";
  const domain = normalizeServerHost(rawDomain);

  // webview 登录态为唯一事实源：token（桥键空间，webview 登录后同步）优先，
  // savedKey 为派生缓存兜底。username 缺失时从 JWT sub 补齐（域名级 savedKey
  // 按 username 分键，需落一份才能跨会话命中）。
  const token = await getWebviewToken(domain);
  const storedUsername = await getUsername();
  const sub = token ? decodeJwtSub(token) : null;
  const username = storedUsername || sub || "";
  if (sub && !storedUsername) {
    await setUsername(sub);
  }
  const savedKey = await getSavedKey(domain, username || undefined);

  // 无 token（未登录）且无 savedKey（未注册/部署未种子）→ 无凭证可 reg
  if (!token && !savedKey) {
    logger.warn(
      "No webview token & no savedKey, skip reg (not logged in)",
      "SyncConfig",
    );
    return null;
  }

  const deviceId = await window.electronAPI?.app.getDeviceId();
  const params: ClientRegisterParams = {
    username,
    password: "", // 密码不持久化；Bearer（apiRequest 按域注入）+ savedKey 兼容
    ...(savedKey ? { savedKey } : {}),
    deviceId: deviceId || undefined,
    sandboxConfigValue: await getLocalSandboxValue(),
  };

  const loadingKey = "syncConfigLoading";
  if (!suppressToast) {
    message.loading({
      content: t("Claw.Auth.syncingConfig"),
      key: loadingKey,
      duration: 0,
    });
  }

  try {
    const response = await registerClient(params, {
      baseUrl: domain,
      suppressToast: true,
    });

    await setConfigKey(response.configKey);
    await setSavedKey(response.configKey, domain, username || undefined);
    await setOnlineStatus(response.online);

    // 持久化 token（用于 webview cookie 同步）
    // 尝试立即同步，成功后清除；失败时保留给后续页面打开时重试
    if (response.token) {
      await settingsSet(AUTH_KEYS.AUTH_TOKEN, response.token);
      const domainTokenKey = domain ? getDomainTokenKey(domain) : null;
      if (domain) {
        await settingsSet(domainTokenKey!, response.token);
      }
      logger.info("Login token cache written", "SyncConfig", {
        domain,
        domainTokenKey,
      });
      try {
        await syncSessionCookie(domain, response.token);
        await settingsSet(AUTH_KEYS.AUTH_TOKEN, null);
        logger.info("Token synced to webview cookie", "SyncConfig");
      } catch (e) {
        logger.warn("Token sync failed, keeping local cache", "SyncConfig", e);
      }
    } else {
      logger.warn(
        "reg did not return token, cannot sync webview login state",
        "SyncConfig",
        {
          domain,
        },
      );
    }

    // 使用本次 reg 返回的最新 serverHost/serverPort 覆盖本地"代理配置"。
    // 注意：serverHost 是 lanproxy 链路地址，不应回写为 UI 展示/跳转使用的业务域名。
    if (response.serverHost && response.serverPort) {
      await saveServerConfig(response.serverHost, response.serverPort);
    }

    const currentUserInfo = await getUserInfo();
    // 关键修复：
    // - currentDomain 只代表"业务域名"（用于 UI 展示、会话跳转、后续登录目标）；
    // - reg 返回的 serverHost 仅用于代理配置，不参与 currentDomain 的决定；
    // - 当本次同步拿不到明确业务域名（domain 为空）时，保留已有 currentDomain，避免被代理地址"间接覆盖"。
    const preservedCurrentDomain =
      domain || currentUserInfo?.currentDomain || undefined;
    await setUserInfo({
      ...currentUserInfo,
      id: response.id,
      username: username || "",
      displayName: response.name,
      currentDomain: preservedCurrentDomain,
    } as AuthUserInfo);

    if (!suppressToast) {
      message.success({
        content: t("Claw.Auth.configSyncedSuccess"),
        key: loadingKey,
      });
    }
    logger.info("Config sync successful", "SyncConfig", {
      configKey: response.configKey,
      online: response.online,
    });
    return response;
  } catch (error: any) {
    const errorMessage = getAuthErrorMessage(error);
    logger.error("Config sync failed", "SyncConfig", error);
    if (!suppressToast) {
      message.error({ content: errorMessage, key: loadingKey });
    }
    return null;
  }
}
