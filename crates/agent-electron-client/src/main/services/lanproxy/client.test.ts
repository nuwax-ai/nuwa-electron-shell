import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LanproxyClient, parseHostPort } from "./client";
import {
  FrameDecoder,
  MessageType,
  encodeMessage,
  type LanproxyMessage,
  type OutgoingMessage,
} from "./protocol";

const KEY = "testkey";
const FAST = { heartbeatIntervalMs: 60, reconnectDelayMs: 40 };

class TunnelConn {
  readonly frames: LanproxyMessage[] = [];
  closed = false;
  private readonly decoder = new FrameDecoder();
  private readonly watchers = new Set<() => void>();

  constructor(readonly socket: net.Socket) {
    socket.on("data", (chunk) => {
      this.frames.push(...this.decoder.push(chunk));
      this.watchers.forEach((w) => w());
    });
    socket.on("close", () => {
      this.closed = true;
      this.watchers.forEach((w) => w());
    });
    socket.on("error", () => {});
  }

  send(msg: OutgoingMessage): void {
    this.socket.write(encodeMessage(msg));
  }

  waitFor(
    pred: (m: LanproxyMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<LanproxyMessage> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const hit = this.frames.find(pred);
        if (hit) {
          this.watchers.delete(check);
          clearTimeout(timer);
          resolve(hit);
        }
      };
      const timer = setTimeout(() => {
        this.watchers.delete(check);
        reject(new Error("timed out waiting for frame"));
      }, timeoutMs);
      this.watchers.add(check);
      check();
    });
  }

  waitClosed(timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.closed) {
          this.watchers.delete(check);
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.watchers.delete(check);
        reject(new Error("timed out waiting for close"));
      }, timeoutMs);
      this.watchers.add(check);
      check();
    });
  }
}

class FakeTunnel {
  readonly conns: TunnelConn[] = [];
  private readonly waiting: Array<() => void> = [];
  server!: net.Server;
  port = 0;

