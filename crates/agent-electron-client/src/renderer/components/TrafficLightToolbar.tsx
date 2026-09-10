/**
 * TrafficLightToolbar - 沉浸式一体化顶行（窗口 chrome 层）。
 *
 * 浮于 NuwaxHostWebview 之上，对照 WorkBuddy Windows 参考样式：
 * 1) 顶部全宽 10px 窄拖拽带（-webkit-app-region:drag）——保底拖拽区，mac 避开红绿灯；
 * 2) 顶行主体（整行 DRAG，交互子块 NO_DRAG 豁免；双击切换最大化）：
 *    - 左（全平台同构的功能区，最左起）：侧栏开关（常驻；当前页无二级菜单时置灰）
 *      → 设置 → 历史导航（后退/前进）→ statusEntry（服务异常点）；
 *    - 左（仅 Win/Linux，功能区之后）：自绘菜单栏 关于(A)/编辑(E)/窗口(W)/帮助(H)
 *      （antd Dropdown，12px 菜单文字）；编辑动作经 menu:editAction 路由到焦点
 *      webContents（webview guest 优先），页面/窗口动作复用 App 注入的
 *      onBack/onForward/onReload 与 window:* IPC；
 *    - 右（仅 Win/Linux）：贴角窗口三键（46×36，captionGlyphs 的 1px 细线字形，
 *      原生观感）；全平台仅 updateEntry（更新入口）按需注入。
 * 3) 编辑动作经 menu:editAction 路由到焦点 webContents；页面/窗口动作复用
 *    App 注入的 onBack/onForward/onReload 与 window:* IPC。
 *
 * 后退/前进/刷新不占顶行：Win/Linux 收进「窗口(W)」菜单；mac 收进系统菜单
 * 「窗口」（role back/forward/reload）。
 *
 * tooltip 暂用中文面量（桌面端次要 UI）；后续如需多语言可统一抽 i18n key。
 */
