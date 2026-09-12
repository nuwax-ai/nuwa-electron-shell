import { describe, expect, it, vi } from "vitest";
import { AuthLifecycle } from "./lifecycle";
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
function fixture() {
  const adapter = {
    authenticated: vi.fn(() => true),
    register: vi.fn(async (_signal: AbortSignal) => "key"),
    commit: vi.fn(),
    start: vi.fn(async (_signal: AbortSignal) => ({ success: true })),
    stop: vi.fn(async () => ({ success: true })),
  };
  return { adapter, flow: new AuthLifecycle(adapter) };
}
describe("auth lifecycle", () => {
  it("does not register or start without login", async () => {
    const { flow, adapter } = fixture();
    adapter.authenticated.mockReturnValue(false);
    expect((await flow.start()).success).toBe(false);
    expect(adapter.register).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
  });
  it("shares duplicate starts and does not restart ready services", async () => {
    const { flow, adapter } = fixture();
    await Promise.all([flow.start(), flow.start()]);
    await flow.start();
    expect(adapter.register).toHaveBeenCalledTimes(1);
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.commit.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.start.mock.invocationCallOrder[0],
    );
  });
  it("rejects late registration after logout/domain switch", async () => {
    const { flow, adapter } = fixture();
    const reg = deferred<string>();
    adapter.register.mockReturnValue(reg.promise);
    const start = flow.start();
    await Promise.resolve();
    const stop = flow.stop();
    reg.resolve("old-key");
    expect((await start).success).toBe(false);
    await stop;
    expect(adapter.commit).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });
  it("cancels in-flight start, drains it before stop, supports new login", async () => {
    const { flow, adapter } = fixture();
    const started = deferred<{ success: boolean }>();
    adapter.start.mockReturnValueOnce(started.promise);
    const pending = flow.start();
    await vi.waitFor(() => expect(adapter.start).toHaveBeenCalled());
    const stop = flow.stop();
    expect(adapter.start.mock.calls[0][0].aborted).toBe(true);
    started.resolve({ success: true });
    await pending;
    await stop;
    expect(adapter.stop).toHaveBeenCalled();
    expect((await flow.start()).success).toBe(true);
  });
  it("reports registration and stop failures", async () => {
    const { flow, adapter } = fixture();
    adapter.register.mockRejectedValue(new Error("reg failed"));
    expect((await flow.start()).success).toBe(false);
    expect(adapter.start).not.toHaveBeenCalled();
    adapter.stop.mockResolvedValue({ success: false });
    expect((await flow.stop()).success).toBe(false);
  });
});
