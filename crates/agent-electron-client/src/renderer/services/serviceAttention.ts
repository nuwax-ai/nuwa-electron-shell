export type CommercialServicePhase =
  | "stopped"
  | "registering"
  | "registration-failed"
  | "starting"
  | "ready"
  | "service-failed"
  | "stopping"
  | "stop-failed"
  | string;

export const SERVICE_UNHEALTHY_STREAK_THRESHOLD = 2;

/**
 * 顶栏圆点不是一般健康灯，只表示已登录用户需要处理的确定故障。
 * 主动停止/停止失败由当前操作界面反馈，不把圆点长期挂在全局顶栏。
 */
export function shouldShowServiceAttention(input: {
  loggedIn: boolean;
  phase: CommercialServicePhase;
  unhealthyStreak: number;
}): boolean {
  if (!input.loggedIn) return false;
  if (
    input.phase === "registration-failed" ||
    input.phase === "service-failed"
  ) {
    return true;
  }
  return (
    input.phase === "ready" &&
    input.unhealthyStreak >= SERVICE_UNHEALTHY_STREAK_THRESHOLD
  );
}