import React, { useEffect, useState } from "react";
import { Button, Dropdown, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  LeftOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { MinGlyph, MaxGlyph, RestoreGlyph, CloseGlyph } from "./captionGlyphs";

/** macOS 用 navigator.platform 判定（渲染器无 process.platform）。 */
const isMac = /mac/i.test(navigator.platform);

/** -webkit-app-region 需在 renderer DOM 设置；Electron 专属键，React CSSProperties 未内置，用 any 规避告警。 */
const DRAG = { WebkitAppRegion: "drag" } as any;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as any;

/** Win/Linux 顶行高：36px（对齐 nuwax shellAvoid.TOP=36）；mac 保持 48px（图标与红绿灯同高对齐）。 */
const ROW_H = isMac ? 48 : 36;

type EditAction = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

const editAction = (action: EditAction) => {
  void window.electronAPI?.menu?.editAction?.(action);
};

export interface TrafficLightToolbarProps {
  /** 二级菜单收起态（决定收起/展开 icon 与 tooltip）。 */
  menuCollapsed: boolean;
  /** 当前页是否存在可收起的二级菜单（nuwax 经桥推送；无则隐藏收起按钮）。 */
  menuAvailable: boolean;
  /** webview 后退能力（false 时禁用后退项）。 */
  canGoBack: boolean;
  /** webview 前进能力（false 时禁用前进项）。 */
  canGoForward: boolean;
  onToggleMenu: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenSettings: () => void;
  /** 打开「关于与检查更新」（App 侧落到设置弹窗 about tab，含完整更新流程）。 */
  onOpenAbout: () => void;
  /** 服务状态指示器（非绿色时由 App.tsx 注入颜色点，点击打开设置弹窗；全绿不渲染）。 */
  statusEntry?: React.ReactNode;
  /** 新版本更新入口（仅当检测到新版本时注入：下载 icon / 下载中百分比 / 待安装；其余不渲染）。 */
  updateEntry?: React.ReactNode;
}

/** 顶行菜单栏单项（Win/Linux 自绘；label 沿用 Windows 助记后缀惯例，真实 Alt 快捷键后续再补）。 */
const TopMenu: React.FC<{ label: string; items: MenuProps["items"] }> = ({
  label,
  items,
}) => (
  <Dropdown menu={{ items }} trigger={["click"]}>
    <button type="button" className="topbar-menu-btn">
      {label}
    </button>
  </Dropdown>
);

const TrafficLightToolbar: React.FC<TrafficLightToolbarProps> = ({
  menuCollapsed,
  menuAvailable,
  canGoBack,
  canGoForward,
  onToggleMenu,
  onBack,
  onForward,
  onReload,
  onOpenSettings,
  onOpenAbout,
  statusEntry,
  updateEntry,
}) => {
  // Win/Linux 最大化状态（自绘按钮图标）；mac 用原生红绿灯不渲染按钮
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (isMac) return;
    const sync = () =>
      window.electronAPI?.window
        .isMaximized?.()
        .then(setMaximized)
        .catch(() => {});
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  const onMin = () => window.electronAPI?.window.minimize();
  const onMax = () => window.electronAPI?.window.maximize();
  const onClose = () => window.electronAPI?.window.close();

  /** 统一的 icon 按钮（text 型、半透明、hover 显背景；no-drag 可点）。 */
  const iconBtn = (
    title: string,
    disabled: boolean,
    onClick: () => void,
    icon: React.ReactNode,
  ) => (
    <Tooltip title={title} mouseEnterDelay={0.7}>
      <Button
        type="text"
        size="small"
        disabled={disabled}
        onClick={onClick}
        style={{
          // 不可用时置灰（antd 禁用文字色），比仅禁点更直观
          color: disabled ? "rgba(0,0,0,0.25)" : "rgba(0,0,0,0.65)",
          fontSize: 16, // 放大图标（antd icon 继承按钮字号）
          ...NO_DRAG,
        }}
      >
        {icon}
      </Button>
    </Tooltip>
  );

  /**
   * 侧栏开关：常驻左侧（折叠/展开按钮固定可见）；当前页无二级菜单时置灰
   * （点了无目标可折叠），有则可折叠/展开。
   */
  const sidebarToggle = iconBtn(
    menuCollapsed ? "展开侧栏" : "收起侧栏",
    !menuAvailable,
    onToggleMenu,
    menuCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />,
  );

  const settingsBtn = iconBtn(
    "设置",
    false,
    onOpenSettings,
    <SettingOutlined />,
  );

  /** 历史导航：后退/前进（能力由 webview 事件推送，不可用时置灰）。 */
  const historyNav = (
    <>
      {iconBtn("后退", !canGoBack, onBack, <LeftOutlined />)}
      {iconBtn("前进", !canGoForward, onForward, <RightOutlined />)}
    </>
  );

  /** Win/Linux 自绘菜单栏（参考产品同款四项）。 */
  const menuBar = !isMac && (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        pointerEvents: "auto",
        ...NO_DRAG,
      }}
    >
      <TopMenu
        label="关于(A)"
        items={[
          { key: "about", label: "关于与检查更新", onClick: onOpenAbout },
        ]}
      />
      <TopMenu
        label="编辑(E)"
        items={[
          { key: "undo", label: "撤销", onClick: () => editAction("undo") },
          { key: "redo", label: "重做", onClick: () => editAction("redo") },
          { type: "divider" },
          { key: "cut", label: "剪切", onClick: () => editAction("cut") },
          { key: "copy", label: "复制", onClick: () => editAction("copy") },
          { key: "paste", label: "粘贴", onClick: () => editAction("paste") },
          {
            key: "selectAll",
            label: "全选",
            onClick: () => editAction("selectAll"),
          },
        ]}
      />
      <TopMenu
        label="窗口(W)"
        items={[
          { key: "back", label: "后退", disabled: !canGoBack, onClick: onBack },
          {
            key: "forward",
            label: "前进",
            disabled: !canGoForward,
            onClick: onForward,
          },
          { key: "reload", label: "刷新页面", onClick: onReload },
          { type: "divider" },
          { key: "minimize", label: "最小化", onClick: onMin },
          {
            key: "maximize",
            label: maximized ? "还原" : "最大化",
            onClick: onMax,
          },
          { key: "close", label: "关闭", onClick: onClose },
        ]}
      />
      <TopMenu
        label="帮助(H)"
        items={[
          {
            key: "logs",
            label: "打开日志目录",
            onClick: () => {
              void window.electronAPI?.log?.openDir?.();
            },
          },
        ]}
      />
    </div>
  );

  return (
    <>
      {/* 顶部窄拖拽带（全宽 10px，避开红绿灯）：窗口拖拽手柄由这条承担，
        工具栏主体不再整层 drag，避免遮挡 webview 顶部元素的点击 */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: isMac ? 80 : 0,
          right: 0,
          height: 10,
          zIndex: 1099,
          ...DRAG,
        }}
      />
      <div
        // 双击切换最大化/还原（window:maximize 主进程侧为切换语义）——
        // 必须是正式 JSX 事件 prop；此前误写进 style 对象被当未知 CSS 属性丢弃
        onDoubleClick={() => {
          void window.electronAPI?.window?.maximize?.().catch?.(() => {});
        }}
        style={{
          position: "fixed",
          top: 0,
          // mac 沿用 10px 起始（透明浮层无涂色需求）；Win/Linux 从 0 满宽起，
          // 实底背景才能盖满顶行左缘（拖拽带 0-10px 与本行重叠，拖拽语义不变）
          left: isMac ? 10 : 0,
          right: 0,
          height: ROW_H,
          zIndex: 1100,
          display: "flex",
          alignItems: "center",
          paddingLeft: isMac ? 80 : 8,
          // Win/Linux 右上角被贴角的窗口控制三键（40×28，3 键共 120px）占据，
          // 容器留出对应右内边距，防止更新入口等流内元素被其覆盖
          paddingRight: isMac ? 4 : 128,
          // 全平台透明浮层：顶行不涂底色，透出 webview 顶部避让带的页面自身
          // 背景（nuwax 顶带即页面 body 底色），与内容天然无缝、随主题自动一致；
          // 实底涂色会在页面底色与容器色有微差时形成可见断层（评审否决项）
          // 整条可拖拽窗口：沉浸避让已让空顶带（菜单 TOP36/
          // page-container TOP+8/详情页 TOOLBAR48），覆盖页面不再挡内容点击；
          // 可交互子块（icon 组/菜单栏/更新入口）以 no-drag 豁免。
          ...DRAG,
        }}
      >
        {/* 左侧功能区（全平台同构）：侧栏开关 → 设置 → 历史导航 → 服务状态，
            其右紧跟（仅 Win/Linux）自绘菜单栏；右侧只留窗口三键（±更新入口） */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 0,
            pointerEvents: "auto",
            ...NO_DRAG,
          }}
        >
          {sidebarToggle}
          {settingsBtn}
          {historyNav}
          {statusEntry}
          {menuBar}
        </div>

        {/* 中间留白：拖拽手柄 */}
        <div style={{ flex: 1 }} />

        {/* 右侧：更新入口（由 App.tsx 按需注入） */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginLeft: 8,
            pointerEvents: "auto",
            ...NO_DRAG,
          }}
        >
          {updateEntry}
        </div>

        {/* Win/Linux 自绘窗口控制按钮（mac 用原生红绿灯）：
            absolute 贴窗口右上角并垂直居中（40×28，不顶满行高——评审反馈
            46×36 观感过大）；方角、hover 加深、关闭键红底白字见
            index.css .toolbar-ctrl-*（背景随 --color-bg-container 主题）；
            字形为 captionGlyphs 的 1px 细线 SVG，对齐原生标题栏观感 */}
        {!isMac && (
          <div
            className="toolbar-ctrl-group"
            style={{
              position: "absolute",
              top: 4,
              right: 0,
              display: "flex",
              alignItems: "stretch",
              pointerEvents: "auto",
              ...NO_DRAG,
            }}
          >
            <CtrlButton title="最小化" onClick={onMin}>
              <MinGlyph />
            </CtrlButton>
            <CtrlButton title={maximized ? "还原" : "最大化"} onClick={onMax}>
              {maximized ? <RestoreGlyph /> : <MaxGlyph />}
            </CtrlButton>
            <CtrlButton title="关闭" danger onClick={onClose}>
              <CloseGlyph />
            </CtrlButton>
          </div>
        )}
      </div>
    </>
  );
};

/** Win/Linux 窗口控制按钮（实底背景与 hover 底色见 index.css .toolbar-ctrl-*）。 */
const CtrlButton: React.FC<{
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, danger, children }) => (
  <button
    aria-label={title}
    title={title}
    onClick={onClick}
    className={`toolbar-ctrl-btn${danger ? " toolbar-ctrl-btn--danger" : ""}`}
    style={{
      width: 40, // 较原生 46 略收窄（评审反馈 46×36 观感过大）
      height: 28,
      border: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      // 注意不写 background / color：inline 优先级高于 CSS 类规则，
      // 会压掉 hover 底色与关闭键 hover 白字
      cursor: "pointer",
      ...NO_DRAG,
    }}
  >
    {children}
  </button>
);

export default TrafficLightToolbar;
