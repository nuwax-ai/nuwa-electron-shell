import { useEffect, useState } from "react";
import { MIN_SPLASH_MS } from "@shared/constants";

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
