/**
 * 启动动画计时起点。
 *
 * 放在独立模块而不是 main.tsx：App.tsx 也要用，若从 "./main" 引入就形成
 * App ← main 的循环依赖（main 顶部 import App）。main.tsx 顶部 import "./App"，
 * 本模块因此在其 import 阶段（早于 main 体内的 i18n 初始化请求）求值，
 * 时间戳≈渲染入口 JS 开始执行的时刻，可作跨加载分支的统一计时起点。
 */
export const BOOT_AT = Date.now();
