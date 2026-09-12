/**
 * NuwaxHostWebview - 客户端主窗口宿主组件（沉浸式）。
 *
 * 全屏嵌入 nuwax PC 站点（含登录页），作为客户端主界面。webview 占满整窗（含顶部），
 * 顶部覆盖层（红绿灯后工具栏 TrafficLightToolbar）由 App.tsx 渲染，承载窗口拖拽、
 * webview 导航（后退/前进/刷新）、二级菜单收起、设置入口与账号/更新状态。
 *
 * 本组件通过 forwardRef 暴露 webview 导航与宿主命令下发能力，并经 onNavStateChange
 * 上报 canGoBack/canGoForward 供工具栏按钮启用态。鉴权交给 nuwax 自身 /Login +
 * NuwaClawBridge.auth（ACCESS_TOKEN 双向同步，重启免登）。
 *
 * 沉浸式：mac 沿用原生红绿灯（main.ts titleBarStyle:"hidden"）；Win/Linux 窗口控制
 * 由 TrafficLightToolbar 自绘（不再在此组件渲染）。
 */
import React, {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import { APP_DISPLAY_NAME, DEFAULT_SERVER_HOST } from "@shared/constants";
import { Spin } from "antd";
import { normalizeServerHost } from "../../services/core/auth";
import { buildHomeUrl } from "../../services/utils/sessionUrl";
import { logger } from "../../services/utils/logService";

/**
 * 开发联调时加载的本地 nuwax dev server。
 * 仅 vite dev 模式（import.meta.env.DEV）启用：webview 直接加载本地 nuwax，
 * 便于实时调试前端改动；生产仍走 step1_config.serverHost / DEFAULT_SERVER_HOST。
 */
const NUWAX_DEV_HOST = "http://localhost:3000";

/** 暴露给 App.tsx 的 webview 控制句柄（工具栏 icon 经此调用）。 */
export interface NuwaxHostWebviewHandle {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  /** 下发宿主命令到 nuwax（经 webviewPerfBridge 的 nuwax:host-command 通道）。 */
  sendHostCommand: (payload: unknown) => void;
  /** 同窗导航（二级页承载）：主 webview 加载目标 URL。 */
  navigate: (url: string) => void;
}

export interface NuwaxHostWebviewProps {
  /** 递增时强制 reload webview（兼容旧刷新入口；工具栏刷新优先走 handle.reload()）。 */
  reloadKey?: number;
  /** webview 导航能力变化上报（canGoBack/canGoForward），供工具栏按钮启用态。 */
  onNavStateChange?: (state: {
    canGoBack: boolean;
    canGoForward: boolean;
  }) => void;
}

const NuwaxHostWebview = forwardRef<
  NuwaxHostWebviewHandle,
  NuwaxHostWebviewProps
>(function NuwaxHostWebview({ reloadKey = 0, onNavStateChange }, ref) {
  const [url, setUrl] = useState("");
  const [ua, setUa] = useState<string | undefined>();
  const webviewRef = useRef<HTMLElement | null>(null);

  // 自定义 UA：保留产品/<version> 标识，便于 nuwax 侧识别客户端环境。
  // 主进程可能已把默认 UA 的 @nuwax-ai/nuwaclaw/<ver> 替换为产品名——追加前
  // 查重，避免同一 token 出现两次（社区版含空格名走此追加路径不变）
  useEffect(() => {
    window.electronAPI?.app
      .getVersion()
      .then((v) => {
        const token = `${APP_DISPLAY_NAME}/${v}`;
        const next = navigator.userAgent.includes(token)
          ? navigator.userAgent
          : `${navigator.userAgent} ${token}`;
        setUa(next);
        logger.info(`webview UA: ${next}`, "NuwaxHostWebview");
      })
      .catch(() => {});
  }, []);

  // 调试：F12 / Cmd+Opt+I 开关 webview 页面的 DevTools（样式排查主入口）。
  // 仅壳窗口持有焦点时生效——guest 聚焦时由主进程 webviewPolicy 的
  // before-input-event 拦截同款快捷键（toggle），两侧行为一致。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "F12" ||
        (e.metaKey && e.altKey && e.key.toLowerCase() === "i")
      ) {
        const webview = webviewRef.current as any;
        if (webview?.isDevToolsOpened?.()) {
          webview?.closeDevTools?.();
        } else {
          webview?.openDevTools?.();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 解析 nuwax 根 URL（不依赖 nuwaclaw 登录态）；配置变更（形态/后端/域名切换）
  // 经 nuwax:loopback-changed 重解析——webview src 变更即加载新目标。
  useEffect(() => {
    const onLoopbackChanged = () => setUrl("");
    window.electronAPI?.on("nuwax:loopback-changed", onLoopbackChanged as any);
    return () => {
      window.electronAPI?.off(
        "nuwax:loopback-changed",
        onLoopbackChanged as any,
      );
    };
  }, []);

  // 企业登录切换业务域名（main 桥 auth:configureServerHost）：重解析 webview
  // URL——生产直连形态即加载新域名的 /Login（gateway 形态网关已随域重指；
  // direct 场景 loopback-changed 不会触发，需独立监听本事件）。
  useEffect(() => {
    const onServerHostChanged = () => setUrl("");
    window.electronAPI?.on(
      "nuwax:serverHostChanged",
      onServerHostChanged as any,
    );
    return () => {
      window.electronAPI?.off(
        "nuwax:serverHostChanged",
        onServerHostChanged as any,
      );
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const step1 = (await window.electronAPI?.settings.get(
          "step1_config",
        )) as { serverHost?: string } | null;
        // Loopback Gateway 形态（阶段一，step1_config.nuwaxLoadMode/env 开关）：
        // enabled 时经网关 origin 同源加载（登录态/Cookie 与回环 origin 绑定，
        // 跨域类问题从根上消失）；未启用回落 serverHost 直连（现状不变）。
        const loopback = (await window.electronAPI?.settings.get(
          "nuwax.loopback",
        )) as { enabled?: boolean; origin?: string | null } | null;
        // 调试覆盖前端域名（env NUWAX_WEBVIEW_ORIGIN → 主进程启动时写键）：
        // 显式调试意图，优先级最高；后端域仍按 serverHost（前后端一体），
        // 不受影响——不要为切前端去改 serverHost。
        const override = (await window.electronAPI?.settings.get(
          "nuwax.webviewOverride",
        )) as { origin?: string | null } | null;
        // 开发联调（vite dev）：优先加载本地 nuwax dev server(localhost:3000)；
        // 生产加载 step1_config.serverHost / DEFAULT_SERVER_HOST。
        const rawHost = override?.origin
          ? override.origin
          : import.meta.env.DEV
            ? loopback?.enabled && loopback.origin
              ? loopback.origin
              : NUWAX_DEV_HOST
            : loopback?.enabled && loopback.origin
              ? loopback.origin
              : step1?.serverHost || DEFAULT_SERVER_HOST;
        const domain = normalizeServerHost(rawHost);
        const finalUrl = buildHomeUrl(domain);
        logger.info(
          "[NuwaxHostWebview] resolved webview url",
          "NuwaxHostWebview",
          {
            dev: import.meta.env.DEV,
            override: override?.origin ?? null,
            loopback: loopback?.enabled ? loopback.origin : null,
            step1ServerHost: step1?.serverHost ?? null,
            rawHost,
            url: finalUrl,
          },
        );
        if (!cancelled && domain) setUrl(finalUrl);
      } catch (e) {
        logger.error(
          "[NuwaxHostWebview] resolve url failed",
          "NuwaxHostWebview",
          e,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url === ""]);

  // 绑定 webview 导航事件，上报 canGoBack/canGoForward（供工具栏按钮启用态）
  useEffect(() => {
    const wv = webviewRef.current as any;
    if (!wv?.addEventListener) return;
    const sync = () =>
      onNavStateChange?.({
        canGoBack: !!wv.canGoBack?.(),
        canGoForward: !!wv.canGoForward?.(),
      });
    wv.addEventListener("dom-ready", sync);
    wv.addEventListener("did-navigate", sync);
    wv.addEventListener("did-navigate-in-page", sync);
    return () => {
      wv.removeEventListener?.("dom-ready", sync);
      wv.removeEventListener?.("did-navigate", sync);
      wv.removeEventListener?.("did-navigate-in-page", sync);
    };
  }, [url, onNavStateChange]);

  // 外部 reloadKey 变化时重载 webview（兼容旧刷新入口）
  useEffect(() => {
    if (reloadKey > 0) (webviewRef.current as any)?.reload?.();
  }, [reloadKey]);

  useImperativeHandle(
    ref,
    () => ({
      goBack: () => (webviewRef.current as any)?.goBack?.(),
      goForward: () => (webviewRef.current as any)?.goForward?.(),
      reload: () => (webviewRef.current as any)?.reload?.(),
      canGoBack: () => !!(webviewRef.current as any)?.canGoBack?.(),
      canGoForward: () => !!(webviewRef.current as any)?.canGoForward?.(),
      sendHostCommand: (payload: unknown) =>
        (webviewRef.current as any)?.send?.("nuwax:host-command", payload),
      navigate: (url: string) => (webviewRef.current as any)?.loadURL?.(url),
    }),
    [],
  );

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#fff",
        overflow: "hidden",
      }}
    >
      {/* URL 重解析期（启动/企业切换域名瞬间）webview 尚无 src——以应用图标
          居中兜底，避免空白闪烁。 */}
      {!url && (
        <div className="app-loading">
          <img src="./icon.png" alt="" className="app-loading-icon" />
          <Spin size="large" />
        </div>
      )}
      <webview
        ref={webviewRef as any}
        src={url}
        useragent={ua}
        allowpopups={"true" as any}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          border: "none",
        }}
      />
    </div>
  );
});

export default NuwaxHostWebview;
