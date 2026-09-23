/**
 * AppIconLoading - 启动/安装全屏应用图标动效层（扫光）。
 *
 * 加载语义由图标扫光动效表达，等待态不出文案；失败态传 animated=false 保持静止，
 * 错误文案/重试按钮经 children 落在图标下方 .app-loading-body 插槽。
 * 扫光 = 白色高光带斜扫过整个图标（第一版动效，光条加宽），参数与 index.css
 * .app-loading-icon-sheen 同步。
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
        {/* 扫光条：白色高光带自左向右斜扫过整个图标（第一版动效，光条加宽）。 */}
        {animated && <span className="app-loading-icon-sheen" />}
      </div>
      {children != null && <div className="app-loading-body">{children}</div>}
    </div>
  );
}

export default AppIconLoading;
