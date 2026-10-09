/**
 * lanproxy 客户端（TS 实现，行为对齐 ffay/lanproxy-go-client）。
 *
 * 连接模型：
 * - 控制连接：连上后发 AUTH(uri=clientKey)；服务端经它下发 CONNECT(uri=userId, data=host:port)。
 * - 数据连接：每个用户会话占用一条到隧道服务器的连接，发 CONNECT(uri=userId@clientKey) 绑定；
 *   会话结束（服务端 DISCONNECT）后回池复用，池上限 poolSize。
 * - 每条连接 heartbeatIntervalMs 发一次心跳；连续 2 个周期无任何读视为超时并断开。
 * - 控制连接断开后等 reconnectDelayMs 再重连；拨号失败同样按该间隔重试。
 *
 * 与 Go 版的差异（均不改变线上字节）：
 * - 本地真实服务先断时：发 DISCONNECT 后关闭该数据连接（Go 版会让它泄漏为不入池的常驻连接）。
 * - 双向转发带背压；真实服务在绑定前不读取，避免绑定前到达的数据被丢弃。
 * - 拨号带超时（Go 版依赖系统默认）。
 */

import net from "node:net";
import tls from "node:tls";
import {
  FrameDecoder,
  MessageType,
  ProtocolError,
  encodeMessage,
  type LanproxyMessage,
  type OutgoingMessage,
} from "./protocol";

export interface LanproxyLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LanproxyClientOptions {
  serverHost: string;
  serverPort: number;
  clientKey: string;
  ssl?: boolean;
  /**
   * 校验服务端证书所用 CA（PEM）。ssl 开启且未提供时跳过证书校验，
   * 与 lanproxy-go-client 默认行为一致。
   */
  caPem?: string | Buffer;
  /** 数据连接池上限，0 表示不复用（每个会话新建连接）。默认 100。 */
  poolSize?: number;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  /** 拨号（隧道服务器与本地真实服务）超时。默认 15s。 */
  dialTimeoutMs?: number;
  logger?: LanproxyLogger;
}

type ConnKind = "control" | "data";

interface ProxyConn {
  kind: ConnKind;
  socket: net.Socket;
  decoder: FrameDecoder;
  lastReadAt: number;
  active: boolean;
  /** 已绑定的本地真实服务连接 */
  peer: net.Socket | null;
  heartbeat: NodeJS.Timeout | null;
}

const NOOP_LOGGER: LanproxyLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function maskKey(key: string): string {
  return key.length <= 4 ? "****" : `${key.slice(0, 4)}****(${key.length})`;
}

/** 解析 `host:port` / `[ipv6]:port`。 */
export function parseHostPort(
  addr: string,
): { host: string; port: number } | null {
  const m =
    /^\[([^\]]+)\]:(\d{1,5})$/.exec(addr) ??
    /^([^:[\]]+):(\d{1,5})$/.exec(addr);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

export class LanproxyClient {
  private readonly log: LanproxyLogger;
  private readonly poolSize: number;
  private readonly heartbeatMs: number;
  private readonly reconnectMs: number;
  private readonly dialTimeoutMs: number;

  private stopped = true;
  private loop: Promise<void> | null = null;
  private cancelSleep: (() => void) | null = null;
  private control: ProxyConn | null = null;
  private readonly idle: ProxyConn[] = [];
  private readonly conns = new Set<ProxyConn>();
  private readonly reals = new Set<net.Socket>();
  private warnedInsecureTls = false;

