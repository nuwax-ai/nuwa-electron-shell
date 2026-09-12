import { afterEach, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile: execute }));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
afterEach(() => vi.unstubAllEnvs());
it("never kills unknown listeners on behalf of the commercial product", async () => {
  vi.stubEnv("NUWAX_APP_IDENTIFIER", "nuwax");
  vi.resetModules();
  const tree = await import("./processTree");
  await tree.killProcessTreesListeningOnTcpPort(60005);
  await tree.killProcessTreesListeningOnTcpPortWindows(60005);
  await tree.killProcessTreesListeningOnTcpPortUnix(60005);
  expect(execute).not.toHaveBeenCalled();
});
