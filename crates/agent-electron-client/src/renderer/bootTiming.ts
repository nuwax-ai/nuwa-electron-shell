import { useEffect, useRef, useState } from "react";
import {
  MAX_LOADING_OVERLAY_MS,
  MIN_SPLASH_MS,
  WEBVIEW_COVER_GRACE_MS,
} from "@shared/constants";

/** 只累计已绘制且可见的时间；后台/窗口未显示的时间不计入动画下限。 */
export class VisibleSplashClock {
  private last: number | null = null;
  private elapsed = 0;
  frame(now: number, visible: boolean): boolean {
    if (!visible) {
      this.last = null;
      return false;
    }
    if (this.last !== null) this.elapsed += Math.max(0, now - this.last);
    this.last = now;
    return this.elapsed >= MIN_SPLASH_MS;
  }
  hidden(): void {
    this.last = null;
  }
}
let completed = false;
let pending: Promise<void> | undefined;
function waitForSplash(): Promise<void> {
  if (pending) return pending;
  pending = new Promise((resolve) => {
    const clock = new VisibleSplashClock();
    const changed = () => clock.hidden();
    document.addEventListener("visibilitychange", changed);
    const frame = (now: number) => {
      if (clock.frame(now, document.visibilityState === "visible")) {
        completed = true;
        document.removeEventListener("visibilitychange", changed);
        resolve();
      } else requestAnimationFrame(frame);
    };
    // 第一帧提交启动屏，第二帧确认至少已发生一次绘制后开始累计。
    requestAnimationFrame(() => requestAnimationFrame(frame));
  });
  return pending;
}
export function useSplashFloor(): boolean {
  const [met, setMet] = useState(completed);
  useEffect(() => {
    let active = true;
    void waitForSplash().then(() => {
      if (active) setMet(true);
    });
    return () => {
      active = false;
    };
  }, []);
  return met;
}

/** webview 首载阶段：resolving=URL 重解析（启动/域名形态切换），loading/stopped 为 guest 加载周期。 */
export type GuestLoadPhase = "resolving" | "loading" | "stopped";

/**
 * 覆盖层距掀开还需等待的 ms（0 = 已可掀开）。
 * stopped 后再盖 WEBVIEW_COVER_GRACE_MS；自加载起 MAX_LOADING_OVERLAY_MS 硬上限兜底。
 * `mountAt` 传 0 表示尚无加载周期（resolving），按刚起算计。
 */
export function loadingCoverRemainingMs(
  hasStopped: boolean,
  opts: { stoppedAt: number; mountAt: number; now: number },
): number {
  const elapsed = opts.mountAt > 0 ? opts.now - opts.mountAt : 0;
  const capRemaining = Math.max(0, MAX_LOADING_OVERLAY_MS - elapsed);
  if (!hasStopped) return capRemaining;
  return Math.min(
    Math.max(0, WEBVIEW_COVER_GRACE_MS - (opts.now - opts.stoppedAt)),
    capRemaining,
  );
}

/**
 * webview 首载覆盖层状态：盖住 guest 白屏/页内 loading，加载停止后再盖宽限期
 * （尽量盖住页内 loading 尾段）；超硬上限兜底掀开。域名/形态切换（resolving）
 * 重新兜盖；已掀开后的常规导航（工具栏刷新等）不再回头兜盖。
 * `active` 须与主界面成立条件一致——启动 splash 阶段不计时，避免吃掉上限额度。
 */
export function useLoadingCover(
  active: boolean,
  phase: GuestLoadPhase,
): boolean {
  const [covered, setCovered] = useState(true);
  const mountAtRef = useRef(0);
  const stoppedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    if (phase === "resolving") {
      setCovered(true);
      mountAtRef.current = 0;
      stoppedAtRef.current = null;
    } else if (covered) {
      if (phase === "loading") {
        // 新加载周期（首载或 stopped 之后重载）重启计时；
        // 同一周期内的重复 loading 事件不重置，保证上限必然生效。
        if (stoppedAtRef.current !== null || mountAtRef.current === 0) {
          mountAtRef.current = now;
        }
        stoppedAtRef.current = null;
      } else if (stoppedAtRef.current === null) {
        stoppedAtRef.current = now;
      }
    } else {
      return;
    }
    const remaining = loadingCoverRemainingMs(stoppedAtRef.current !== null, {
      stoppedAt: stoppedAtRef.current ?? now,
      mountAt: mountAtRef.current,
      now,
    });
    const timer = window.setTimeout(() => setCovered(false), remaining);
    return () => window.clearTimeout(timer);
  }, [active, phase, covered]);

  return covered;
}
