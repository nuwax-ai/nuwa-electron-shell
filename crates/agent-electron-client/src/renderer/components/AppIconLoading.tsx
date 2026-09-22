/**
 * AppIconLoading - 启动/安装全屏应用图标动效层（扫光）。
 *
 * 加载语义由图标扫光动效表达，等待态不出文案；失败态传 animated=false 保持静止，
 * 错误文案/重试按钮经 children 落在图标下方 .app-loading-body 插槽。
 * overlay 模式以 fixed 全窗盖在主界面（含 webview）之上，用于 webview 首载覆盖。
 */
import React from "react";

export interface AppIconLoadingProps {
  /** 加载/等待态启用扫光；失败态传 false 保持静止。 */
  animated?: boolean;
  /** 覆盖模式：fixed 全窗盖在内容之上（z-index 高于 webview 1000 / 工具栏 1100）。 */
  overlay?: boolean;
  /** 图标下方内容插槽（错误提示/重试按钮等）；缺省不出辅助层。 */
  children?: React.ReactNode;
}

export function AppIconLoading({
  animated = true,
  overlay = false,
  children,
}: AppIconLoadingProps) {
  return (
    <div
      className={`app-loading${overlay ? " app-loading--overlay" : ""}`}
      role={animated ? undefined : "alert"}
    >
      <div className="app-loading-icon-frame">
        <img src="./icon.png" alt="" className="app-loading-icon-img" />
        {animated && (
          /* 扫光条：mask 取 icon 亮度（白字形显形、黑砖≈全遮），光条仅在
             logo 白色区扫过。url 走行内运行时解析（dev 与 loadFile 打包同源）。 */
          <span
            className="app-loading-icon-sheen"
            style={{
              WebkitMaskImage: 'url("./icon.png")',
              maskImage: 'url("./icon.png")',
              maskMode: "luminance",
            }}
          />
        )}
      </div>
      {children != null && <div className="app-loading-body">{children}</div>}
    </div>
  );
}

export default AppIconLoading;