  async listen(tlsOptions?: tls.TlsOptions): Promise<this> {
    const onConn = (socket: net.Socket) => {
      this.conns.push(new TunnelConn(socket));
      this.waiting.splice(0).forEach((w) => w());
    };
    this.server = tlsOptions
      ? tls.createServer(tlsOptions, onConn)
      : net.createServer(onConn);
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  /** 等到第 n 条（从 0 计）连接被接受 */
  async conn(n: number, timeoutMs = 2000): Promise<TunnelConn> {
    const deadline = Date.now() + timeoutMs;
    while (this.conns.length <= n) {
      if (Date.now() > deadline)
        throw new Error(`connection #${n} never arrived`);
      await new Promise<void>((r) => {
        this.waiting.push(r);
        setTimeout(r, 25);
      });
    }
    return this.conns[n];
  }

  close(): void {
    this.conns.forEach((c) => c.socket.destroy());
    this.server.close();
  }
}

/** 本地「真实服务」：回显，收到 "bye" 后主动关闭 */
async function startEcho(): Promise<{ port: number; server: net.Server }> {
  const server = net.createServer((s) => {
    s.on("data", (d) => {
      s.write(d);
      if (d.toString() === "bye") s.end();
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, server };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(
  clientOpts: Partial<ConstructorParameters<typeof LanproxyClient>[0]> = {},
  tunnelTls?: tls.TlsOptions,
) {
  const tunnel = await new FakeTunnel().listen(tunnelTls);
  const echo = await startEcho();
  const client = new LanproxyClient({
    serverHost: "127.0.0.1",
    serverPort: tunnel.port,
    clientKey: KEY,
    ...FAST,
    ...clientOpts,
  });
  cleanups.push(async () => {
    await client.stop();
    tunnel.close();
    echo.server.close();
  });
  return { tunnel, echo, client };
}

const connectMsg = (userId: string, port: number): OutgoingMessage => ({
  type: MessageType.CONNECT,
  uri: userId,
  data: Buffer.from(`127.0.0.1:${port}`),
});

describe("parseHostPort", () => {
  it("parses host:port and [ipv6]:port", () => {
    expect(parseHostPort("127.0.0.1:8080")).toEqual({
      host: "127.0.0.1",
      port: 8080,
    });
    expect(parseHostPort("localhost:1")).toEqual({
      host: "localhost",
      port: 1,
    });
    expect(parseHostPort("[::1]:443")).toEqual({ host: "::1", port: 443 });
  });

  it("rejects malformed targets", () => {
    for (const bad of [
      "",
      "nohost",
      "host:",
      "host:0",
      "host:65536",
      ":80",
      "a:b",
    ]) {
      expect(parseHostPort(bad)).toBeNull();
    }
  });
});

describe("LanproxyClient control connection", () => {
  it("sends AUTH with the client key as the first frame", async () => {
    const { tunnel, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    const auth = await control.waitFor((m) => m.type === MessageType.AUTH);
    expect(auth.uri).toBe(KEY);
    expect(control.frames[0].type).toBe(MessageType.AUTH);
  });

  it("sends heartbeats", async () => {
    const { tunnel, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    await control.waitFor((m) => m.type === MessageType.HEARTBEAT);
  });

  it("reconnects and re-authenticates after the server drops the control connection", async () => {
    const { tunnel, client } = await setup();
    client.start();
    const first = await tunnel.conn(0);
    await first.waitFor((m) => m.type === MessageType.AUTH);
    first.socket.destroy();
    const second = await tunnel.conn(1);
    const auth = await second.waitFor((m) => m.type === MessageType.AUTH);
    expect(auth.uri).toBe(KEY);
  });

  it("closes a control connection that stays silent for two heartbeat periods", async () => {
    const { tunnel, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    await control.waitClosed(1000);
    const again = await tunnel.conn(1);
    await again.waitFor((m) => m.type === MessageType.AUTH);
  });

  it("keeps the connection alive while the server keeps talking", async () => {
    const { tunnel, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    const ticker = setInterval(
      () => control.send({ type: MessageType.HEARTBEAT }),
      20,
    );
    cleanups.push(() => clearInterval(ticker));
    await new Promise((r) => setTimeout(r, 400));
    expect(control.closed).toBe(false);
  });

  it("retries when the tunnel server is not reachable yet", async () => {
    const probe = await new FakeTunnel().listen();
    const port = probe.port;
    probe.close();
    const client = new LanproxyClient({
      serverHost: "127.0.0.1",
      serverPort: port,
      clientKey: KEY,
      ...FAST,
    });
    cleanups.push(() => client.stop());
    client.start();
    await new Promise((r) => setTimeout(r, 150));
    const tunnel = new FakeTunnel();
    tunnel.server = net.createServer((s) =>
      tunnel.conns.push(new TunnelConn(s)),
    );
    await new Promise<void>((r) => tunnel.server.listen(port, "127.0.0.1", r));
    cleanups.push(() => tunnel.close());
    const control = await tunnel.conn(0, 3000);
    await control.waitFor((m) => m.type === MessageType.AUTH);
  });

  it("stop() tears everything down and does not reconnect", async () => {
    const { tunnel, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    await control.waitFor((m) => m.type === MessageType.AUTH);
    await client.stop();
    await control.waitClosed();
    await new Promise((r) => setTimeout(r, 150));
    expect(tunnel.conns.length).toBe(1);
  });
});

describe("LanproxyClient sessions", () => {
  it("binds a session on a new data connection and relays both directions", async () => {
    const { tunnel, echo, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    control.send(connectMsg("user1", echo.port));

    const data = await tunnel.conn(1);
    const bind = await data.waitFor((m) => m.type === MessageType.CONNECT);
    expect(bind.uri).toBe(`user1@${KEY}`);
    // 数据连接不发 AUTH
    expect(data.frames.some((m) => m.type === MessageType.AUTH)).toBe(false);

    data.send({ type: MessageType.TRANSFER, data: Buffer.from("hello") });
    const echoed = await data.waitFor((m) => m.type === MessageType.TRANSFER);
    expect(echoed.data.toString()).toBe("hello");
  });

  it("reuses the pooled data connection for the next session", async () => {
    const { tunnel, echo, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    control.send(connectMsg("user1", echo.port));
    const data = await tunnel.conn(1);
    await data.waitFor((m) => m.uri === `user1@${KEY}`);

    data.send({ type: MessageType.DISCONNECT, uri: "user1" });
    await new Promise((r) => setTimeout(r, 40));
    control.send(connectMsg("user2", echo.port));
    await data.waitFor((m) => m.uri === `user2@${KEY}`);
    expect(tunnel.conns.length).toBe(2);
    expect(data.closed).toBe(false);
  });

  it("opens a fresh data connection per session when the pool is disabled", async () => {
    const { tunnel, echo, client } = await setup({ poolSize: 0 });
    client.start();
    const control = await tunnel.conn(0);
    control.send(connectMsg("user1", echo.port));
    const first = await tunnel.conn(1);
    await first.waitFor((m) => m.uri === `user1@${KEY}`);

    first.send({ type: MessageType.DISCONNECT, uri: "user1" });
    await first.waitClosed();
    control.send(connectMsg("user2", echo.port));
    const second = await tunnel.conn(2);
    await second.waitFor((m) => m.uri === `user2@${KEY}`);
  });

  it("answers DISCONNECT on the control connection when the target is unreachable", async () => {
    const { tunnel, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    control.send({
      type: MessageType.CONNECT,
      uri: "user3",
      data: Buffer.from("127.0.0.1:1"),
    });
    const msg = await control.waitFor((m) => m.type === MessageType.DISCONNECT);
    expect(msg.uri).toBe("user3");
    expect(tunnel.conns.length).toBe(1);
  });

  it("answers DISCONNECT when the target address is malformed", async () => {
    const { tunnel, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    control.send({
      type: MessageType.CONNECT,
      uri: "user4",
      data: Buffer.from("garbage"),
    });
    const msg = await control.waitFor((m) => m.type === MessageType.DISCONNECT);
    expect(msg.uri).toBe("user4");
  });

  it("tells the server and closes the data connection when the local service closes first", async () => {
    const { tunnel, echo, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    control.send(connectMsg("user2", echo.port));
    const data = await tunnel.conn(1);
    await data.waitFor((m) => m.uri === `user2@${KEY}`);

    data.send({ type: MessageType.TRANSFER, data: Buffer.from("bye") });
    const disc = await data.waitFor((m) => m.type === MessageType.DISCONNECT);
    expect(disc.uri).toBe("user2");
    await data.waitClosed();
  });

  it("closes the local service when the server ends the session", async () => {
    const { tunnel, client } = await setup();
    let serverSide: net.Socket | null = null;
    const closed = new Promise<void>((resolve) => {
      const local = net.createServer((s) => {
        serverSide = s;
        s.on("close", () => resolve());
        s.on("error", () => {});
      });
      local.listen(0, "127.0.0.1", () => {
        const port = (local.address() as net.AddressInfo).port;
        cleanups.push(() => local.close());
        client.start();
        void (async () => {
          const control = await tunnel.conn(0);
          control.send(connectMsg("u", port));
          const data = await tunnel.conn(1);
          await data.waitFor((m) => m.uri === `u@${KEY}`);
          data.send({ type: MessageType.DISCONNECT, uri: "u" });
        })();
      });
    });
    await closed;
    expect(serverSide).not.toBeNull();
  });

  it("relays a large payload in both directions without loss", async () => {
    const { tunnel, echo, client } = await setup();
    client.start();
    const control = await tunnel.conn(0);
    control.send(connectMsg("big", echo.port));
    const data = await tunnel.conn(1);
    await data.waitFor((m) => m.uri === `big@${KEY}`);

    const total = 6 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 7);
    for (let sent = 0; sent < total; sent += chunk.length) {
      data.send({ type: MessageType.TRANSFER, data: chunk });
    }
    const received = () =>
      data.frames
        .filter((m) => m.type === MessageType.TRANSFER)
        .reduce((n, m) => n + m.data.length, 0);
    const deadline = Date.now() + 8000;
    while (received() < total && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(received()).toBe(total);
  });
});

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)("LanproxyClient TLS", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanproxy-tls-"));
  const keyFile = path.join(dir, "k.pem");
  const certFile = path.join(dir, "c.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const tlsOptions = {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
  };

  it("connects to a self-signed server when no CA is given (verification skipped, as in the Go client)", async () => {
    const { tunnel, client } = await setup({ ssl: true }, tlsOptions);
    client.start();
    const control = await tunnel.conn(0);
    await control.waitFor((m) => m.type === MessageType.AUTH);
  });

  it("verifies the server certificate when a CA is given", async () => {
    const { tunnel, client } = await setup(
      { ssl: true, caPem: fs.readFileSync(certFile) },
      tlsOptions,
    );
    client.start();
    const control = await tunnel.conn(0);
    await control.waitFor((m) => m.type === MessageType.AUTH);
  });

  it("refuses a server whose certificate is not signed by the given CA", async () => {
    const otherCert = path.join(dir, "other.pem");
    const otherKey = path.join(dir, "other-k.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        otherKey,
        "-out",
        otherCert,
        "-days",
        "2",
        "-subj",
        "/CN=other",
      ],
      { stdio: "ignore" },
    );
    const { tunnel, client } = await setup(
      { ssl: true, caPem: fs.readFileSync(otherCert) },
      tlsOptions,
    );
    client.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(
      tunnel.conns.every(
        (c) => !c.frames.some((m) => m.type === MessageType.AUTH),
      ),
    ).toBe(true);
  });
});
