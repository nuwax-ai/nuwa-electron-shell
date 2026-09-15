import type { TitlebarDragRegion } from "../types/webview";

export const MAX_TITLEBAR_DRAG_REGIONS = 16;
export const MAX_TITLEBAR_DRAG_HEIGHT = 48;

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
