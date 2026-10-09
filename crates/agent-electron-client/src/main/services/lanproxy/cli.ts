/**
 * lanproxy 客户端进程入口。由主进程以 `process.execPath` + ELECTRON_RUN_AS_NODE=1 拉起，
 * 构建期 esbuild 打成单文件 resources/lanproxy/bin/lanproxy-client.js。
 */

import fs from "node:fs";
import { LanproxyClient, type LanproxyLogger } from "./client";
import { parseArgs } from "./cliArgs";

const PARENT_POLL_MS = 5_000;

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function createLogger(logFile?: string): LanproxyLogger {
  const file = logFile
    ? fs.createWriteStream(logFile, { flags: "a", mode: 0o600 })
    : null;
  const emit = (stream: NodeJS.WriteStream, level: string, message: string) => {
    const line = `${timestamp()} [${level}] ${message}\n`;
    if (file) file.write(line);
    else stream.write(line);
  };
  return {
    info: (m) => emit(process.stdout, "info", m),
    warn: (m) => emit(process.stderr, "warn", m),
    error: (m) => emit(process.stderr, "error", m),
  };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    process.stderr.write(`${timestamp()} [error] ${parsed.error}\n`);
    process.exit(2);
  }
  const { options } = parsed;
  const logger = createLogger(options.logFile);

  let caPem: Buffer | undefined;
  if (options.cer) {
    try {
      caPem = fs.readFileSync(options.cer);
    } catch (err) {
      logger.error(`Cannot read certificate file: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const client = new LanproxyClient({
    serverHost: options.server,
    serverPort: options.port,
    clientKey: options.key,
    ssl: options.ssl,
    caPem,
    poolSize: options.poolSize,
    logger,
  });
  client.start();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void client.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 父进程（Electron 主进程）异常退出时不留下常驻隧道
  const parentPid = process.ppid;
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      logger.warn("Parent process is gone, shutting down");
      shutdown();
    }
  }, PARENT_POLL_MS).unref();
}

main();
