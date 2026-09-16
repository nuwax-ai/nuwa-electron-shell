/**
 * NuwaClawBridge：nuwaclaw 注入到 webview guest（nuwax）window 上的双边桥。
 * 浏览器端不存在；nuwax 消费前需判断 `window.NuwaClawBridge` 是否存在。
 * 桥前端见 preload/webviewPerfBridge.ts，后端见 main/ipc/nuwaxBridgeHandlers.ts。
 */
import type { ClientUpdateState } from "./updateTypes";
export interface NuwaClawBridgePerf {
  enabled(): boolean;
  mark(stage: string, payload?: Record<string, unknown>): void;
  markOnce(key: string, stage: string, payload?: Record<string, unknown>): void;
}

export interface NuwaClawBridgeAuth {
  /** 读取本 origin 持久化的 nuwax ACCESS_TOKEN（重启免登）。 */
  getToken(): Promise<string | null>;
  /** nuwax 登录成功后持久化 token。 */
  persistToken(token: string): Promise<boolean>;
  /** nuwax 登出联动：清除本 origin 的持久化 token。 */
  clear(): Promise<boolean>;
}

export interface NuwaClawBridgeNative {
  /** 右键另存图片：系统保存对话框 + 下载。 */
  saveImage(
    url: string,
    filename?: string,
  ): Promise<{ success: boolean; path?: string; error?: string }>;
  /** 新开独立窗口打开 nuwax 页面（智能体详情/工作流/我的电脑等全屏页）。 */
  openWindow(path: string): Promise<{ success: boolean; error?: string }>;
  /** 打开宿主壳「客户端配置」设置弹窗（壳 renderer 承载，经主进程转发）。 */
  openClientSettings(): Promise<{ success: boolean; error?: string }>;
}

export interface NuwaClawBridgeHost {
  /** 宿主产品标识：nuwaclaw（社区版）/ nuwax（商业版；存量宿主可能返回历史值 nuwawork）。构建期注入，非 IPC。 */
  getProduct(): string;
}

export interface NuwaClawBridgeUpdater {
  /** 当前更新状态 + 宿主客户端版本（hostVersion），无更新器时 null。 */
  getState(): Promise<ClientUpdateState | null>;
  /** 触发一次更新检查（与关于页同源）。 */
  check(): Promise<{ hasUpdate?: boolean; error?: string } | null>;
  /** 下载更新（幂等）。 */
  download(): Promise<{ success: boolean; error?: string }>;
  /** 重启并安装（仅 downloaded 状态有意义）。 */
  install(): Promise<{ success: boolean; error?: string }>;
}

export interface NuwaClawBridgeMeta {
  /** 上报前端构建信息（关于页「界面版本」展示）。 */
  syncWebInfo(payload: { appVersion: string; gitHash?: string }): void;
}

export interface TitlebarDragRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NuwaClawBridgeLayout {
  setSecondMenuAvailable?(available: boolean): void;
  setSecondMenuCollapsed?(collapsed: boolean): void;
  /** guest 声明顶部空白区；真正的 app-region 由宿主 renderer 渲染。 */
  setTitlebarDragRegions?(regions: TitlebarDragRegion[]): void;
}

export interface NuwaClawBridge {
  perf?: NuwaClawBridgePerf;
  auth?: NuwaClawBridgeAuth;
  native?: NuwaClawBridgeNative;
  updater?: NuwaClawBridgeUpdater;
  meta?: NuwaClawBridgeMeta;
  layout?: NuwaClawBridgeLayout;
  host?: NuwaClawBridgeHost;
}

declare global {
  interface Window {
    NuwaClawBridge?: NuwaClawBridge;
  }
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: string;
          preload?: string;
          httpreferrer?: string;
          useragent?: string;
        },
        HTMLElement
      >;
    }
  }
}
