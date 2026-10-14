/**
 * Linux deb 安装形态的客户端内升级。
 *
 * electron-updater 的 DebUpdater 用 spawnSync 调 pkexec：等待授权期间主进程冻结；且 Chromium
 * 启动后会把自身移入 systemd 用户作用域（app-org.chromium.Chromium-*.scope），polkit 无法识别
 * 所属登录会话，会把密码框弹到物理屏会话上，xrdp 等远程桌面里看不到。
 *
 * 这里改为：zenity 作 SUDO_ASKPASS（由本进程拉起、继承本进程的 DISPLAY，弹在用户当前桌面），
 * 先 `sudo -A -v` 授权，授权成功才执行 beforeInstall（停服务），再异步执行 dpkg。
 * sudo 无终端时凭据按父进程缓存，安装步骤通常无需二次输入密码。
 */

import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** $1 = deb 路径。dpkg 因依赖缺失失败时由 apt-get 补齐依赖并完成配置。 */
export const DEB_INSTALL_SCRIPT =
  'export DEBIAN_FRONTEND=noninteractive; dpkg -i "$1" || apt-get install -f -y';

export type LinuxDebInstallResult =
  | { ok: true }
  | { ok: false; reason: "no-askpass" | "auth-failed" | "install-failed" };

export interface LinuxDebInstallOptions {
  debPath: string;
  /** dpkg 输出追加写入的日志文件 */
  logPath: string;
  askpassTitle: string;
  /** 授权成功后、执行安装前调用（停服务等）；授权失败时不会调用 */
  beforeInstall: () => Promise<void>;
}

export interface LinuxDebInstallerDeps {
  spawn: (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;
  findCommand: (name: string) => string | null;
  isRoot: () => boolean;
  createAskpass: (
    zenityPath: string,
    title: string,
  ) => { path: string; dispose: () => void };
  openLog: (logPath: string) => number;
  closeLog: (fd: number) => void;
}

function findCommandInPath(name: string): string | null {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续查找下一个 PATH 目录
    }
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createAskpassScript(
  zenityPath: string,
  title: string,
): { path: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuwax-askpass-"));
  const scriptPath = path.join(dir, "askpass.sh");
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh\nexec ${shellQuote(zenityPath)} --password --title=${shellQuote(title)}\n`,
    { mode: 0o700 },
  );
  return {
    path: scriptPath,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function openLogFile(logPath: string): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "a");
  fs.writeSync(fd, `\n===== ${new Date().toISOString()} deb install =====\n`);
  return fd;
}

const defaultDeps: LinuxDebInstallerDeps = {
  spawn: nodeSpawn,
  findCommand: findCommandInPath,
  isRoot: () => process.getuid?.() === 0,
  createAskpass: createAskpassScript,
  openLog: openLogFile,
  closeLog: (fd) => fs.closeSync(fd),
};

/** 进程退出码；无法启动返回 null。 */
function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  });
}

export async function installLinuxDeb(
  options: LinuxDebInstallOptions,
  deps: LinuxDebInstallerDeps = defaultDeps,
): Promise<LinuxDebInstallResult> {
  const scriptArgs = ["-c", DEB_INSTALL_SCRIPT, "nuwax-update", options.debPath];

  if (deps.isRoot()) {
    await options.beforeInstall();
    return runInstall(deps, options.logPath, "/bin/sh", scriptArgs, process.env);
  }

  const zenityPath = deps.findCommand("zenity");
  if (!zenityPath) return { ok: false, reason: "no-askpass" };

  const askpass = deps.createAskpass(zenityPath, options.askpassTitle);
  try {
    const env = { ...process.env, SUDO_ASKPASS: askpass.path };
    const authCode = await waitForExit(
      deps.spawn("sudo", ["-A", "-v"], { env, stdio: "ignore" }),
    );
    if (authCode !== 0) return { ok: false, reason: "auth-failed" };

    await options.beforeInstall();
    return await runInstall(
      deps,
      options.logPath,
      "sudo",
      ["-A", "--", "/bin/sh", ...scriptArgs],
      env,
    );
  } finally {
    askpass.dispose();
  }
}

async function runInstall(
  deps: LinuxDebInstallerDeps,
  logPath: string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<LinuxDebInstallResult> {
  const fd = deps.openLog(logPath);
  try {
    // 输出写文件不接管道：壳在安装中途退出时 dpkg 不会因 SIGPIPE 中止。
    // 不能 detached：新会话里 sudo 认不到 `sudo -v` 的授权缓存，会再弹一次密码框。
    const code = await waitForExit(
      deps.spawn(cmd, args, { env, stdio: ["ignore", fd, fd] }),
    );
    return code === 0 ? { ok: true } : { ok: false, reason: "install-failed" };
  } finally {
    deps.closeLog(fd);
  }
}
