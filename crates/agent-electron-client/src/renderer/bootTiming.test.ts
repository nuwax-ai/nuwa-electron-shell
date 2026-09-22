import { expect, it } from "vitest";
import { VisibleSplashClock, loadingCoverRemainingMs } from "./bootTiming";
import {
  MAX_LOADING_OVERLAY_MS,
  MIN_SPLASH_MS,
  WEBVIEW_COVER_GRACE_MS,
} from "@shared/constants";

it(`counts ${MIN_SPLASH_MS}ms from painted frame, not JS evaluation`, () => {
  const clock = new VisibleSplashClock();
  const start = 10000;
  expect(clock.frame(start, true)).toBe(false);
  expect(clock.frame(start + MIN_SPLASH_MS - 1, true)).toBe(false);
  expect(clock.frame(start + MIN_SPLASH_MS, true)).toBe(true);
});
it("excludes time before visibility and while hidden", () => {
  const clock = new VisibleSplashClock();
  expect(clock.frame(0, false)).toBe(false);
  expect(clock.frame(5000, true)).toBe(false);
  // 第一段可见累计 1000ms 后隐藏（总 elapsed=1000，未达下限）
  expect(clock.frame(6000, true)).toBe(false);
  clock.hidden();
  // 恢复可见后继续累计：1000+1999 仍未达，+2000 恰好达标
  expect(clock.frame(20000, true)).toBe(false);
  expect(clock.frame(20000 + MIN_SPLASH_MS - 1001, true)).toBe(false);
  expect(clock.frame(20000 + MIN_SPLASH_MS - 1000, true)).toBe(true);
});

// ==================== webview 首载覆盖层（loadingCoverRemainingMs）====================

it("loading 未停止：只剩硬上限额度", () => {
  expect(
    loadingCoverRemainingMs(false, { stoppedAt: 0, mountAt: 1000, now: 1000 }),
  ).toBe(MAX_LOADING_OVERLAY_MS);
  expect(
    loadingCoverRemainingMs(false, { stoppedAt: 0, mountAt: 1000, now: 6000 }),
  ).toBe(MAX_LOADING_OVERLAY_MS - 5000);
});

it("resolving 期（mountAt=0）按刚起算计，不吃启动 splash 时长", () => {
  expect(
    loadingCoverRemainingMs(false, { stoppedAt: 0, mountAt: 0, now: 99999 }),
  ).toBe(MAX_LOADING_OVERLAY_MS);
});

it("stopped 后再盖宽限期，到点掀开", () => {
  // stop 后 500ms：宽限剩余 700ms
  expect(
    loadingCoverRemainingMs(true, {
      stoppedAt: 5000,
      mountAt: 1000,
      now: 5500,
    }),
  ).toBe(WEBVIEW_COVER_GRACE_MS - 500);
  // 宽限走完：掀开
  expect(
    loadingCoverRemainingMs(true, {
      stoppedAt: 5000,
      mountAt: 1000,
      now: 5000 + WEBVIEW_COVER_GRACE_MS,
    }),
  ).toBe(0);
});

it("宽限与硬上限取小：临近上限时按上限掀开", () => {
  // 加载 11.5s 才 stop（mountAt=1000 → stoppedAt=12500），再过 300ms：
  // 宽限剩 900ms，但上限只剩 200ms → 按上限掀开
  expect(
    loadingCoverRemainingMs(true, {
      stoppedAt: 12500,
      mountAt: 1000,
      now: 12800,
    }),
  ).toBe(MAX_LOADING_OVERLAY_MS - (12800 - 1000));
});

it("超硬上限必掀开（防 webview 长加载永挂）", () => {
  expect(
    loadingCoverRemainingMs(false, { stoppedAt: 0, mountAt: 0, now: 0 }),
  ).toBeGreaterThan(0);
  expect(
    loadingCoverRemainingMs(false, {
      stoppedAt: 0,
      mountAt: 1000,
      now: 1000 + MAX_LOADING_OVERLAY_MS,
    }),
  ).toBe(0);
});
