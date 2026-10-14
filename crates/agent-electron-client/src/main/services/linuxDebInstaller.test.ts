import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import {
  installLinuxDeb,
  DEB_INSTALL_SCRIPT,
  type LinuxDebInstallerDeps,
} from "./linuxDebInstaller";

interface SpawnCall {
  cmd: string;
  args: string[];
  options: any;
}

function makeDeps(
  exitCodes: Array<number | null>,
  overrides: Partial<LinuxDebInstallerDeps> = {},
) {
  const calls: SpawnCall[] = [];
  const disposeAskpass = vi.fn();
  const closeLog = vi.fn();
  const deps: LinuxDebInstallerDeps = {
    spawn: ((cmd: string, args: string[], options: any) => {
      calls.push({ cmd, args, options });
      const child = new EventEmitter() as any;
      const code = exitCodes.shift();
      setImmediate(() => {
        if (code === undefined) child.emit("error", new Error("spawn ENOENT"));
        else child.emit("exit", code);
      });
      return child;
    }) as any,
    findCommand: (name) => (name === "zenity" ? "/usr/bin/zenity" : null),
    isRoot: () => false,
    createAskpass: vi.fn(() => ({
      path: "/tmp/nuwax-askpass-x/askpass.sh",
      dispose: disposeAskpass,
    })),
    openLog: vi.fn(() => 42),
    closeLog,
    ...overrides,
  };
  return { deps, calls, disposeAskpass, closeLog };
}

const baseOptions = () => ({
  debPath: "/home/u/.cache/nuwax-updater/pending/Nuwax-3.0.14-beta.6-amd64.deb",
  logPath: "/home/u/.nuwax/logs/update-install.log",
  askpassTitle: "需要管理员密码",
  beforeInstall: vi.fn(async () => {}),
});

describe("installLinuxDeb", () => {
  it("先 sudo -A -v 授权，成功后才清理，再以同一 askpass 执行 dpkg", async () => {
    const { deps, calls, disposeAskpass, closeLog } = makeDeps([0, 0]);
    const options = baseOptions();
    const order: string[] = [];
    options.beforeInstall.mockImplementation(async () => {
      order.push(`beforeInstall after ${calls.length} spawn(s)`);
    });

    const result = await installLinuxDeb(options, deps);

    expect(result).toEqual({ ok: true });
    expect(deps.createAskpass).toHaveBeenCalledWith(
      "/usr/bin/zenity",
      "需要管理员密码",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe("sudo");
    expect(calls[0].args).toEqual(["-A", "-v"]);
    expect(calls[0].options.env.SUDO_ASKPASS).toBe(
      "/tmp/nuwax-askpass-x/askpass.sh",
    );
    expect(order).toEqual(["beforeInstall after 1 spawn(s)"]);
    expect(calls[1].cmd).toBe("sudo");
    expect(calls[1].args).toEqual([
      "-A",
      "--",
      "/bin/sh",
      "-c",
      DEB_INSTALL_SCRIPT,
      "nuwax-update",
      options.debPath,
    ]);
    expect(calls[1].options.env.SUDO_ASKPASS).toBe(
      "/tmp/nuwax-askpass-x/askpass.sh",
    );
    // dpkg 输出落日志文件，不接管道：壳退出时不会因 SIGPIPE 连带终止 dpkg
    expect(calls[1].options.stdio).toEqual(["ignore", 42, 42]);
    // detached 会让 sudo 进新会话、认不到 `sudo -v` 的授权缓存而二次弹框（真机实测）
    expect(calls[1].options.detached).toBeUndefined();
    expect(closeLog).toHaveBeenCalledWith(42);
    expect(disposeAskpass).toHaveBeenCalledTimes(1);
  });

  it("授权失败（取消或密码错误）不清理、不安装", async () => {
    const { deps, calls, disposeAskpass } = makeDeps([1]);
    const options = baseOptions();

    const result = await installLinuxDeb(options, deps);

    expect(result).toEqual({ ok: false, reason: "auth-failed" });
    expect(calls).toHaveLength(1);
    expect(options.beforeInstall).not.toHaveBeenCalled();
    expect(disposeAskpass).toHaveBeenCalledTimes(1);
  });

  it("sudo 无法启动按授权失败处理", async () => {
    const { deps } = makeDeps([undefined as unknown as number]);
    const options = baseOptions();

    const result = await installLinuxDeb(options, deps);

    expect(result).toEqual({ ok: false, reason: "auth-failed" });
    expect(options.beforeInstall).not.toHaveBeenCalled();
  });

  it("没有 zenity 时不清理、不调用 sudo", async () => {
    const { deps, calls } = makeDeps([], { findCommand: () => null });
    const options = baseOptions();

    const result = await installLinuxDeb(options, deps);

    expect(result).toEqual({ ok: false, reason: "no-askpass" });
    expect(calls).toHaveLength(0);
    expect(deps.createAskpass).not.toHaveBeenCalled();
    expect(options.beforeInstall).not.toHaveBeenCalled();
  });

  it("dpkg 非零退出返回 install-failed，并清理 askpass", async () => {
    const { deps, disposeAskpass, closeLog } = makeDeps([0, 1]);
    const options = baseOptions();

    const result = await installLinuxDeb(options, deps);

    expect(result).toEqual({ ok: false, reason: "install-failed" });
    expect(options.beforeInstall).toHaveBeenCalledTimes(1);
    expect(closeLog).toHaveBeenCalledWith(42);
    expect(disposeAskpass).toHaveBeenCalledTimes(1);
  });

  it("以 root 运行时跳过授权，直接执行安装脚本", async () => {
    const { deps, calls } = makeDeps([0], {
      isRoot: () => true,
      findCommand: () => null,
    });
    const options = baseOptions();

    const result = await installLinuxDeb(options, deps);

    expect(result).toEqual({ ok: true });
    expect(deps.createAskpass).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("/bin/sh");
    expect(calls[0].args).toEqual([
      "-c",
      DEB_INSTALL_SCRIPT,
      "nuwax-update",
      options.debPath,
    ]);
  });

  it("安装脚本 dpkg 失败时补跑 apt-get 修依赖，并以非交互模式运行", () => {
    expect(DEB_INSTALL_SCRIPT).toContain('dpkg -i "$1"');
    expect(DEB_INSTALL_SCRIPT).toContain("apt-get install -f -y");
    expect(DEB_INSTALL_SCRIPT).toContain("DEBIAN_FRONTEND=noninteractive");
  });
});
