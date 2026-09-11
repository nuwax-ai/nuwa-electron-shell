# nuwa-electron-shell — nuwax 平台 Electron 桌面外壳基座

nuwax 平台桌面客户端的**功能模块基座**：全部业务与构建系统都在本仓
（`crates/agent-electron-client` Electron 客户端主体、`crates/agent-kit` 共享
ACP 原语包、`crates/agent-gui-server` GUI Agent MCP、`crates/windows-sandbox-helper`
Windows 沙箱 helper、根 Makefile sidecar 准备全家桶、约 1585 个测试用例）。

本仓**不定义产品身份、不承载商业实现**——产品壳经 submodule 引用本仓做构建发布：

| 产品 | 产品壳仓库 | 身份 |
|---|---|---|
| nuwa-cli | [nuwax-ai/nuwa-cli] | 经 npm 依赖 `@nuwax-ai/agent-kit`（不引用 Electron 客户端） |
| 社区版 NuwaClaw | [nuwax-ai/nuwaclaw](https://github.com/nuwax-ai/nuwaclaw) | 不注入（默认值即社区版；已冻结停更） |
| 商业版 Nuwax（营销名 女娲Nuwax） | [nuwax-ai/nuwax-client](https://github.com/nuwax-ai/nuwax-client) | 4 个 env 注入（见下）+ `overlay/` 商业自有代码 + 自持 nuwax 前端 pin |

商业专属实现（nuwax 前端本地化承载 loopbackGateway、桥 auth 登录态同步、
设置商业区块等）自 2026-09-09 起移出本仓，由 Nuwax 壳经 overlay 文件覆写注入
（插槽契约见 `MODULES.md` D 节与 `services/loopbackGateway/index.ts` 头注）。

## 注入契约（产品差异的全部边界）

品牌/端口/更新通道收敛为 4 个构建期 env（esbuild/vite define 静态替换，
机制单点在 `crates/agent-electron-client/src/shared/constants.ts` 与
`src/main/services/autoUpdater.ts`；**不注入 = 社区版行为**）：

| env | 默认（社区版） | 商业版（Nuwax 壳）取值 |
|---|---|---|
| `NUWAX_APP_IDENTIFIER` | `nuwaclaw`（数据目录 ~/.nuwaclaw） | `nuwax`（~/.nuwax；Nuwax 壳经 overlay 覆写 migrate.ts 阻断历史目录迁移，全新开始） |
| `NUWAX_APP_DISPLAY_NAME` | `女娲 Nuwax` | `Nuwax`（ASCII——UA token=Nuwax/\<ver\>、关于页等；营销名女娲Nuwax 不进客户端） |
| `NUWAX_PORT_OFFSET` | `0`（18099/60002~60009/60173） | `1000`（整体 +1000，同机双开错开） |
| `NUWAX_UPDATE_FEED_BASE` | `...aliyuncs.com/nuwaclaw-electron` | `...aliyuncs.com/nuwax-electron` |

行为锁定测试：`crates/agent-electron-client/src/main/bootstrap/migrate.commercial.test.ts`、
`src/shared/constants.port-offset.test.ts`。产品专属逻辑只允许读注入后的常量，
禁止新增硬编码身份分支。

env 之外还有一层 **CI 产物身份**（产品壳 workflow 运行时 `npm pkg set` 覆写，非 env）：
Nuwax 壳为 `productName=Nuwax`（build 与顶层——顶层供 Electron `app.getName()`/
userData 目录名）、`appId=com.nuwax-ai.nuwax`；产物文件名与客户端展示名一律
ASCII（`Nuwax-Setup-*.exe` 等、UA token=Nuwax/\<ver\>）；营销名「女娲Nuwax」
只出现在产品壳 README 与发布文案。

## 目录速览

| 路径 | 职责 |
|---|---|
| `crates/agent-electron-client` | Electron 客户端本体（main/renderer/shared/preload） |
| `crates/agent-kit` | `@nuwax-ai/agent-kit` npm 包（nuwa-cli/客户端共享 ACP 原语，独立发布） |
| `crates/agent-gui-server` | GUI Agent MCP server（截屏+键鼠自动化） |
| `crates/windows-sandbox-helper` | Windows Restricted Token 沙箱 helper（Rust） |
| `nuwax/` | （已移除）前端 pin 归产品壳——如 Nuwax 壳根 `nuwax/` 子模块；基座 dev 经 `NUWAX_FRONTEND_DIST` env 接 dist |
| `scripts/`、`Makefile` | sidecar 下载/准备（uv、node、git、ripgrep、nuwaxcode 等） |

## 本地开发

```bash
# agent-kit 经 pnpm.overrides file: 引用，install 会打包快照——须先构建再 install
pnpm -C crates/agent-kit install --ignore-workspace && pnpm -C crates/agent-kit run build
pnpm install --filter @nuwax-ai/nuwaclaw...
npm run test:electron                          # 全量 vitest（社区默认值基线）
# 开发/构建入口见 crates/agent-electron-client/package.json scripts 与根 Makefile
# （electron-dev / electron-prepare）；型资源准备见 Makefile
```

## 开发方式

- **推荐独立工作副本开发**（非经产品壳的 submodule）：`git clone
  https://github.com/nuwax-ai/nuwa-electron-shell.git`（本地惯例放
  `~/workspace/nuwa-electron-shell`，与 nuwax/nuwax-client/nuwaclaw 同级）即可
  install/test/dev（基座 webview 按配置域名直连线上；如需本地 dist 形态联调，
  设 `NUWAX_FRONTEND_DIST=<dist 目录>` 并同步 Nuwax 壳 overlay 后运行）。
  产品壳内的 submodule 副本仅用于 pin 与构建，日常改动在本仓直接提交推送，
  壳按需 bump pin。
- 功能模块的粒度、边界与接入方式见 **[MODULES.md](./MODULES.md)**（独立包 /
  客户端功能域 / 平台 helper / 产品注入开关 + 扩展落位指引）。

## 产品壳如何引用与升级

- 产品壳以 submodule pin 引用本仓 `main`（`.gitmodules` → 本仓）。
- 基座改动 → 需要发版时，各产品壳自行 bump submodule pin 并走各自的发布通道。
- 本仓只保留测试类 CI（`pr.yml` PR 标题 lint、`ci.yml` 测试）；构建/签名/发布
  编排全部在产品壳仓库。

## 历史说明

本仓 main = 原 nuwaclaw 社区 main 全历史 + 1.0 功能复刻线（2026-09-09 合并统一）；
2026-09-09 前的 base 分支双线模型已收敛为单一 main。社区产品介绍与发布说明
见各产品壳仓库。
