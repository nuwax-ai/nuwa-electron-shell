# nuwa-electron-shell 开发指南

默认使用中文回复。

## 仓库边界

- 本仓提供产品中立的 Electron 基座，源码位于 `crates/agent-electron-client`；引擎 SDK 位于 `crates/agent-kit`。
- 商业身份、登录差异和发布编排由消费方维护。产品壳同步进来的 overlay 不是基座改动，不得提交回本仓。
- 中立改动经工作分支 PR 进入 main；不 rebase 改写已被产品 pin 引用的提交。

## 开发与验证

- 小修直接修改并验证相关行为；复杂需求最多维护一份计划，不要求 intent/spec/plan 串行工件或测试先提交。
- 客户端内的具体约束见 `crates/agent-electron-client/AGENTS.md`。只读与任务相关的文档，不默认遍历历史设计和验收记录。
- `npm run test:electron` 执行客户端全量测试；日常在 crate 内使用 `npm run test:run -- <相关文件>`。
- `npm run test:electron:scripts` 检查构建脚本；构建 agent-kit 使用 `npm run build:agent-kit`。
- 提交钩子仅格式化暂存文件。测试按改动域执行，已有结果足够且代码未变时不重复全量验证。
- 新增测试覆盖真实行为和未覆盖的风险；注释保留原因、协议、平台差异及单位，不记录开发流水账。

## 产品隔离

- 社区默认数据目录为 `~/.nuwaclaw`，产品覆盖来自共享 constants 与运行配置；不要硬编码其他产品目录。
- 商业覆写工作树与社区验证分开。消费方的 `base:test` 会清 overlay，只能在隔离副本运行。
- 提交前检查 diff，仅包含本次中立改动；产品壳另有 `check:pin` 防止覆写泄漏。
