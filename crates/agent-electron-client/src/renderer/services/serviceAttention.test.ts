import { describe, expect, it } from "vitest";
import {
  SERVICE_UNHEALTHY_STREAK_THRESHOLD,
  shouldShowServiceAttention,
} from "./serviceAttention";

describe("shouldShowServiceAttention", () => {
  it("未登录时隐藏所有服务状态", () => {
    expect(
      shouldShowServiceAttention({
        loggedIn: false,
        phase: "service-failed",
        unhealthyStreak: 9,
      }),
    ).toBe(false);
  });

  it.each(["stopped", "registering", "starting", "stopping", "stop-failed"])(
    "%s 不作为全局故障圆点",
    (phase) => {
      expect(
        shouldShowServiceAttention({
          loggedIn: true,
          phase,
          unhealthyStreak: 9,
        }),
      ).toBe(false);
    },
  );

  it.each(["registration-failed", "service-failed"])("%s 立即显示", (phase) => {
    expect(
      shouldShowServiceAttention({
        loggedIn: true,
        phase,
        unhealthyStreak: 0,
      }),
    ).toBe(true);
  });

  it("ready 后连续两轮异常才显示", () => {
    expect(
      shouldShowServiceAttention({
        loggedIn: true,
        phase: "ready",
        unhealthyStreak: SERVICE_UNHEALTHY_STREAK_THRESHOLD - 1,
      }),
    ).toBe(false);
    expect(
      shouldShowServiceAttention({
        loggedIn: true,
        phase: "ready",
        unhealthyStreak: SERVICE_UNHEALTHY_STREAK_THRESHOLD,
      }),
    ).toBe(true);
  });
});
