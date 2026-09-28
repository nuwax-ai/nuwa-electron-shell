import * as http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import log from "electron-log";

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../bootstrap/logConfig", () => ({
  getPerfLogger: () => ({ info: vi.fn() }),
}));
vi.mock("../engines/perf/firstTokenTrace", () => ({
  firstTokenTrace: { trace: vi.fn() },
}));

import {
  closeAndClearAllSseClients,
  closeSseClientsForSession,
  getSseClientBackpressure,
  getSseEventBufferSize,
  pushSseEvent,
  registerSseClient,
  replayBufferedEvents,
  sseClients,
  unregisterSseClient,
  writeSseHeartbeat,
} from "./sseManager";

const frame = (eventName: string, data: unknown) =>
  `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
const heartbeat = frame("ping", { type: "heartbeat" });
const fixtures: Array<{
  server: http.Server;
  request: http.ClientRequest;
  reader: http.IncomingMessage;
}> = [];

// 使用真实 ServerResponse/Socket，客户端暂停读取，不启动产品服务或引擎。
async function connect(sessionId: string) {
  let resolveResponse!: (res: http.ServerResponse) => void;
  const responseReady = new Promise<http.ServerResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const server = http.createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    registerSseClient(sessionId, res);
    resolveResponse(res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  const request = http.get(`http://127.0.0.1:${address.port}`);
  const [reader] = (await once(request, "response")) as [http.IncomingMessage];
  reader.pause();
  const res = await responseReady;
  fixtures.push({ server, request, reader });
  return { res, reader };
}

function readAll(reader: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    reader.on("data", (chunk: Buffer) => chunks.push(chunk));
    reader.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    reader.once("error", reject);
    reader.resume();
  });
}

beforeEach(() => {
  closeAndClearAllSseClients();
  vi.clearAllMocks();
});
afterEach(async () => {
  closeAndClearAllSseClients();
  await Promise.all(
    fixtures.splice(0).map(({ server, request, reader }) => {
      request.destroy();
      reader.destroy();
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe("SSE backpressure observation without dropping business events", () => {
  it("keeps normal events and heartbeat wire payloads unchanged", async () => {
    const sessionId = "normal";
    const { res, reader } = await connect(sessionId);
    pushSseEvent(sessionId, "prompt_start", { order: 0 });
    expect(writeSseHeartbeat(sessionId, res, heartbeat)).toBe(true);
    pushSseEvent(sessionId, "end_turn", { order: 1 });
    expect(getSseClientBackpressure(res)?.blocked).toBe(false);
    const received = readAll(reader);
    res.end();
    expect(await received).toBe(
      frame("prompt_start", { order: 0 }) +
        heartbeat +
        frame("end_turn", { order: 1 }),
    );
    expect(getSseEventBufferSize(sessionId)).toBe(0);
  });

  it("suppresses only redundant pings until drain and delivers every buffered business event in order", async () => {
    const sessionId = "slow";
    const { res, reader } = await connect(sessionId);
    const chunks = Array.from({ length: 8 }, (_, order) => ({
      order,
      content: "x".repeat(128_000),
    }));
    chunks.forEach((data) => pushSseEvent(sessionId, "tool_call_update", data));
    const blocked = getSseClientBackpressure(res)!;
    expect(blocked.blocked).toBe(true);
    expect(blocked.writableBytes).toBe(res.writableLength);
    expect(blocked.peakWritableBytes).toBeGreaterThan(1_024_000);
    expect(blocked.backpressureEpisodes).toBe(1);
    const bytesBeforeHeartbeat = res.writableLength;
    expect(writeSseHeartbeat(sessionId, res, heartbeat)).toBe(false);
    expect(writeSseHeartbeat(sessionId, res, heartbeat)).toBe(false);
    expect(res.writableLength).toBe(bytesBeforeHeartbeat);
    expect(getSseClientBackpressure(res)?.skippedHeartbeats).toBe(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(res.destroyed).toBe(false);
    expect(res.writableEnded).toBe(false);

    const drained = once(res, "drain");
    const received = readAll(reader);
    await drained;
    expect(getSseClientBackpressure(res)?.blocked).toBe(false);
    expect(writeSseHeartbeat(sessionId, res, heartbeat)).toBe(true);
    pushSseEvent(sessionId, "end_turn", { order: 8 });
    res.end();
    const expected =
      chunks.map((data) => frame("tool_call_update", data)).join("") +
      heartbeat +
      frame("end_turn", { order: 8 });
    // 避免失败时打印整 MB 输出；逐字节比较完整 wire 顺序与内容。
    expect((await received) === expected).toBe(true);
    expect(getSseEventBufferSize(sessionId)).toBe(0);
  });

  it("observes replay backpressure while retaining the existing offline buffer contract", async () => {
    const sessionId = "replay";
    const data = { content: "y".repeat(128_000) };
    pushSseEvent(sessionId, "prompt_start", data);
    const { res, reader } = await connect(sessionId);
    expect(replayBufferedEvents(sessionId, res)).toBe(1);
    expect(getSseClientBackpressure(res)?.blocked).toBe(true);
    expect(writeSseHeartbeat(sessionId, res, heartbeat)).toBe(false);
    expect(getSseEventBufferSize(sessionId)).toBe(1);
    const received = readAll(reader);
    res.end();
    expect((await received) === frame("prompt_start", data)).toBe(true);
  });

  it.each(["unregister", "session-close", "service-close"])(
    "removes observation listeners and state on %s",
    async (method) => {
      const { res } = await connect("cleanup");
      expect(res.listenerCount("drain")).toBe(1);
      expect(res.listenerCount("close")).toBe(1);
      expect(res.listenerCount("error")).toBe(1);
      if (method === "unregister") unregisterSseClient("cleanup", res);
      if (method === "session-close") closeSseClientsForSession("cleanup");
      if (method === "service-close") closeAndClearAllSseClients();
      expect(getSseClientBackpressure(res)).toBeNull();
      expect(res.listenerCount("drain")).toBe(0);
      expect(res.listenerCount("close")).toBe(0);
      expect(res.listenerCount("error")).toBe(0);
      expect(sseClients.has("cleanup")).toBe(false);
      expect(writeSseHeartbeat("cleanup", res, heartbeat)).toBe(false);
    },
  );

  it("forgets a peer that disconnects without an explicit unregister", async () => {
    const { res, reader } = await connect("peer-close");
    const closed = once(res, "close");
    reader.destroy();
    await closed;
    expect(getSseClientBackpressure(res)).toBeNull();
    expect(sseClients.has("peer-close")).toBe(false);
  });

  it("reports unavailable writable byte counters honestly for response stubs", () => {
    const res = {
      write: vi.fn(() => false),
      end: vi.fn(),
    } as unknown as http.ServerResponse;
    registerSseClient("stub", res);
    pushSseEvent("stub", "tool_call_update", { order: 0 });
    expect(getSseClientBackpressure(res)).toMatchObject({
      blocked: true,
      writableBytes: null,
      peakWritableBytes: null,
    });
  });
});
