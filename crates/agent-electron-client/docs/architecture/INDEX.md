# 架构文档索引

按任务读取相关文档，现行代码和契约优先；设计文档不代表全部已交付。

| 文档 | 内容 |
|---|---|
| [总览](./OVERVIEW.md) | 产品定位、核心原则、系统架构图 |
| [核心组件](./COMPONENTS.md) | Memory、Skill Creator、EvoMap、Soul.md |
| [循环流程](./LOOP.md) | 七层循环、接口定义、数据流 |
| [存储实现](./STORAGE.md) | Markdown 格式、索引机制、读写接口 |
| [隔离策略](./ISOLATION.md) | 三区模型、环境变量、安全边界 |
| [Quick Init](./QUICK-INIT.md) | 快捷初始化（nuwaclaw.json / 环境变量） |
| [初始化依赖版本固定与安装/升级](./dependency-version-pinning.md) | installVersion、升级同步、文案、尊重已安装版本不降级 |
| [Auto Update](./auto-update.md) | 自动更新机制 |
| [认证机制与 SavedKey 生命周期](./auth-savedkey-lifecycle.md) | savedKey 设计、多账号隔离、退出登录与服务联动规则 |
| [ACP 引擎性能优化](./ACP-ENGINE-PERF-OPTIMIZATION.md) | 引擎预热池、SDK 预加载、SSE 缓冲，降低 /computer/chat 首包延迟 |
| [内嵌 Webview 与 Cookie 同步](./embedded-webview-cookie-sync.md) | 会话页面内嵌 webview + reg token 自动同步 httpOnly cookie 免登录 |
| [OpenClaw 参考](./REF-OPENCLAW.md) | openclaw 架构分析与改进建议 |
| [运行时环境配置](./RUNTIME-ENV-PROFILES.md) | strict/compat 环境配置策略 |
| [签名指南](../release/SIGNING.md) | 应用签名与公证 |
| [安全审查](../reviews/SECURITY-REVIEW.md) | 安全性审查清单 |
| [日志规范](../operations/LOGGING.md) | 日志记录标准 |
| [审查记录](../reviews/REVIEW-2026-02.md) | 2026年2月架构审查记录 |
| [Sandbox 子模块 ADR](./ADR-SANDBOX-SUBMODULE.md) | 三端沙箱运行时子模块化决策 |
