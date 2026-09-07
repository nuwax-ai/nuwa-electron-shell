# NUWA-WORK — 女娲 Nuwax 商业版

本仓是**女娲 Nuwax 商业版**的完整代码仓（整仓形态，非薄壳）：业务与构建系统即原
nuwaclaw `feature/electron-client-1.0` 线的延续（历史完整保留，基线 `811009627` 起）。
社区开源版在 [nuwax-ai/nuwaclaw](https://github.com/nuwax-ai/nuwaclaw) 的 main
（`811009627`，0.13 基线）独立演进；两仓公共修复靠 cherry-pick 同步。

根 README.md / AGENTS.md 沿用原 nuwaclaw 工程文档（开发纪律、命令、目录地图均适用），
商业身份相关的一切以本文件为准。

## 与社区版的隔离（并装互不干扰）

| 维度 | 社区版 nuwaclaw | 商业版 nuwa-work（本仓） |
|---|---|---|
| appId / bundle id | com.nuwax-ai.nuwaclaw | **com.nuwax-ai.nuwa-work**（CI 构建时 npm pkg set） |
| 产物名前缀 | NuwaClaw | **女娲 Nuwax**（package.json build.productName） |
| 数据目录 | ~/.nuwaclaw | **~/.nuwawork**（首启自动从 ~/.nuwaclaw 一次性迁移） |
| 更新通道（OSS/MinIO） | nuwaclaw-electron/ | **nuwa-work-electron/** |
| 证书 | Certum SimplySign（Windows 手签）+ Apple Developer ID（CI 签+公证） | 同一张证书（共用，SmartScreen/公证信誉共享） |

品牌注入机制：CI 在 `Set version & commercial branding` 步骤覆盖 appId，并以构建期
环境变量 `NUWAX_APP_IDENTIFIER=nuwawork` / `NUWAX_APP_DISPLAY_NAME` /
`NUWAX_UPDATE_FEED_BASE` 经 esbuild/vite define 固化进 main/renderer 产物
（不设 env 时默认值=社区版行为，见 `crates/agent-electron-client/src/shared/constants.ts` 头注）。

## 发版流程

1. **准备**：`release-notes/electron-v{x.y.z}.md`（缺省用默认文案）。
2. **构建**：`git tag electron-v{x.y.z} && git push origin electron-v{x.y.z}`
   → `release-electron.yml` 全平台构建：macOS 自动签名+公证（Apple secrets），
   Windows 出 unsigned 包。beta 走 `prerelease-v*`（`release-electron-dev.yml`）。
3. **Windows 人工签名**：见 [docs/sign-windows.md](./docs/sign-windows.md)
   （Certum SimplySign Desktop + `npm run sign:win`）。
4. **同步 OSS**：`npm run sync:oss`（stable 会强校验已签名 EXE）。

## 首次启用清单（人工操作）

- [ ] GitHub Settings → Secrets 配置（与社区版同值，共用证书）：
  `GH_PAT`；`APPLE_TEAM_ID` / `APPLE_SIGNING_IDENTITY` / `APPLE_CERTIFICATE` /
  `APPLE_CERTIFICATE_PASSWORD` / `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_ISSUER_ID`；
  `MINIO_ACCESS_KEY_ID` / `MINIO_SECRET_ACCESS_KEY`；`OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`
- [ ] 打首个 `prerelease-v*` tag 验证构建链路（nuwax 子模块 init、品牌注入、产物名）
- [ ] Windows 签名机按 docs/sign-windows.md 完成一次 sign:win 演练
- [ ] 验证 OSS `nuwa-work-electron/` 指针独立、与社区版 `nuwaclaw-electron/` 互不影响

## 子模块

`nuwax/`（前端，git.yichamao.com/agent-platform/nuwax.git，branch feat-dong.0930）：
其 `dist/` **随子模块仓提交**，CI 只需 `git submodule update --init nuwax`，无需构建。
注意仓内另有 vcpkg 孤儿 gitlink（无 .gitmodules 条目），**不可用 `submodules: recursive`**。

## 已知边界

- 双开端口冲突：社区版与商业版**同时运行**会撞默认端口（MCP Proxy 18099 /
  Agent Runner 60006 / File Server 60005 / Lanproxy 60002），待后续按产品错开或改为可配。
- MSI 不签名（CI 直出最终名）；blockmap/差分更新默认关闭。
