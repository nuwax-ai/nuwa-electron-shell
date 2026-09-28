import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupMcpArchiveLogs,
  createMcpLogRetentionRunner,
} from "./logRetention";

// 仍使用真实文件系统，仅让两个异常/竞争用例可以在真实操作前插入故障。
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const day = 24 * 60 * 60 * 1000;
const now = new Date(2026, 8, 28, 12).getTime();
const options = { maxAgeMs: 30 * day, now: () => now };
let logDir: string;
const dateName = (daysAgo: number) => {
  const date = new Date(now - daysAgo * day);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const createLog = async (
  project: string,
  server: string,
  daysAgo: number,
  content = "old",
  mtimeDaysAgo = daysAgo,
) => {
  const directory = path.join(logDir, "mcp-proxy", project);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${server}-${dateName(daysAgo)}.log`);
  await fs.writeFile(file, content);
  const mtime = new Date(now - mtimeDaysAgo * day);
  await fs.utimes(file, mtime, mtime);
  return file;
};

beforeEach(async () => {
  logDir = await fs.mkdtemp(path.join(os.tmpdir(), "nuwax-log-retention-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(logDir, { recursive: true, force: true });
});

describe("MCP 日归档真实文件清理", () => {
  it("递归覆盖停止项目，开发30天与生产7天TTL采用现有mtime语义", async () => {
    const expired = await createLog("stopped/nested", "server", 40);
    const tenDays = await createLog("running", "other", 10);
    const first = await cleanupMcpArchiveLogs(logDir, options);
    expect(first.deletedFiles).toBe(1);
    await expect(fs.access(expired)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(tenDays, "utf8")).toBe("old");
    const production = await cleanupMcpArchiveLogs(logDir, {
      ...options,
      maxAgeMs: 7 * day,
    });
    expect(production.deletedFiles).toBe(1);
    await expect(fs.access(tenDays)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("跨项目按最旧mtime先淘汰，冷归档总量不超过配置预算", async () => {
    const oldest = await createLog("a", "first", 6, "aaaa");
    const middle = await createLog("b", "second", 5, "bbbb");
    const newest = await createLog("stopped", "third", 4, "cccc");
    const active = await createLog(
      "a",
      "active",
      0,
      "active file exceeds the archive budget",
    );
    const result = await cleanupMcpArchiveLogs(logDir, {
      ...options,
      maxArchiveBytes: 5,
    });
    expect(result).toEqual({
      deletedFiles: 2,
      deletedBytes: 8,
      retainedArchiveBytes: 4,
    });
    await expect(fs.access(oldest)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(middle)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(newest, "utf8")).toBe("cccc");
    expect(await fs.readFile(active, "utf8")).toContain("active file");
  });

  it("保护当日/未来、近期mtime、latest目标、硬链接及非日志/任务文件", async () => {
    const today = await createLog("a", "today", 0, "today", 40);
    const future = await createLog("a", "future", -1, "future", 40);
    const active = await createLog("a", "active", 40, "active", 0.5);
    const latestTarget = await createLog("a", "linked", 40, "latest target");
    const hardLinked = await createLog("a", "hard", 40, "hard linked");
    const directory = path.dirname(today);
    await fs.symlink(
      path.basename(latestTarget),
      path.join(directory, "latest.log"),
    );
    await fs.link(hardLinked, path.join(directory, "latest-hard.log"));
    const task = path.join(directory, "task.json");
    const undated = path.join(directory, "server.log");
    const invalidDate = path.join(directory, "server-2026-02-30.log");
    await Promise.all([
      fs.writeFile(task, "task"),
      fs.writeFile(undated, "undated"),
      fs.writeFile(invalidDate, "invalid"),
    ]);
    for (const file of [task, undated, invalidDate])
      await fs.utimes(file, new Date(now - 40 * day), new Date(now - 40 * day));
    const result = await cleanupMcpArchiveLogs(logDir, {
      ...options,
      maxArchiveBytes: 0,
    });
    expect(result.deletedFiles).toBe(0);
    for (const file of [
      today,
      future,
      active,
      latestTarget,
      hardLinked,
      task,
      undated,
      invalidDate,
    ])
      await expect(fs.access(file)).resolves.toBeUndefined();
    expect(await fs.readlink(path.join(directory, "latest.log"))).toBe(
      path.basename(latestTarget),
    );
  });

  it("不进入符号链接目录、不删除日志符号链接及其外部目标", async () => {
    const outside = path.join(logDir, "outside");
    const root = path.join(logDir, "mcp-proxy");
    await fs.mkdir(outside);
    await fs.mkdir(root);
    const external = path.join(outside, `server-${dateName(40)}.log`);
    await fs.writeFile(external, "outside");
    await fs.utimes(
      external,
      new Date(now - 40 * day),
      new Date(now - 40 * day),
    );
    await fs.symlink(outside, path.join(root, "project-link"), "dir");
    await fs.symlink(external, path.join(root, `linked-${dateName(40)}.log`));
    expect(
      (await cleanupMcpArchiveLogs(logDir, { ...options, maxArchiveBytes: 0 }))
        .deletedFiles,
    ).toBe(0);
    expect(await fs.readFile(external, "utf8")).toBe("outside");
    expect(
      (await fs.lstat(path.join(root, "project-link"))).isSymbolicLink(),
    ).toBe(true);
  });

  it("MCP根目录为符号链接时也不进入扫描", async () => {
    const outside = path.join(logDir, "outside");
    await fs.mkdir(outside);
    const file = path.join(outside, `server-${dateName(40)}.log`);
    await fs.writeFile(file, "outside");
    await fs.symlink(outside, path.join(logDir, "mcp-proxy"), "dir");
    expect((await cleanupMcpArchiveLogs(logDir, options)).deletedFiles).toBe(0);
    expect(await fs.readFile(file, "utf8")).toBe("outside");
  });

  it("同一runner扫描不重叠，完成后下一次调度仍能清理新增归档", async () => {
    await createLog("a", "old", 40);
    const run = createMcpLogRetentionRunner(logDir, options);
    const first = run();
    expect(run()).toBe(first);
    expect((await first).deletedFiles).toBe(1);
    await createLog("a", "next", 40);
    const next = run();
    expect(next).not.toBe(first);
    expect((await next).deletedFiles).toBe(1);
  });

  it("扫描后新写入的文件在删除前重新校验并保留", async () => {
    const file = await createLog("a", "old", 40);
    const originalLstat = fs.lstat;
    let reads = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (args[0] === file && ++reads === 2)
        await fs.appendFile(file, " new data");
      return originalLstat(...args);
    });
    expect((await cleanupMcpArchiveLogs(logDir, options)).deletedFiles).toBe(0);
    expect(await fs.readFile(file, "utf8")).toBe("old new data");
  });

  it("单个删除失败后继续清理其他归档", async () => {
    const denied = await createLog("a", "denied", 40);
    const other = await createLog("a", "other", 40);
    const originalUnlink = fs.unlink;
    vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === denied)
        throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      return originalUnlink(file);
    });
    const onError = vi.fn();
    expect(
      (await cleanupMcpArchiveLogs(logDir, { ...options, onError }))
        .deletedFiles,
    ).toBe(1);
    expect(await fs.readFile(denied, "utf8")).toBe("old");
    await expect(fs.access(other)).rejects.toMatchObject({ code: "ENOENT" });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EACCES" }),
      denied,
    );
  });

  it("目录扫描失败与抛错的诊断回调不阻断任务，后续调度可恢复", async () => {
    const fileAsDirectory = path.join(logDir, "not-a-directory");
    await fs.writeFile(fileAsDirectory, "file");
    const report = vi.fn(() => {
      throw new Error("diagnostic failure");
    });
    const run = createMcpLogRetentionRunner(fileAsDirectory, {
      ...options,
      onError: report,
    });
    await expect(run()).resolves.toEqual({
      deletedFiles: 0,
      deletedBytes: 0,
      retainedArchiveBytes: 0,
    });
    expect(report).toHaveBeenCalledOnce();
    await fs.unlink(fileAsDirectory);
    const nested = path.join(fileAsDirectory, "mcp-proxy", "a");
    await fs.mkdir(nested, { recursive: true });
    const old = path.join(nested, `server-${dateName(40)}.log`);
    await fs.writeFile(old, "old");
    await fs.utimes(old, new Date(now - 40 * day), new Date(now - 40 * day));
    expect((await run()).deletedFiles).toBe(1);
  });

  it("不存在MCP目录时为无操作", async () => {
    const report = vi.fn();
    await expect(
      cleanupMcpArchiveLogs(logDir, { ...options, onError: report }),
    ).resolves.toEqual({
      deletedFiles: 0,
      deletedBytes: 0,
      retainedArchiveBytes: 0,
    });
    expect(report).not.toHaveBeenCalled();
  });
});
