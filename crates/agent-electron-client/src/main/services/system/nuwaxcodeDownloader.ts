/**
 * nuwaxcode 运行时下载通道。
 *
 * nuwaxcode 是平台原生二进制（非 npm 包），打包期经 prepare:nuwaxcode 从
 * GitHub Release 产出 resources/nuwaxcode。fresh/损坏环境下 resources 缺失时，
 * 从 OSS 依赖通道下载同名布局压缩包解压到应用数据目录：
 *
 *   ${NUWAX_DEPS_DOWNLOAD_BASE}/nuwaxcode/{version}/{platform}-{arch}.zip
 *   压缩包内目录布局与 resources/nuwaxcode 一致：
 *     nuwaxcode/{platform}-{arch}/bin/nuwaxcode(.exe)
 *
 * 解压使用系统 tar（Windows 10+ / macOS 自带 bsdtar，可解 zip）；linux 的
 * GNU tar 不支持 zip，会显式报错引导人工安装。
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import log from "electron-log";
import { getAppDataDir } from "./appPaths";

/** nuwaxcode 下载版本（与 dependencyChecker required 清单 installVersion 对齐）。 */
const NUWAXCODE_VERSION = "1.17.5";

/** 依赖下载基址：OSS 依赖通道（产物须上传至 nuwax-electron/deps，随商业更新通道改名 2026-09-11）。 */
const DEPS_DOWNLOAD_BASE =
  process.env.NUWAX_DEPS_DOWNLOAD_BASE?.trim() ||
  "https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron/deps";

function platformKey(): string {
  const map: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };
  return map[os.platform()] || os.platform();
}

function archKey(): string {
  const map: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
    arm: "arm",
  };
  return map[os.arch()] || os.arch();
}

/** 下载（跟随重定向）到目标文件。 */
async function downloadTo(url: string, destFile: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, buf);
}

/** 系统 tar 解压 zip（Windows 10+/macOS 的 bsdtar 支持 zip 格式）。 */
function extractZip(zipFile: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const tarBin = process.platform === "win32" ? "tar.exe" : "tar";
    const proc = spawn(tarBin, ["-xf", zipFile, "-C", destDir], {
      stdio: "ignore",
    });
    proc.on("error", (err) =>
      reject(new Error(`tar extract failed: ${err.message}`)),
    );
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `tar extract exit ${code}（当前平台 tar 可能不支持 zip，请人工安装）`,
          ),
        );
    });
  });
}

/**
 * 下载并安装 nuwaxcode 到应用数据目录。幂等：目标二进制已存在则直接成功。
 * 失败时抛错（error.message 面向 UI 展示），调用方负责状态呈现。
 */
export async function downloadNuwaxcode(): Promise<{
  success: boolean;
  version: string;
  binPath?: string;
  error?: string;
}> {
  const platform = platformKey();
  const arch = archKey();
  const binary = platform === "windows" ? "nuwaxcode.exe" : "nuwaxcode";
  const destRoot = path.join(getAppDataDir(), "nuwaxcode");
  const expectedBin = path.join(destRoot, `${platform}-${arch}`, "bin", binary);

  if (fs.existsSync(expectedBin)) {
    log.info("[NuwaxcodeDeps] already installed:", expectedBin);
    return { success: true, version: NUWAXCODE_VERSION, binPath: expectedBin };
  }

  const url = `${DEPS_DOWNLOAD_BASE}/nuwaxcode/${NUWAXCODE_VERSION}/${platform}-${arch}.zip`;
  const tmpZip = path.join(
    getAppDataDir(),
    "tmp",
    `nuwaxcode-${NUWAXCODE_VERSION}-${platform}-${arch}.zip`,
  );
  log.info(`[NuwaxcodeDeps] downloading ${url}`);
  try {
    await downloadTo(url, tmpZip);
    await extractZip(tmpZip, destRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("[NuwaxcodeDeps] install failed:", msg);
    return { success: false, version: NUWAXCODE_VERSION, error: msg };
  } finally {
    try {
      fs.rmSync(tmpZip, { force: true });
    } catch {}
  }

  if (!fs.existsSync(expectedBin)) {
    const msg = "下载完成但未找到预期二进制（压缩包布局不符）";
    log.error(`[NuwaxcodeDeps] ${msg}`);
    return { success: false, version: NUWAXCODE_VERSION, error: msg };
  }

  log.info(`[NuwaxcodeDeps] installed: ${expectedBin}`);
  return { success: true, version: NUWAXCODE_VERSION, binPath: expectedBin };
}
