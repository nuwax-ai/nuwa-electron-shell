# Electron 客户端开发约束

默认使用中文回复；仓库级规则见根目录 `AGENTS.md`。

## 落点与边界

- `src/main` 管窗口、SQLite、引擎、服务和 IPC；`src/preload` 暴露受限桥；`src/renderer` 使用 React，通过 IPC 调用主进程；共享类型在 `src/shared`。
- 引擎统一入口为 `services/engines/unifiedAgent.ts`，ACP 实现在 `services/engines/acp`。服务、包管理与系统适配保持现有分层。
- 外部输入、页面来源、会话及权限在主进程验证；网页不能因持有 bridge 对象而获得授权。
- 子进程环境经 `system/dependencies.ts` 的 `getAppEnv()` 创建，清理仅针对本实例拥有的进程。数据路径使用共享 constants/appPaths。
- 社区登录逻辑与商业消费方不同；不要把消费方的 overlay、ticket 生命周期或产品标识提交进中立基座。

## 命令

- `npm run dev`：开发；`npm run build`：主进程及 renderer 构建。
- `npm run test:run -- <相关测试文件>`：日常验证；`npm run test:run`：集成全量。
- `npm run test:scripts`：构建脚本测试；`npm run check:boundaries`、`npm run check:appdir`：相关静态检查。
- 沙箱集成测试依赖真实平台环境，不以通用 CI 通过代替实机验收。发布和签名由产品壳编排。

## 国际化

- UI 文本通过 `t()`；日志和抛出的错误使用英文，不进入 locale。
- 新增 UI key 同步四个 locale 文件及 `I18N_KEYS`；占位符与实际调用一致。
- 主进程使用主进程 i18n 服务；renderer 使用 renderer 服务。`src/renderer/components/dev` 调试组件不接入 i18n。

只为本次行为变化补齐缺失证据；不默认扩展测试数量、读取全部文档或重复生成设计工件。
