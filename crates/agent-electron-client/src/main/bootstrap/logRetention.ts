import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";

/** 预算只约束冷归档；当日或仍在写入的文件不参与淘汰。 */
export const MCP_ARCHIVE_BUDGET_BYTES = 256 * 1024 * 1024;
export const MCP_ACTIVE_FILE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface LogRetentionOptions {
  maxAgeMs: number;
  maxArchiveBytes?: number;
  activeGraceMs?: number;
  now?: () => number;
  onError?: (error: unknown, file: string) => void;
}

export interface LogRetentionResult {
  deletedFiles: number;
  deletedBytes: number;
  retainedArchiveBytes: number;
}

interface Archive {
  file: string;
  stat: Stats;
}

function localDate(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function archiveDate(name: string): string | undefined {
  // Host adapter 的 project/server 标识只包含字母、数字、下划线和连字符。
  const match = /^[a-zA-Z0-9_-]+-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
  if (!match) return;
  const date = new Date(`${match[1]}T12:00:00`);
  if (!Number.isNaN(date.getTime()) && localDate(date.getTime()) === match[1]) {
    return match[1];
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

/**
 * 异步遍历所有项目（包括已停止项目）的 MCP 日归档；不进入符号链接目录，
 * 不截断活跃文件。TTL 后按最旧 mtime 淘汰，直到冷归档满足总预算。
 */
export async function cleanupMcpArchiveLogs(
  logDir: string,
  options: LogRetentionOptions,
): Promise<LogRetentionResult> {
  const result: LogRetentionResult = {
    deletedFiles: 0,
    deletedBytes: 0,
    retainedArchiveBytes: 0,
  };
  const now = options.now?.() ?? Date.now();
  const today = localDate(now);
  const graceMs = options.activeGraceMs ?? MCP_ACTIVE_FILE_GRACE_MS;
  const budget = Math.max(
    0,
    options.maxArchiveBytes ?? MCP_ARCHIVE_BUDGET_BYTES,
  );
  const root = path.join(logDir, "mcp-proxy");
  const archives: Archive[] = [];
  const latestTargets = new Set<string>();
  const directories = new Map<string, Stats>();
  const report = (error: unknown, file: string) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    try {
      options.onError?.(error, file);
    } catch {
      // 清理及诊断失败均不能阻断启动/任务。
    }
  };
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop()!;
    try {
      const directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
        continue;
      directories.set(directory, directoryStat);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        try {
          const stat = await fs.lstat(file);
          if (stat.isSymbolicLink()) {
            // 只读链接文本，不访问目标；保留 latest 指向的历史归档。
            if (entry.name === "latest.log") {
              latestTargets.add(
                path.resolve(directory, await fs.readlink(file)),
              );
            }
            continue;
          }
          if (stat.isDirectory()) {
            pending.push(file);
            continue;
          }
          const date = archiveDate(entry.name);
          if (
            !stat.isFile() ||
            stat.nlink > 1 ||
            !date ||
            date >= today ||
            now - stat.mtimeMs <= graceMs
          )
            continue;
          archives.push({ file, stat });
        } catch (error) {
          report(error, file);
        }
      }
    } catch (error) {
      report(error, directory);
    }
  }

  const candidates = archives
    .filter(({ file }) => !latestTargets.has(file))
    .sort(
      (a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.file.localeCompare(b.file),
    );
  result.retainedArchiveBytes = candidates.reduce(
    (sum, archive) => sum + archive.stat.size,
    0,
  );
  for (const archive of candidates) {
    if (
      now - archive.stat.mtimeMs <= options.maxAgeMs &&
      result.retainedArchiveBytes <= budget
    )
      continue;
    try {
      // 扫描后目录被换成链接或文件仍在写入时，放弃本轮删除。
      let directory = path.dirname(archive.file);
      let unchanged = true;
      while (directories.has(directory)) {
        const stat = await fs.lstat(directory);
        const scanned = directories.get(directory)!;
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.dev !== scanned.dev ||
          stat.ino !== scanned.ino
        ) {
          unchanged = false;
          break;
        }
        directory = path.dirname(directory);
      }
      if (!unchanged) continue;
      const current = await fs.lstat(archive.file);
      if (
        !current.isFile() ||
        current.nlink > 1 ||
        !sameFile(archive.stat, current) ||
        now - current.mtimeMs <= graceMs
      )
        continue;
      await fs.unlink(archive.file);
      result.deletedFiles += 1;
      result.deletedBytes += archive.stat.size;
      result.retainedArchiveBytes -= archive.stat.size;
    } catch (error) {
      report(error, archive.file);
    }
  }
  return result;
}

/** 启动与小时调度共享同一进行中的 Promise，慢扫描不会重叠。 */
export function createMcpLogRetentionRunner(
  logDir: string,
  options: LogRetentionOptions,
): () => Promise<LogRetentionResult> {
  let inFlight: Promise<LogRetentionResult> | undefined;
  return () => {
    if (inFlight) return inFlight;
    inFlight = cleanupMcpArchiveLogs(logDir, options).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
