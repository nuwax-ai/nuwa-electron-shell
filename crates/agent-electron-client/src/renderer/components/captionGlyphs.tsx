/**
 * Windows 标题栏三键的 1px 细线字形（对齐 Segoe Fluent/MDL2 原生观感）。
 * viewBox 10×10、strokeWidth=1、currentColor：颜色随 .toolbar-ctrl-btn 的
 * CSS 类走（含关闭键 hover 红底白字）。不用 antd 描边图标——笔画过粗，
 * 与原生标题栏字形差距明显（样式评审不过关点之一）。
 */
const S = { stroke: "currentColor", strokeWidth: 1, fill: "none" } as const;

export const MinGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <path d="M0 5.5 H10" {...S} />
  </svg>
);

export const MaxGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <rect x="0.5" y="0.5" width="9" height="9" {...S} />
  </svg>
);

export const RestoreGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <path d="M2.5 0.5 H9.5 V7.5" {...S} />
    <rect x="0.5" y="2.5" width="7" height="7" {...S} />
  </svg>
);

export const CloseGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" {...S} />
  </svg>
);