  constructor(private readonly opts: LanproxyClientOptions) {
    this.log = opts.logger ?? NOOP_LOGGER;
    this.poolSize = opts.poolSize ?? 100;
    this.heartbeatMs = opts.heartbeatIntervalMs ?? 30_000;
    this.reconnectMs = opts.reconnectDelayMs ?? 3_000;
    this.dialTimeoutMs = opts.dialTimeoutMs ?? 15_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log.info(
      `Starting lanproxy client: server=${this.opts.serverHost}:${this.opts.serverPort} ssl=${!!this.opts.ssl} key=${maskKey(this.opts.clientKey)}`,
    );
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelSleep?.();
    for (const conn of [...this.conns]) this.destroyConn(conn);
    for (const real of [...this.reals]) real.destroy();
    this.idle.length = 0;
    await this.loop;
    this.loop = null;
    this.log.info("Lanproxy client stopped");
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let conn: ProxyConn;
      try {
        conn = await this.dialServer("control");
      } catch (err) {
        this.log.warn(`Dial tunnel server failed: ${errMessage(err)}`);
        await this.sleep(this.reconnectMs);
        continue;
      }
      if (this.stopped) {
        this.destroyConn(conn);
        break;
      }
      this.control = conn;
      this.log.info("Control connection established");
      this.send(conn, { type: MessageType.AUTH, uri: this.opts.clientKey });
      await new Promise<void>((resolve) => {
        if (conn.socket.destroyed) resolve();
        else conn.socket.once("close", () => resolve());
      });
      this.control = null;
      if (!this.stopped) {
        this.log.warn("Control connection closed, reconnecting");
        await this.sleep(this.reconnectMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cancelSleep = null;
        resolve();
      }, ms);
      this.cancelSleep = () => {
        clearTimeout(timer);
        this.cancelSleep = null;
        resolve();
      };
    });
  }

  private dialServer(kind: ConnKind): Promise<ProxyConn> {
    const { serverHost: host, serverPort: port, ssl, caPem } = this.opts;
    return new Promise((resolve, reject) => {
      let socket: net.Socket;
      if (ssl) {
        if (!caPem && !this.warnedInsecureTls) {
          this.warnedInsecureTls = true;
          this.log.warn(
            "TLS certificate verification is disabled (no CA provided)",
          );
        }
        socket = tls.connect({
          host,
          port,
          ca: caPem,
          rejectUnauthorized: Boolean(caPem),
          servername: net.isIP(host) ? undefined : host,
        });
      } else {
        socket = net.connect({ host, port });
      }
      const onError = (err: Error) => reject(err);
      socket.once("error", onError);
      socket.setTimeout(this.dialTimeoutMs, () =>
        socket.destroy(new Error("dial timeout")),
      );
      socket.once(ssl ? "secureConnect" : "connect", () => {
        socket.off("error", onError);
        socket.setTimeout(0);
        resolve(this.adopt(socket, kind));
      });
    });
  }

  private adopt(socket: net.Socket, kind: ConnKind): ProxyConn {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
    const conn: ProxyConn = {
      kind,
      socket,
      decoder: new FrameDecoder(),
      lastReadAt: Date.now(),
      active: true,
      peer: null,
      heartbeat: null,
    };
    this.conns.add(conn);

    socket.on("data", (chunk: Buffer) => {
      conn.lastReadAt = Date.now();
      try {
        for (const msg of conn.decoder.push(chunk)) this.onMessage(conn, msg);
      } catch (err) {
        if (err instanceof ProtocolError) {
          this.log.error(
            `Protocol error on ${kind} connection: ${err.message}`,
          );
          socket.destroy();
        } else {
          throw err;
        }
      }
    });
    socket.on("error", (err) => {
      this.log.warn(`${kind} connection error: ${errMessage(err)}`);
    });
    socket.once("close", () => {
      conn.active = false;
      if (conn.heartbeat) clearInterval(conn.heartbeat);
      conn.heartbeat = null;
      this.conns.delete(conn);
      const at = this.idle.indexOf(conn);
      if (at >= 0) this.idle.splice(at, 1);
      const peer = conn.peer;
      conn.peer = null;
      peer?.destroy();
    });

    conn.heartbeat = setInterval(() => {
      if (
        !socket.isPaused() &&
        Date.now() - conn.lastReadAt >= 2 * this.heartbeatMs
      ) {
        this.log.warn(`${kind} connection timed out, closing`);
        socket.destroy();
        return;
      }
      this.send(conn, { type: MessageType.HEARTBEAT });
    }, this.heartbeatMs);
    return conn;
  }

  private send(conn: ProxyConn, msg: OutgoingMessage): boolean {
    if (!conn.active || conn.socket.destroyed) return true;
    try {
      return conn.socket.write(encodeMessage(msg));
    } catch (err) {
      this.log.error(`Encode failed: ${errMessage(err)}`);
      conn.socket.destroy();
      return true;
    }
  }

  private onMessage(conn: ProxyConn, msg: LanproxyMessage): void {
    if (conn.kind === "control") {
      if (msg.type === MessageType.CONNECT) {
        this.handleConnect(msg.uri, msg.data.toString("utf8"));
      }
      return;
    }
    if (msg.type === MessageType.TRANSFER) {
      const peer = conn.peer;
      if (peer && !peer.write(msg.data)) {
        conn.socket.pause();
        peer.once("drain", () => conn.socket.resume());
      }
    } else if (msg.type === MessageType.DISCONNECT) {
      this.releaseData(conn);
    }
  }

  private handleConnect(userId: string, addr: string): void {
    this.log.info(`Connect request: user=${userId} target=${addr}`);
    const target = parseHostPort(addr);
    if (!target) {
      this.log.warn(`Invalid connect target: ${addr}`);
      this.notifyDisconnect(userId);
      return;
    }

    const real = net.connect({ host: target.host, port: target.port });
    this.reals.add(real);
    real.setNoDelay(true);
    real.setTimeout(this.dialTimeoutMs, () =>
      real.destroy(new Error("dial timeout")),
    );
    let connected = false;
    real.on("error", (err) => {
      if (!connected) {
        this.log.warn(`Connect real server failed: ${errMessage(err)}`);
        this.notifyDisconnect(userId);
      }
    });
    real.once("close", () => this.reals.delete(real));
    real.once("connect", () => {
      connected = true;
      real.setTimeout(0);
      void this.bindSession(userId, real);
    });
  }

  private async bindSession(userId: string, real: net.Socket): Promise<void> {
    let data: ProxyConn;
    try {
      data = await this.acquireData();
    } catch (err) {
      this.log.warn(`Acquire proxy connection failed: ${errMessage(err)}`);
      this.notifyDisconnect(userId);
      real.destroy();
      return;
    }
    if (real.destroyed || this.stopped) {
      this.recycle(data);
      if (!this.stopped) this.notifyDisconnect(userId);
      return;
    }

    data.peer = real;
    this.send(data, {
      type: MessageType.CONNECT,
      uri: `${userId}@${this.opts.clientKey}`,
    });
    real.on("data", (chunk: Buffer) => {
      if (!this.send(data, { type: MessageType.TRANSFER, data: chunk })) {
        real.pause();
        data.socket.once("drain", () => real.resume());
      }
    });
    real.once("close", () => {
      if (data.peer !== real) return;
      data.peer = null;
      this.send(data, { type: MessageType.DISCONNECT, uri: userId });
      this.closeGracefully(data);
    });
  }

  private notifyDisconnect(userId: string): void {
    if (this.control) {
      this.send(this.control, { type: MessageType.DISCONNECT, uri: userId });
    }
  }

  private async acquireData(): Promise<ProxyConn> {
    while (this.idle.length > 0) {
      const conn = this.idle.pop()!;
      if (conn.active && !conn.socket.destroyed) return conn;
    }
    return this.dialServer("data");
  }

  private releaseData(conn: ProxyConn): void {
    const peer = conn.peer;
    conn.peer = null;
    peer?.destroy();
    conn.socket.resume();
    this.recycle(conn);
  }

  private recycle(conn: ProxyConn): void {
    if (!conn.active || conn.socket.destroyed) return;
    if (this.stopped || this.idle.length >= this.poolSize) {
      this.destroyConn(conn);
      return;
    }
    this.idle.push(conn);
  }

  private closeGracefully(conn: ProxyConn): void {
    conn.active = false;
    conn.socket.end();
    const timer = setTimeout(() => conn.socket.destroy(), 2_000);
    timer.unref();
    conn.socket.once("close", () => clearTimeout(timer));
  }

  private destroyConn(conn: ProxyConn): void {
    conn.active = false;
    conn.socket.destroy();
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
