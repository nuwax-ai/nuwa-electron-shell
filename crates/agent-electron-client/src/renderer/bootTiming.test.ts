import { expect, it } from "vitest";
import { VisibleSplashClock } from "./bootTiming";
import { MIN_SPLASH_MS } from "@shared/constants";

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
