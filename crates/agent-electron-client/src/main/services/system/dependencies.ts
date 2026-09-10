/**
 * 依赖管理服务 — Barrel 入口 + 顶层服务函数
 *
 * 所有对外 import 路径保持不变（import from '…/system/dependencies'）。
 * 实现细节分布在各子模块：
 *   - appPaths.ts          路径 getter
 *   - binaryLocator.ts     二进制路径查找
 *   - appEnv.ts            getAppEnv + 镜像源配置
 *   - dependencyChecker.ts  check/detect 检测函数 + 依赖类型定义
 *   - dependencyInstaller.ts installNpmPackage 安装队列
 *   - dependencyUtils.ts   compareVersions
 */

import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { app } from "electron";
import log from "electron-log";
import {
  getSetupRequiredDependencies,
  detectNpmPackage,
  checkNodeVersion,
  checkUvVersion,
  detectShellCommand,
  type LocalDependencyItem,
} from "./dependencyChecker";
import { installNpmPackage } from "./dependencyInstaller";
import {
  setInitDepsState,
  getInitDepsState,
  getAppDataDir,
  getAppBinDir,
  getAppNodeModules,
  getResourcesPath,
} from "./appPaths";
import {
  getNuwaxcodeBundledBinPath,
  getCodexAcpBundledDir,
  getNuwaxFileServerBundledDir,
  getClaudeCodeAcpBundledDir,
  getRipgrepBinPath,
  getUvBinPath,
  getLanproxyBinPath,
  getBundledGitBashPath,
  resolveGitBashExecutable,
} from "./binaryLocator";
import {
  getAppEnv,
  setMirrorConfig,
  getMirrorConfig,
  MIRROR_PRESETS,
} from "./appEnv";
import { compareVersions } from "./dependencyUtils";

// ==================== Barrel re-exports ====================
// 所有子模块公共 API 经此 barrel 统一对外暴露

export type {
  DependencyStatus,
  LocalDependencyType,
  LocalDependencyConfig,
  LocalDependencyItem,
} from "./dependencyChecker";

export {
  getSetupRequiredDependencies,
  checkNodeVersion,
  checkUvVersion,
  checkMcpProxyBundled,
  checkNuwaxcodeBundled,
  checkNuwaxFileServerBundled,
  checkClaudeCodeAcpBundled,
  checkCodexAcpBundled,
  detectNpmPackage,
  detectShellCommand,
} from "./dependencyChecker";

export { installNpmPackage } from "./dependencyInstaller";

export {
  getInitDepsState,
  setInitDepsState,
  getAppDataDir,
  getAppBinDir,
  getAppNodeModules,
  getResourcesPath,
  type InitDepsState,
} from "./appPaths";

export {
  getUvBinPath,
  getRipgrepBinPath,
  getNodeBinPath,
  getNodeBinPathWithFallback,
  getLanproxyBinPath,
  getTtydBinPath,
  getNuwaxcodeBundledBinPath,
  getCodexAcpBundledBinPath,
  getCodexAcpBundledDir,
  getWindowsMcpBinPath,
  getBundledGitBashPath,
  resolveGitBashExecutable,
  getNuwaxFileServerBundledDir,
  getClaudeCodeAcpBundledDir,
} from "./binaryLocator";

export {
  MIRROR_PRESETS,
  setMirrorConfig,
  getMirrorConfig,
  getAppEnv,
  applySharedPackageManagerCacheEnv,
  SHARED_PACKAGE_MANAGER_CACHE_ENV_KEYS,
  type MirrorConfig,
  type GetAppEnvOptions,
} from "./appEnv";

// ==================== Top-level service functions ====================

