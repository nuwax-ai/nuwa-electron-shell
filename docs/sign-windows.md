# nuwa-work 商业版 — Windows 人工签名 Runbook（Certum SimplySign）

> 完整工具链安装（SimplySign Desktop、signtool、gh CLI、Git Bash）与排障见
> `crates/agent-electron-client/docs/windows-signing.md`，本文只记录商业版差异：
> 目标仓库、产物名、数据目录与社区版完全隔离。

## 前置（一次性）

1. Windows 签名机安装并登录 **Certum SimplySign Desktop**（手机 APP 动态 token 2FA）——
   与社区版**共用同一张证书**（SmartScreen 信誉共享）。
2. 设置环境变量（Git Bash，可写入 `~/.bashrc`）：

   ```bash
   export WINDOWS_CERTIFICATE_SHA1="<证书指纹>"           # 必需
   export WINDOWS_TIMESTAMP_URL="http://timestamp.sectigo.com"  # 默认值
   ```

3. `gh auth login` 完成 GitHub CLI 登录（需对 `nuwax-ai/nuwa-work` 有 Release 写权限）。

## 发版流程（每次）

CI 在 nuwa-work 打 `electron-v{v}` tag 后产出**未签名**产物
`女娲 Nuwax-Setup-{v}-unsigned.exe`（以及最终名 MSI，不签名）。

```bash
cd <nuwa-work 检出>/crates/agent-electron-client

SIGN_RELEASE_REPO=nuwax-ai/nuwa-work \
SIGN_WORK_DIR=/c/tmp/nuwa-work-sign \
npm run sign:win -- <version>
```

说明：

- 产物前缀**自动**从本仓 `package.json build.productName`（女娲 Nuwax）派生，与 CI
  产物名一致；特殊情况下可用 `SIGN_WIN_ARTIFACT_PREFIX="女娲 Nuwax"` 显式指定。
- 脚本流程：下载 unsigned EXE → signtool（`/sha1` 指纹 + RFC3161 时间戳）→
  `signtool verify //pa //all` → 重命名 `女娲 Nuwax.Setup.{v}.exe` → 上传并删除
  Release 上的 unsigned 资产。
- 排障（Release 资产名对照、gh 找不到等）见 windows-signing.md 同名章节。

## 同步 OSS（stable 须先完成上面签名）

```bash
cd <nuwa-work 检出>/crates/agent-electron-client

SYNC_OSS_REPO=nuwax-ai/nuwa-work \
npm run sync:oss -- electron-v<version> [stable|beta]
```

- 整仓形态下 dispatch ref 自动解析到本仓当前分支，无需 `SYNC_OSS_REF`
  （远端 workflow 不在默认分支时才需要显式覆盖）。
- beta / prerelease-v* 不要求签名，可直接 sync。
- 同步产物落到独立通道 `nuwa-work-electron/`（stable 指针
  `nuwa-work-electron/latest/latest.json`、beta 指针 `nuwa-work-electron/beta/latest.json`），
  与社区版 `nuwaclaw-electron/` 互不影响——客户端经
  `NUWAX_UPDATE_FEED_BASE=.../nuwa-work-electron`（构建期注入）读取。

等价的手动触发方式：

```bash
gh workflow run sync-electron-to-oss.yml --repo nuwax-ai/nuwa-work --ref main \
  -f tag=electron-v<version> -f channel=stable
```
