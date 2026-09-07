# Electron 侧栏折叠范围修复计划

1. 提取纯函数描述主列和二级列的折叠策略，并用行为矩阵做回归测试。
2. `DynamicMenusLayout` 使用策略结果：Electron 只隐藏二级列，浏览器仍可隐藏主列。
3. `SidebarNavHeader` 在 Electron 中也渲染站点 Logo，折叠二级列后保持常驻。
4. 运行目标 Vitest、会话合同测试与 NuwaClaw Electron 测试。
5. 在正在运行的 Electron 客户端实测折叠、展开和 Logo 常驻。