async function fetchNpmLatestVersion(
  packageName: string,
  timeoutMs = 8_000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const registry = getMirrorConfig().npmRegistry.replace(/\/$/, "");
    const pathSegment = packageName.startsWith("@")
      ? "@" + encodeURIComponent(packageName.slice(1))
      : encodeURIComponent(packageName);
    const url = `${registry}/${pathSegment}`;
    const resp = await fetch(url, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      "dist-tags"?: Record<string, string>;
    };
    return data?.["dist-tags"]?.latest ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkAllDependencies(options?: {
  checkLatest?: boolean;
}): Promise<LocalDependencyItem[]> {
  const results: LocalDependencyItem[] = [];

  for (const dep of getSetupRequiredDependencies()) {
    const item: LocalDependencyItem = {
      ...dep,
      status: "checking",
    };

    try {
      switch (dep.name) {
        case "uv": {
          const result = await checkUvVersion();
          item.status = result.installed
            ? result.bundled
              ? "bundled"
              : "installed"
            : "missing";
          item.version = result.version;
          item.meetsRequirement = result.meetsRequirement;
          item.binPath = result.binPath;
          break;
        }
        case "nuwaxcode": {
          const bundledPath = getNuwaxcodeBundledBinPath();
          if (bundledPath) {
            item.status = "installed";
            item.binPath = bundledPath;
            item.version = dep.installVersion;
            log.info(
              "[checkAllDependencies] nuwaxcode: using bundled binary:",
              bundledPath,
            );
          } else {
            item.status = "missing";
            log.warn(
              "[checkAllDependencies] nuwaxcode: bundled binary not found",
            );
          }
          break;
        }
        case "pnpm": {
          const result = await detectNpmPackage(dep.name, dep.binName);
          item.version = result.version;
          item.binPath = result.binPath;
          if (!result.installed) {
            item.status = "missing";
          } else if (dep.installVersion) {
            const installed = (result.version ?? "0").replace(/^v/, "");
            const target = dep.installVersion.replace(/^v/, "");
            item.status =
              installed === "0" || compareVersions(installed, target) < 0
                ? "outdated"
                : "installed";
          } else {
            item.status = "installed";
          }
          break;
        }
        case "nuwax-file-server": {
          const bundledDir = getNuwaxFileServerBundledDir();
          if (bundledDir) {
            const pkgPath = path.join(bundledDir, "package.json");
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
              item.status = "bundled";
              item.version = pkg.version;
              item.binPath = bundledDir;
            } catch {
              item.status = "missing";
            }
            break;
          }
          // bundled 缺失 → npm 兜底：应用数据目录 node_modules（服务启动
          // serviceManager 对该路径有同样的回退读取），装过即视为可用
          const npmDir = path.join(getAppNodeModules(), dep.name);
          const serverJs = path.join(npmDir, "dist", "server.js");
          if (fs.existsSync(serverJs)) {
            try {
              const pkg = JSON.parse(
                fs.readFileSync(path.join(npmDir, "package.json"), "utf-8"),
              );
              item.status = "bundled";
              item.version = pkg.version;
              item.binPath = npmDir;
            } catch {
              item.status = "bundled";
              item.binPath = npmDir;
            }
          } else {
            item.status = "missing";
          }
          break;
        }
        case "claude-code-acp-ts": {
          const bundledDir = getClaudeCodeAcpBundledDir();
          if (bundledDir) {
            const pkgPath = path.join(bundledDir, "package.json");
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
              item.status = "bundled";
              item.version = pkg.version;
              item.binPath = bundledDir;
            } catch {
              item.status = "missing";
            }
            break;
          }
          // npm 兜底：acpClient.getAcpPackageDir 对该路径有同样的回退读取
          const acpNpmDir = path.join(getAppNodeModules(), dep.name);
          if (fs.existsSync(path.join(acpNpmDir, "package.json"))) {
            try {
              const pkg = JSON.parse(
                fs.readFileSync(path.join(acpNpmDir, "package.json"), "utf-8"),
              );
              item.status = "bundled";
              item.version = pkg.version;
              item.binPath = acpNpmDir;
            } catch {
              item.status = "bundled";
              item.binPath = acpNpmDir;
            }
          } else {
            item.status = "missing";
          }
          break;
        }
        case "nuwax-codex-acp-ts": {
          // codex 经 @nuwax-ai/nuwax-codex-acp-ts TS adapter；检测 resources 里的 adapter 包
          const bundledDir = getCodexAcpTsBundledDir();
          if (bundledDir) {
            try {
              const pkg = JSON.parse(
                fs.readFileSync(path.join(bundledDir, "package.json"), "utf-8"),
              );
              item.status = "bundled";
              item.version = pkg.version;
              item.binPath = bundledDir;
            } catch {
              item.status = "bundled";
            }
            break;
          }
          // npm 兜底：agent-kit resolveCodexAcp 在无 entryOverride 时按包名
          // require.resolve（应用 node_modules 内即可用）
          const codexNpmDir = path.join(
            getAppNodeModules(),
            "@nuwax-ai",
            "nuwax-codex-acp-ts",
          );
          if (fs.existsSync(path.join(codexNpmDir, "package.json"))) {
            try {
              const pkg = JSON.parse(
                fs.readFileSync(
                  path.join(codexNpmDir, "package.json"),
                  "utf-8",
                ),
              );
              item.status = "bundled";
              item.version = pkg.version;
              item.binPath = codexNpmDir;
            } catch {
              item.status = "bundled";
              item.binPath = codexNpmDir;
            }
          } else {
            item.status = "missing";
          }
          break;
        }
        case "ripgrep": {
          const rgPath = getRipgrepBinPath();
          if (fs.existsSync(rgPath)) {
            item.status = "bundled";
            item.binPath = rgPath;
            try {
              const ver = execFileSync(rgPath, ["--version"], {
                encoding: "utf-8",
                timeout: 5000,
              }).trim();
              item.version =
                ver.split("\n")[0].replace(/^ripgrep\s+/, "") || "unknown";
            } catch {
              item.version = "unknown";
            }
          } else {
            item.status = "missing";
          }
          break;
        }
        default: {
          item.status = "missing";
        }
      }
    } catch (error) {
      item.status = "error";
      item.errorMessage = String(error);
    }

    // 缺失时是否可经应用内安装动作修复：npm 兜底（file-server/ACP 类）
    // 或下载通道（nuwaxcode）；uv/ripgrep 等保持仅 bundled + 人工指引
    item.runtimeInstallable =
      Boolean(dep.npmFallback) || dep.name === "nuwaxcode";

    results.push(item);
  }

  if (options?.checkLatest) {
    const npmInstalled = results.filter(
      (r) =>
        r.type === "npm-local" &&
        (r.status === "installed" || r.status === "outdated"),
    );
    if (npmInstalled.length > 0) {
      const latestResults = await Promise.all(
        npmInstalled.map((r) => fetchNpmLatestVersion(r.name)),
      );
      for (let i = 0; i < npmInstalled.length; i++) {
        const latest = latestResults[i];
        if (latest == null) continue;
        const installed = (npmInstalled[i].version ?? "").replace(/^v/, "");
        const latestNorm = latest.replace(/^v/, "");
        if (compareVersions(latestNorm, installed) > 0) {
          npmInstalled[i].latestVersion = latest;
        }
      }
    }
  }

  return results;
}

