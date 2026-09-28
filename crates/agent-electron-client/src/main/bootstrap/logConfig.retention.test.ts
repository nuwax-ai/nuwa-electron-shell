import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  home: "",
  on: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => mocks.home, isPackaged: false, on: mocks.on },
}));
vi.mock("electron-log", () => ({
  default: {
    info: mocks.info,
    warn: mocks.warn,
    transports: { file: {}, console: { writeFn: vi.fn() } },
    create: () => ({ transports: { file: {}, console: {} } }),
  },
}));

import { APP_DATA_DIR_NAME, LOGS_DIR_NAME } from "../services/constants";
import { initLogging } from "./logConfig";

const localDate = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
const day = 24 * 60 * 60 * 1000;
const waitForDeleted = async (file: string) => {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await fs.readdir(path.dirname(file))).not.toContain(
    path.basename(file),
  );
};

describe("logConfig MCP 真实目录接线", () => {
  let logDir: string;
  let hourly: (() => void) | undefined;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.home = await fs.mkdtemp(path.join(os.tmpdir(), "nuwax-log-config-"));
    logDir = path.join(mocks.home, APP_DATA_DIR_NAME, LOGS_DIR_NAME);
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(
      path.join(logDir, `main.${localDate(new Date())}.log`),
      "active",
    );
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
      hourly = callback as () => void;
      return {} as ReturnType<typeof setInterval>;
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(mocks.home, { recursive: true, force: true });
  });

  it("启动及现有每小时清理覆盖已停止项目，并保护活跃日志和任务文件", async () => {
    const stoppedDir = path.join(logDir, "mcp-proxy", "stopped-project");
    await fs.mkdir(stoppedDir, { recursive: true });
    const oldDate = new Date(Date.now() - 40 * day);
    const expired = path.join(stoppedDir, `server-${localDate(oldDate)}.log`);
    const active = path.join(stoppedDir, `server-${localDate(new Date())}.log`);
    const recentlyWritten = path.join(
      stoppedDir,
      `other-${localDate(oldDate)}.log`,
    );
    const taskFile = path.join(stoppedDir, "task.json");
    await Promise.all([
      fs.writeFile(expired, "old"),
      fs.writeFile(active, "active"),
      fs.writeFile(recentlyWritten, "still being written"),
      fs.writeFile(taskFile, "task"),
    ]);
    await fs.utimes(expired, oldDate, oldDate);
    await fs.utimes(active, oldDate, oldDate);
    await fs.symlink(
      path.basename(active),
      path.join(stoppedDir, "latest.log"),
    );
    initLogging();
    await waitForDeleted(expired);
    expect(await fs.readFile(active, "utf8")).toBe("active");
    expect(await fs.readFile(recentlyWritten, "utf8")).toBe(
      "still being written",
    );
    expect(await fs.readFile(taskFile, "utf8")).toBe("task");
    expect(await fs.readlink(path.join(stoppedDir, "latest.log"))).toBe(
      path.basename(active),
    );

    const nextExpired = path.join(
      stoppedDir,
      `hourly-${localDate(oldDate)}.log`,
    );
    await fs.writeFile(nextExpired, "old hourly");
    await fs.utimes(nextExpired, oldDate, oldDate);
    expect(hourly).toBeTypeOf("function");
    hourly!();
    await waitForDeleted(nextExpired);
  });
});
