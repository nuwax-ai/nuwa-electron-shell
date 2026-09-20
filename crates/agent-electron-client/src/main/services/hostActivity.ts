/**
 * 宿主活跃状态桥（「休眠控制」）
 *
 * 客户端不可见（窗口最小化 / 隐藏到托盘 / 系统锁屏）时，webview 里的 nuwax PC web
 * 感知不到宿主状态，全局事件等轮询照常打后端。本服务收敛宿主可见性事实源，
 * 沿变化沿把 { type: "host-activity", visible } 直发主窗口的 webview guest
 * （复用 guest preload 的 nuwax:host-command 通道，preload 零改动），由前端
 * hostBridgeEvents 分发后暂停/恢复轮询，恢复可见立即补拉。
 *
 * 设置项「休眠控制」（settings 表键 nuwax.dormancy，值 { enabled }，默认开）：
 * 关闭后不再下发 invisible 沿，前端保持默认 visible，轮询行为回到基线。
 * 设置弹窗只在窗口可见时可交互，因此按状态迁移时点读库即可，无需订阅设置变更。
 *
 * 范围：MVP 只挂主窗口（轮询大户所在）；native:openWindow 二级窗口的 guest
 * 不接入，维持现状全量轮询。
 */

import { BrowserWindow, powerMonitor, type WebContents } from "electron";
import log from "electron-log";
import { readSetting } from "../db";

/** guest preload 现有的宿主命令通道，此处复用不新增 preload 面 */
const HOST_COMMAND_CHANNEL = "nuwax:host-command";

/** 设置表键（settings 表统一 JSON 编码存储，见 settingsHandlers） */
export const DORMANCY_SETTING_KEY = "nuwax.dormancy";

export interface HostActivityState {
  windowVisible: boolean;
  locked: boolean;
}

/** 宿主可见 = 窗口未最小化未隐藏 且 未锁屏；失焦不算不可见（并排窗口仍在看） */
export function computeHostVisible(state: HostActivityState): boolean {
  return state.windowVisible && !state.locked;
}

/** 设置值解析：缺省/形态异常一律按默认开，防读库失败把暂停逻辑卡死在关闭态 */
export function isDormancyEnabled(settingValue: unknown): boolean {
  if (
    typeof settingValue === "object" &&
    settingValue !== null &&
    "enabled" in settingValue
  ) {
    const enabled = (settingValue as { enabled: unknown }).enabled;
    if (typeof enabled === "boolean") {
      return enabled;
    }
  }
  return true;
}

/** visible 沿总是下发（让前端回到活跃是安全的）；invisible 沿受休眠开关门控 */
export function shouldPushHostActivity(
  visible: boolean,
  dormancyEnabled: boolean,
): boolean {
  return visible || dormancyEnabled;
}

// ==================== 运行态 ====================

const guests = new Set<WebContents>();
let state: HostActivityState = { windowVisible: true, locked: false };
let lastPushedVisible: boolean | null = null;

function emitToGuests(visible: boolean, only?: WebContents): void {
  const targets = only ? [only] : [...guests];
  for (const guest of targets) {
    if (guest.isDestroyed()) {
      guests.delete(guest);
      continue;
    }
    guest.send(HOST_COMMAND_CHANNEL, { type: "host-activity", visible });
  }
}

/**
 * 向主窗口全部 webview guest 下发宿主命令（新建任务/打开搜索等应用菜单动作）。
 * guests 集合由 attachHostActivityWindow 经 did-attach-webview 登记，只含主窗口
 * 的 guest——菜单动作语义即"作用于主界面"，二级窗口的 guest 不在此列。
 */
export function sendHostCommandToMainWindowGuests(payload: unknown): void {
  for (const guest of [...guests]) {
    if (guest.isDestroyed()) {
      guests.delete(guest);
      continue;
    }
    guest.send(HOST_COMMAND_CHANNEL, payload);
  }
}

function recompute(reason: string, force = false): void {
  const visible = computeHostVisible(state);
  if (!force && visible === lastPushedVisible) {
    return;
  }
  const dormancyEnabled = isDormancyEnabled(readSetting(DORMANCY_SETTING_KEY));
  if (!shouldPushHostActivity(visible, dormancyEnabled)) {
    return;
  }
  lastPushedVisible = visible;
  log.info(
    "[HostActivity] %s -> visible=%s (guests=%d)",
    reason,
    visible,
    guests.size,
  );
  emitToGuests(visible);
}

/**
 * 新 guest 初始同步：覆盖 --hidden 冷启动 / 隐藏期间 webview 重载——
 * 这些场景没有后续状态沿可等。可见是前端默认态，只有不可见才需要下发。
 */
function attachGuest(contents: WebContents): void {
  guests.add(contents);
  contents.once("destroyed", () => {
    guests.delete(contents);
  });
  if (
    !computeHostVisible(state) &&
    isDormancyEnabled(readSetting(DORMANCY_SETTING_KEY))
  ) {
    log.info(
      "[HostActivity] guest attached while hidden, syncing visible=false",
    );
    emitToGuests(false, contents);
  }
}

/**
 * 挂接主窗口：窗口可见性事件 + webview guest 登记。
 * 在 createWindow() 内窗口创建后调用；窗口销毁时自动清理（closed 沿）。
 */
export function attachHostActivityWindow(win: BrowserWindow): void {
  state = { ...state, windowVisible: win.isVisible() };
  const setWindowVisible = (windowVisible: boolean, reason: string): void => {
    state = { ...state, windowVisible };
    recompute(reason);
  };
  win.on("minimize", () => setWindowVisible(false, "minimize"));
  win.on("restore", () => setWindowVisible(true, "restore"));
  win.on("show", () => setWindowVisible(true, "show"));
  // close 被拦截为 hide()（托盘模式），hide 沿即托盘隐藏
  win.on("hide", () => setWindowVisible(false, "hide"));
  win.webContents.on("did-attach-webview", (_event, contents) => {
    attachGuest(contents);
  });
  win.on("closed", () => {
    guests.clear();
    state = { ...state, windowVisible: true };
  });
}

/**
 * 注册系统级电源事件（app ready 后调用一次）。
 * suspend 期间 Node 定时器不走，无需处理；resume 后强制重推当前态，
 * 治愈 guest 重载 / 事件丢失造成的漂移（lock 态由 lock-screen/unlock-screen 维护，
 * 唤醒后若仍处锁屏，unlock-screen 迟早会来，期间保持 invisible 是安全侧）。
 *
 * 已知边界：应用在「已锁屏」状态下启动（如 SSH/远程拉起）收不到 lock-screen
 * 沿（Electron 无锁屏状态查询 API，实测 WebContents.visibilityState 为
 * undefined、isVisible 恒 true），轮询会跑到用户首次解锁为止；开机自启实际
 * 在用户登录后启动不受影响。2026-09-17 锁屏态实测确认。
 */
let powerEventsBound = false;

export function initHostActivity(): void {
  if (powerEventsBound) {
    return;
  }
  powerEventsBound = true;
  powerMonitor.on("lock-screen", () => {
    state = { ...state, locked: true };
    recompute("lock-screen");
  });
  powerMonitor.on("unlock-screen", () => {
    state = { ...state, locked: false };
    recompute("unlock-screen");
  });
  powerMonitor.on("suspend", () => recompute("suspend"));
  powerMonitor.on("resume", () => recompute("resume", true));
}

/** 仅测试用：复位模块运行态 */
export function _resetHostActivityForTest(): void {
  guests.clear();
  state = { windowVisible: true, locked: false };
  lastPushedVisible = null;
  powerEventsBound = false;
}