export async function installMissingDependencies(): Promise<{
  success: boolean;
  results: Array<{ name: string; success: boolean; error?: string }>;
}> {
  const results: Array<{ name: string; success: boolean; error?: string }> = [];
  const deps = await checkAllDependencies();

  for (const dep of deps) {
    const needInstall =
      (dep.status === "missing" && dep.required) ||
      (dep.status === "missing" && Boolean(dep.npmFallback)) ||
      (dep.status === "outdated" &&
        dep.installVersion &&
        dep.type === "npm-local");

    if (!needInstall) continue;

    if (dep.status === "outdated") {
      log.info(
        `[Dependencies] Upgrading to configured version: ${dep.name}@${dep.installVersion}`,
      );
    } else {
      log.info(`[Dependencies] Installing missing: ${dep.name}`);
    }

    if (dep.type === "npm-local") {
      const result = await installNpmPackage(
        dep.name,
        dep.installVersion ? { version: dep.installVersion } : undefined,
      );
      results.push({
        name: dep.name,
        success: result.success,
        error: result.error,
      });
    } else if (dep.npmFallback) {
      // bundled 经 npm 兜底通道装进应用数据目录 node_modules（服务侧已有同路径回退）
      const result = await installNpmPackage(dep.npmFallback.packageName, {
        version: dep.npmFallback.version,
      });
      results.push({
        name: dep.name,
        success: result.success,
        error: result.error,
      });
    } else {
      results.push({
        name: dep.name,
        success: false,
        error: "System dependency - manual install required",
      });
    }
  }

  if (results.some((r) => r.success)) {
    const packages: Record<string, string> = {};
    for (const d of getSetupRequiredDependencies()) {
      if (d.installVersion) packages[d.name] = d.installVersion;
    }
    setInitDepsState({ appVersion: app.getVersion(), packages });
  }

  return { success: results.every((r) => r.success), results };
}

