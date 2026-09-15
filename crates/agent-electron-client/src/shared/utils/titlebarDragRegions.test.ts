import { describe, expect, it } from "vitest";
import {
  MAX_TITLEBAR_DRAG_REGIONS,
  sanitizeTitlebarDragRegions,
} from "./titlebarDragRegions";

describe("sanitizeTitlebarDragRegions", () => {
  it("拒绝非数组", () => {
    expect(sanitizeTitlebarDragRegions({}, 800)).toBeNull();
  });

  it("裁剪到窗口宽度和顶部 48px", () => {
    expect(
      sanitizeTitlebarDragRegions(
        [{ x: -5, y: 30, width: 900, height: 40 }],
        800,
      ),
    ).toEqual([{ x: 0, y: 30, width: 800, height: 18 }]);
  });

  it("过滤非法/空矩形并限制数量", () => {
    const input = [
      { x: 0, y: 0, width: 0, height: 10 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      ...Array.from({ length: MAX_TITLEBAR_DRAG_REGIONS + 4 }, (_, i) => ({
        x: i,
        y: 0,
        width: 1,
        height: 8,
      })),
    ];
    expect(sanitizeTitlebarDragRegions(input, 800)).toHaveLength(
      MAX_TITLEBAR_DRAG_REGIONS - 2,
    );
  });
});
