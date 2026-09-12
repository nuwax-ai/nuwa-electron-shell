import { expect, it } from "vitest";
import { VisibleSplashClock } from "./bootTiming";
it("counts 800ms from painted frame, not JS evaluation", () => {
  const clock = new VisibleSplashClock();
  expect(clock.frame(10000, true)).toBe(false);
  expect(clock.frame(10799, true)).toBe(false);
  expect(clock.frame(10800, true)).toBe(true);
});
it("excludes time before visibility and while hidden", () => {
  const clock = new VisibleSplashClock();
  expect(clock.frame(0, false)).toBe(false);
  expect(clock.frame(5000, true)).toBe(false);
  expect(clock.frame(5300, true)).toBe(false);
  clock.hidden();
  expect(clock.frame(20000, true)).toBe(false);
  expect(clock.frame(20499, true)).toBe(false);
  expect(clock.frame(20500, true)).toBe(true);
});
