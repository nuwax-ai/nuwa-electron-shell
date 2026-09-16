import type { TitlebarDragRegion } from "../types/webview";

export const MAX_TITLEBAR_DRAG_REGIONS = 16;
export const MAX_TITLEBAR_DRAG_HEIGHT = 48;

/**
 * host 侧空热区宽限：guest 过渡期（侧栏收展/antd 动画）会瞬时上报空数组，
 * 宽限内来了非空即取消清空；超时仍空才回落 8px 保底条。导航开始的主动清空
 * 不走此宽限。2026-09-16 实测侧栏收起过渡的空窗达 ~1.2s，取 1500ms 覆盖。
 */
export const TITLEBAR_EMPTY_GRACE_MS = 1500;

/** 主进程边界：guest 输入不可信，只转发窗口范围内的有限顶部矩形。 */
export function sanitizeTitlebarDragRegions(
  value: unknown,
  viewportWidth: number,
): TitlebarDragRegion[] | null {
  if (!Array.isArray(value)) return null;
  const safeWidth = Number.isFinite(viewportWidth)
    ? Math.max(0, viewportWidth)
    : 0;
  const result: TitlebarDragRegion[] = [];
  for (const item of value.slice(0, MAX_TITLEBAR_DRAG_REGIONS)) {
    if (!item || typeof item !== "object") continue;
    const { x, y, width, height } = item as Record<string, unknown>;
    if (![x, y, width, height].every((n) => Number.isFinite(n))) continue;
    const left = Math.max(0, Number(x));
    const top = Math.max(0, Number(y));
    const right = Math.min(safeWidth, left + Number(width));
    const bottom = Math.min(MAX_TITLEBAR_DRAG_HEIGHT, top + Number(height));
    if (right <= left || bottom <= top) continue;
    result.push({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    });
  }
  return result;
}
