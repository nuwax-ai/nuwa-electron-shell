import { afterEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import { LocalPortManager } from "./localPorts";

const managers: LocalPortManager[] = [];
const servers: net.Server[] = [];
function manager(options: ConstructorParameters<typeof LocalPortManager>[0]) {
  const value = new LocalPortManager(options); managers.push(value); return value;
}
function unavailable(code = "EADDRINUSE"): never { throw Object.assign(new Error(code), { code }); }
const reservation = () => ({ close: vi.fn(async () => {}) });
afterEach(async () => {
  for (const value of managers.splice(0)) await value.dispose();
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
});

describe("automatic local ports", () => {
  it("serializes concurrent service reservations and skips bound and excluded ports", async () => {
    const bind = vi.fn(async (port: number) => port === 24600 ? unavailable("EACCES") : reservation());
    const ports = manager({ ranges: [[24600, 24603]], bind });
    expect(await Promise.all([ports.reserve("agent"), ports.reserve("fileServer"), ports.reserve("ttyd")]))
      .toEqual([24601, 24602, 24603]);
    expect(ports.snapshot().every((value) => value.host === "127.0.0.1" && value.status === "reserved")).toBe(true);
    await expect(ports.reserve("gateway")).rejects.toThrow("No available local port");
  });

  it("falls back outside an entirely unavailable preferred pool without revisiting candidates", async () => {
    const bind = vi.fn(async (port: number) => port >= 24600 ? unavailable() : reservation());
    const ports = manager({ ranges: [[24600, 24999], [20000, 29999]], bind });
    expect(await ports.reserve("agent")).toBe(20000);
    expect(bind).toHaveBeenCalledTimes(401);
  });

  it("reselects after a reservation-to-service handoff race and persists only a healthy endpoint", async () => {
    const persist = vi.fn();
    const ports = manager({ ranges: [[24600, 24603]], bind: async () => reservation(), persist });
    const first = await ports.reserve("fileServer");
    const generation = ports.generation;
    const start = vi.fn(async (port: number) => port === first
      ? { success: false, errorCode: "EADDRINUSE" }
      : { success: true });
    expect(await ports.start("fileServer", start, async () => {})).toEqual({ success: true });
    expect(ports.get("fileServer")).toMatchObject({ port: first + 1, status: "ready" });
    expect(ports.generation).toBeGreaterThan(generation);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ fileServer: first + 1 });
  });

  it("does not switch ports for a missing binary or an unhealthy service on a free port", async () => {
    const ports = manager({ ranges: [[24600, 24603]], bind: async () => reservation() });
    const start = vi.fn(async () => ({ success: false, error: "Executable not found", errorCode: "ENOENT" }));
    const result = await ports.start("fileServer", start, async () => {});
    expect(result.success).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not spawn a replacement when the owned child could not be stopped", async () => {
    const ports = manager({ ranges: [[24600, 24603]], bind: async () => reservation() });
    const start = vi.fn(async () => ({ success: false, errorCode: "EADDRINUSE" }));
    const result = await ports.start("fileServer", start, async () => ({ success: false, message: "still alive" }));
    expect(result.success).toBe(false);
    expect(result.error).toContain("cleanup failed");
    expect(ports.get("fileServer")?.status).toBe("failed");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("preserves spawn permission errors without selecting another port", async () => {
    const bind = vi.fn(async () => reservation());
    const ports = manager({ ranges: [[24600, 24605]], bind });
    const error = { success: false, error: "spawn ttyd EACCES", errorCode: "EACCES", errorStage: "spawn" as const };
    const start = vi.fn(async () => error);
    expect(await ports.start("ttydInternal", start, async () => {})).toEqual(error);
    expect(start).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("still reselects when a listener rejects a reserved port with EACCES", async () => {
    const ports = manager({ ranges: [[24600, 24605]], bind: async () => reservation() });
    const start = vi.fn(async (port: number) => port === 24600
      ? { success: false, errorCode: "EACCES" }
      : { success: true });
    expect((await ports.start("fileServer", start, async () => {})).success).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
    expect(ports.get("fileServer")?.port).toBe(24601);
  });

  it("identifies a native bind race even when the child did not preserve the OS code", async () => {
    let calls = 0;
    const bind = vi.fn(async (port: number) => {
      if (port === 24600 && ++calls > 1) unavailable();
      return reservation();
    });
    const ports = manager({ ranges: [[24600, 24602]], bind });
    const result = await ports.start("ttydInternal", async (port) => ({ success: port !== 24600, error: "Child exited" }), async () => {});
    expect(result.success).toBe(true);
    expect(ports.get("ttydInternal")?.port).toBe(24601);
  });

  it("deduplicates starts and keeps a healthy service's port stable", async () => {
    const ports = manager({ ranges: [[24600, 24602]], bind: async () => reservation() });
    let complete!: () => void;
    const started = new Promise<void>((resolve) => { complete = resolve; });
    const start = vi.fn(async () => { await started; return { success: true }; });
    const first = ports.start("agent", start, async () => {});
    const second = ports.start("agent", start, async () => {});
    expect(first).toBe(second);
    complete();
    await first;
    expect(start).toHaveBeenCalledTimes(1);
    const generation = ports.generation;
    expect(await ports.reserve("agent")).toBe(24600);
    expect(ports.generation).toBe(generation);
  });

  it("cancels a late start on logout, cleans it up, and keeps the page gateway reservation", async () => {
    const persist = vi.fn();
    const ports = manager({ ranges: [[24600, 24605]], bind: async () => reservation(), persist });
    await ports.reserve("gateway");
    let complete!: () => void;
    const wait = new Promise<void>((resolve) => { complete = resolve; });
    const stop = vi.fn(async () => {});
    const result = ports.start("fileServer", async () => { await wait; return { success: true }; }, stop);
    await vi.waitFor(() => expect(ports.get("fileServer")?.status).toBe("starting"));
    ports.invalidateBusiness();
    complete();
    expect((await result).success).toBe(false);
    expect(stop).toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(ports.get("gateway")?.status).toBe("reserved");
  });

  it("keeps a multi-step single-service operation in its original login generation", async () => {
    const ports = manager({ ranges: [[24600, 24605]], bind: async () => reservation() });
    let controller = new AbortController();
    ports.setOperationSignalProvider(() => controller.signal);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const launch = vi.fn(async () => ({ success: true }));
    const pending = ports.runScoped(async () => { await paused; return ports.start("fileServer", launch, async () => {}); });
    controller.abort(); ports.invalidateBusiness(); controller = new AbortController();
    resume();
    expect((await pending).success).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it("only reuses validated saved ports in the product range", async () => {
    const bind = vi.fn(async () => reservation());
    const ports = manager({ ranges: [[24600, 24605], [20000, 29999]], saved: { agent: 61006, fileServer: 24500 }, bind });
    expect(await ports.reserve("agent")).toBe(24600);
    expect(await ports.reserve("fileServer")).toBe(24500);
  });

  it("holds an actual exclusive loopback reservation and hands it to the real listener", async () => {
    const probe = net.createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const selected = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((done) => probe.close(() => done()));
    const ports = manager({ ranges: [[selected, selected]] });
    await ports.reserve("agent");
    const competing = net.createServer();
    await expect(new Promise((resolve, reject) => {
      competing.once("error", reject); competing.listen(selected, "127.0.0.1", resolve);
    })).rejects.toMatchObject({ code: "EADDRINUSE" });
    const service = net.createServer(); servers.push(service);
    const result = await ports.start("agent", async (port) => {
      await new Promise<void>((done, reject) => { service.once("error", reject); service.listen(port, "127.0.0.1", done); });
      return { success: true };
    }, async () => { await new Promise<void>((done) => service.close(() => done())); });
    expect(result.success).toBe(true);
    expect(service.listening).toBe(true);
    expect(ports.get("agent")?.port).toBe(selected);
  });
});
