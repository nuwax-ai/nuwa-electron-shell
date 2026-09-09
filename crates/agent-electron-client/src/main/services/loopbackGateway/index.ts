/**
 * Loopback Gateway 插槽（产品中立基座缺省 = no-op）。
 *
 * 基座不承载任何 nuwax 前端本地化方案——webview 按配置 serverHost 直连（社区
 * 行为）。商业产品壳（nuwa-work）经 overlay 文件覆写用商业实现替换本模块
 * （dist 本地托管 + 后端反代 + Bearer/x-client-type 代注，dist 目录经
 * NUWAX_FRONTEND_DIST env 注入），见 nuwa-work overlay/README.md。
 *
 * 覆写实现必须保持本文件导出面兼容（main.ts 退出清理与
 * processHandlers.restartAllServicesNow 两处动态 import 消费）：
 *   - stopLoopbackGateway(): Promise<void>
 *   - refreshLoopbackGateway(): Promise<void>
 * 运行时真值契约（renderer 只读 settings 键，不 import 本模块）：
 *   - `nuwax.loopback` = { enabled, origin, backend? }（未起网关时键缺省/禁用）
 *   - `nuwax:loopback-changed` 事件：形态/后端/域名变化时广播，webview 重解析 URL
 */
import log from "electron-log";

/** no-op：基座无网关可停（幂等，与商业实现语义一致）。 */
export async function stopLoopbackGateway(): Promise<void> {
  // 基座无 loopback 网关；保留日志便于排查「为何没起网关」类问题
  log.debug("[LoopbackGateway] base stub: no gateway to stop");
}

/** no-op：基座无配置变更传播需求（商业实现会 ensure→stop→比对→广播）。 */
export async function refreshLoopbackGateway(): Promise<void> {
  log.debug("[LoopbackGateway] base stub: refresh no-op");
}
