export interface SandboxValue {
  hostWithScheme?: string;
  agentPort: number;
  vncPort: number;
  fileServerPort: number;
  guiMcpPort: number;
  adminServerPort: number;
  /**
   * ttyd Web 终端端口（仅回环监听），与 step1_config.ttydPort 同步上报。
   */
  ttydPort?: number;
  apiKey?: string;
  maxUsers?: number;
}

/**
 * 客户端注册请求参数
 */
export interface ClientRegisterParams {
  username: string;
  password: string;
  savedKey?: string;
  deviceId?: string;
  sandboxConfigValue: SandboxValue;
}

/**
 * 客户端注册响应数据 (SandboxConfigDto)
 */
export interface ClientRegisterResponse {
  id: number;
  scope: string;
  userId: number;
  name: string;
  configKey: string;
  configValue: SandboxValue;
  description: string;
  isActive: boolean;
  online: boolean;
  created: string;
  modified: string;
  /** 服务器地址（客户端连接用） */
  serverHost?: string;
  /** 服务器端口（客户端连接用） */
  serverPort?: number;
  /** 登录态 token，用于 webview cookie 同步 */
  token?: string;
}
