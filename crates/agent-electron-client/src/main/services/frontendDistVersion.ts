import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import log from "electron-log";

/**
 * 内置 nuwax 前端 dist 的版本读取。
 * dist 由前端仓构建时经 post 钩子写出的 dist/version.json 描述（含 version/gitHash）；
 * 关于页「本地化（loopback）内置版本」与系统信息展示消费。
 *
 * 路径解析与 overlay 网关（loopbackGateway/index.ts resolveNuwaxDistDir）保持同一
 * 优先级但刻意不共用实现：该模块属 overlay 托管槽位，基座中立代码不 import 它，
 * 10 行路径规则重复是有意为之。
 */
export interface BundledDistVersion {
  name: string;
  version: string;
  gitHash?: string;
}

export function resolveFrontendDistDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "nuwax-dist");
  }
  const fromEnv = (process.env.NUWAX_FRONTEND_DIST || "").trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  // dev：app path = crates/agent-electron-client → 壳仓根/nuwax/dist（与网关缺省一致）
  return path.resolve(app.getAppPath(), "..", "..", "nuwax", "dist");
}

let cached: BundledDistVersion | null | undefined;

/** 读取内置 dist 的 version.json；缺失/损坏返回 null（结果按进程缓存）。 */
export function getBundledDistVersion(): BundledDistVersion | null {
  if (cached !== undefined) return cached;
  try {
    const file = path.join(resolveFrontendDistDir(), "version.json");
    if (!fs.existsSync(file)) {
      cached = null;
      return cached;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof raw.version !== "string" || !raw.version) {
      cached = null;
      return cached;
    }
    cached = {
      name: typeof raw.name === "string" ? raw.name : "nuwax-frontend",
      version: raw.version,
      gitHash: typeof raw.gitHash === "string" ? raw.gitHash : undefined,
    };
  } catch (e) {
    log.warn("[FrontendDistVersion] version.json 读取失败:", String(e));
    cached = null;
  }
  return cached;
}
