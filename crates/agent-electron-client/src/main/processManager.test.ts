/**
 * 单元测试: ManagedProcess — stop() 监听器清理 & kill() 升级超时
 *
 * 覆盖内容：
 * - stop() 调用 removeAllListeners 防止句柄泄漏
 * - stop() 在无进程时返回 Not running
 * - stop()/kill() 委托进程树清理，避免子进程残留
 * - kill() 在无进程时不报错
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

const processTreeMocks = vi.hoisted(() => ({
  killProcessTreeGraceful: vi.fn(() => Promise.resolve()),
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("./services/utils/processTree", () => processTreeMocks);

import { ManagedProcess } from "./processManager";
import { spawn } from "child_process";
import { PROCESS_KILL_ESCALATION_TIMEOUT } from "@shared/constants";

/** Create a fake ChildProcess-like object */
function createFakeProc() {
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

/** Inject a fake process into a ManagedProcess instance */
function injectProcess(mp: ManagedProcess, proc: any) {
  (mp as any).process = proc;
}

describe("ManagedProcess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processTreeMocks.killProcessTreeGraceful.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("an old child's late exit cannot clear a replacement or its startup timer", async () => {
    vi.useFakeTimers();
    const first = createFakeProc(); const replacement = createFakeProc();
    vi.mocked(spawn).mockReturnValueOnce(first).mockReturnValueOnce(replacement);
    const mp = new ManagedProcess("retry");
    const attempt = mp.start({ command: "node", args: [], startupDelayMs: 1000 });
    first.emit("error", Object.assign(new Error("bind failed"), { code: "EADDRINUSE" }));
    expect(await attempt).toMatchObject({ success: false, errorCode: "EADDRINUSE" });
    const next = mp.start({ command: "node", args: [], startupDelayMs: 2000 });
    first.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await next).toMatchObject({ success: true });
    expect(mp.running).toBe(true);
    mp.stop();
  });

  it("preserves the file service's structured bind error code", async () => {
    vi.useFakeTimers();
    const proc = createFakeProc(); vi.mocked(spawn).mockReturnValueOnce(proc);
    const mp = new ManagedProcess("fileServer");
    const result = mp.start({ command: "node", args: [], startupDelayMs: 10 });
    proc.stderr.emit("data", Buffer.from('NUWAX_SERVICE_ERROR:{"code":"EADDRINUSE"}\n'));
    proc.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ success: false, errorCode: "EADDRINUSE" });
  });

  it("cancels a pending start and waits for its owned process cleanup", async () => {
    vi.useFakeTimers();
    const proc = createFakeProc(); vi.mocked(spawn).mockReturnValueOnce(proc);
    const mp = new ManagedProcess("cancel"); const controller = new AbortController();
    const result = mp.start({ command: "node", args: [], signal: controller.signal });
    controller.abort();
    expect(await result).toMatchObject({ success: false, error: "Service start cancelled" });
    expect(processTreeMocks.killProcessTreeGraceful).toHaveBeenCalledWith(proc.pid, 3000);
    expect(mp.running).toBe(false);
  });

  describe("stop()", () => {
    it("returns Not running when no process exists", () => {
      const mp = new ManagedProcess("test");
      const result = mp.stop();
      expect(result).toEqual({ success: true, message: "Not running" });
    });

    it("removes all listeners before killing", () => {
      const mp = new ManagedProcess("test");
      const proc = createFakeProc();
      injectProcess(mp, proc);

      const stdoutRemove = vi.spyOn(proc.stdout, "removeAllListeners");
      const stderrRemove = vi.spyOn(proc.stderr, "removeAllListeners");
      const stdinRemove = vi.spyOn(proc.stdin, "removeAllListeners");
      const procRemove = vi.spyOn(proc, "removeAllListeners");

      const result = mp.stop();

      expect(result).toEqual({ success: true });
      expect(stdoutRemove).toHaveBeenCalled();
      expect(stderrRemove).toHaveBeenCalled();
      expect(stdinRemove).toHaveBeenCalled();
      expect(procRemove).toHaveBeenCalled();
      expect(processTreeMocks.killProcessTreeGraceful).toHaveBeenCalledWith(
        12345,
        PROCESS_KILL_ESCALATION_TIMEOUT,
      );
      expect(mp.running).toBe(false);
    });

    it("sets process to null before process tree cleanup", () => {
      const mp = new ManagedProcess("test");
      const proc = createFakeProc();
      injectProcess(mp, proc);

      let runningDuringCleanup: boolean | undefined;
      processTreeMocks.killProcessTreeGraceful.mockImplementationOnce(() => {
        runningDuringCleanup = mp.running;
        return Promise.resolve();
      });

      mp.stop();
      expect(runningDuringCleanup).toBe(false);
    });
  });

  describe("kill()", () => {
    it("does not throw when no process exists", () => {
      const mp = new ManagedProcess("test");
      expect(() => mp.kill()).not.toThrow();
    });

    it("delegates cleanup to process tree graceful kill", () => {
      const mp = new ManagedProcess("test");
      const proc = createFakeProc();
      injectProcess(mp, proc);

      mp.kill();

      expect(mp.running).toBe(false);
      expect(processTreeMocks.killProcessTreeGraceful).toHaveBeenCalledWith(
        12345,
        PROCESS_KILL_ESCALATION_TIMEOUT,
      );
    });

    it("removes all listeners on the process", () => {
      const mp = new ManagedProcess("test");
      const proc = createFakeProc();
      injectProcess(mp, proc);

      const removeAll = vi.spyOn(proc, "removeAllListeners");
      const stdoutRemove = vi.spyOn(proc.stdout, "removeAllListeners");

      mp.kill();

      expect(removeAll).toHaveBeenCalled();
      expect(stdoutRemove).toHaveBeenCalled();
    });
  });
});

it("stopAsync reports failed tree cleanup and preserves process for retry", async () => {
  const proc = createFakeProc();
  const mp = new ManagedProcess("test");
  injectProcess(mp, proc);
  processTreeMocks.killProcessTreeGraceful.mockRejectedValueOnce(
    new Error("denied"),
  );
  expect((await mp.stopAsync()).success).toBe(false);
  expect(mp.running).toBe(true);
});