/** bundled 依赖的 npm 兜底映射查询（无则 null）。供安装 IPC 分流。 */
export function getNpmFallbackFor(
  name: string,
): { packageName: string; version: string } | null {
  return (
    getSetupRequiredDependencies().find((d) => d.name === name)?.npmFallback ??
    null
  );
}

export async function syncInitDependencies(): Promise<{ updated: string[] }> {
  const updated: string[] = [];
  const packages: Record<string, string> = {};

  for (const dep of getSetupRequiredDependencies()) {
    if (!dep.installVersion || dep.type !== "npm-local") continue;

    const detected = await detectNpmPackage(dep.name, dep.binName);
    const installedVer = (detected.version ?? "").replace(/^v/, "");
    const targetVer = dep.installVersion.replace(/^v/, "");
    const needInstall =
      !detected.installed ||
      !installedVer ||
      compareVersions(installedVer, targetVer) < 0;

    if (needInstall) {
      log.info(
        `[Dependencies] syncInitDependencies: installing/upgrading ${dep.name}@${dep.installVersion}`,
      );
      const result = await installNpmPackage(dep.name, {
        version: dep.installVersion,
      });
      if (result.success) updated.push(dep.name);
      else
        log.warn(
          `[Dependencies] syncInitDependencies: ${dep.name} install failed`,
          result.error,
        );
    }
    packages[dep.name] = dep.installVersion;
  }

  setInitDepsState({ appVersion: app.getVersion(), packages });
  if (updated.length > 0)
    log.info("[Dependencies] syncInitDependencies updated:", updated);
  return { updated };
}

export function getDependenciesSummary(): {
  total: number;
  installed: number;
  missing: number;
  missingRequired: string[];
} {
  return {
    total: getSetupRequiredDependencies().length,
    installed: 0,
    missing: 0,
    missingRequired: [],
  };
}

// ==================== default export (backwards compat) ====================

export default {
  getSetupRequiredDependencies,
  checkNodeVersion,
  checkUvVersion,
  detectNpmPackage,
  detectShellCommand,
  installNpmPackage,
  checkAllDependencies,
  installMissingDependencies,
  getInitDepsState,
  setInitDepsState,
  syncInitDependencies,
  getAppDataDir,
  getAppBinDir,
  getAppNodeModules,
  getResourcesPath,
  getUvBinPath,
  getLanproxyBinPath,
  getBundledGitBashPath,
  resolveGitBashExecutable,
  getAppEnv,
  setMirrorConfig,
  getMirrorConfig,
  MIRROR_PRESETS,
  getNuwaxFileServerBundledDir,
  getClaudeCodeAcpBundledDir,
  getCodexAcpBundledDir,
};

// codex TS adapter bundled dir（binaryLocator 新增；import 供本地 case 用 + re-export 给 acpClient）
import { getCodexAcpTsBundledDir } from "./binaryLocator";
export { getCodexAcpTsBundledDir };
