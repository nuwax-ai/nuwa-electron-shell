# 计划：nuwa-work 拆仓——签名方案 + 品牌与数据目录隔离

- 状态：已批准实施（用户，2026-09-07）
- 背景：商业版拆至独立仓 `github.com/nuwax-ai/nuwa-work`（薄壳 + nuwaclaw 作 submodule 共享业务逻辑）；社区开源版以 `3129275f` 为基座独立并行。

## 已确认决策

1. Windows 维持 SimplySign Desktop 人工签名（CI 出 unsigned，签名机下载/签名/回传）；macOS 沿用 CI 全自动（Apple Developer ID + App Store Connect API Key 公证）。
2. 商业版与社区版共用同一张 Certum 证书 + 同一 Apple Developer 账号（SmartScreen/公证信誉继承，签名主体同名已接受）。
3. 社区版继续现流程；新仓托管 GitHub，tag 沿用 `electron-v*` / `prerelease-v*`（跨仓天然隔离）。
4. 商业版数据目录 `~/.nuwawork`（社区版保持 `~/.nuwaclaw`），appId / 产物名 / 更新通道全部隔离，支持并装。

## 实施（Part A：本仓参数化）

1. 品牌常量（`src/shared/constants.ts`）：`APP_DISPLAY_NAME` / `APP_NAME_IDENTIFIER`（→ `APP_DATA_DIR_NAME`）改为构建期 env 可覆盖，默认值不变；main（esbuild）/ renderer（vite）注入链路打通。
2. `sign-release-win-v2.sh`：`NuwaClaw-*` 产物名硬编码 → `SIGN_WIN_ARTIFACT_PREFIX`（默认 `NuwaClaw`）。
3. `sync-oss.sh` + `release-electron.yml`：repo / 产物前缀 / bucket / 指针路径参数化；商业版走独立指针（`nuwa-work-electron/{tag}`、`nuwa-work/latest.json`）实现 electron-updater 通道隔离。
4. `@electron/notarize` 显式声明 devDependency（现为传递依赖，拆仓后 `after-sign.js` require 会挂）。
5. 商业版数据迁移：复用 `migrate.ts` 机制，商业版构建启用 `.nuwaclaw → .nuwawork` 一次性迁移（仅目标不存在时；社区版不启用）。
6. appId 一致性修正（package.json `com.nuwax-ai.nuwaclaw` vs `CFBundleIdentifier com.nuwax.agent`）。

## 实施（Part B：nuwa-work 仓）

1. 克隆空仓，薄壳结构：`.github/workflows` + 品牌 override 注入 + docs；`git submodule add` 引入 nuwaclaw（pin 商业开发线）；CI `submodules: recursive`（嵌套 nuwax）。
2. 复制改造 `release-electron.yml` / `sync-electron-to-oss.yml`：路径前缀、商业品牌 env、MinIO/OSS 独立 bucket 与指针。
3. Secrets 重建清单（~12 项，GitHub Settings 人工配置，与社区版同值）。
4. Windows 人工签名 runbook（`docs/sign-windows.md`）。
5. 遗留沿用现状：MSI 不签名；blockmap/差分更新默认关闭。

## 风险与边界

- 双开端口冲突（18099/60006/60005/60002 常量默认值）——本轮标记不改。
- secrets 只配 GitHub Settings，绝不入库。
