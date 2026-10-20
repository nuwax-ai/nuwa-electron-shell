import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  health: vi.fn(async () => ({ healthy: true })),
  gateway: { running: false, port: 0, targetPort: 0 },
  gatewayStart: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/nuwax-ports-test" } }));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("fs", () => ({ existsSync: () => true, mkdirSync: vi.fn() }));
vi.mock("../db", () => ({ readSetting: (key: string) => ({
  "auth.saved_key": "registered-key", "lanproxy_config": { serverIp: "127.0.0.1", serverPort: 4900 },
} as Record<string, unknown>)[key] }));
vi.mock("../ipc/perfHandlers", () => ({ createFileServerPerfHandler: () => vi.fn() }));
vi.mock("../services/i18n", () => ({ t: (key: string) => key }));
vi.mock("../services/system/dependencies", () => ({ getAppEnv: () => ({}),
  getLanproxyEntryPath: () => "/lanproxy.js", getTtydBinPath: () => "/ttyd",
  getNuwaxFileServerBundledDir: () => "/file-server", getBundledGitBashPath: () => "/git/bash" }));
vi.mock("../services/system/binaryLocator", () => ({ getBundledGitBinDir: () => "/git" }));
vi.mock("../services/system/shellEnv", () => ({ isWindows: () => false }));
vi.mock("../services/packages/ttydHelper", () => ({ getTtydInitialCwd: () => "/tmp", writeTtydCwdFile: vi.fn(),
  ensureTtydEnvScript: vi.fn(), ensureTtydShellWrapper: () => "/shell-wrapper" }));
vi.mock("../services/packages/ttydGateway", () => ({
  getTtydGatewayStatus: () => mocks.gateway,
  stopTtydGateway: async () => { mocks.gateway.running = false; },
  startTtydGateway: (...args: unknown[]) => mocks.gatewayStart(...args),
  checkTtydGatewayHealth: () => mocks.health(), allocateInternalTtydPort: async () => 60000,
}));
vi.mock("../services/packages/fileServerHealth", () => ({ waitForFileServerHealth: (...args: unknown[]) => mocks.health(...args) }));
vi.mock("../services/packages/lanproxyHealth", () => ({ probeLanproxyAfterStart: async () => ({ healthy: true }) }));
vi.mock("../services/engines/unifiedAgent", () => ({ agentService: { destroy: vi.fn(), init: async () => true } }));
vi.mock("../services/packages/mcp", () => ({ mcpProxyManager: { start: vi.fn(), stop: vi.fn(), getAgentMcpConfig: () => null } }));
vi.mock("../services/packages/guiAgentServer", () => ({ startGuiAgentServer: vi.fn(), stopGuiAgentServer: vi.fn() }));
vi.mock("../services/packages/windowsMcp", () => ({ startWindowsMcp: vi.fn(), stopWindowsMcp: vi.fn() }));
vi.mock("../services/packages/guiMcpLocalConfig", () => ({ shouldStartGuiMcpServices: () => false }));
vi.mock("../services/engines/engineManager", () => ({ stopAllEngines: vi.fn() }));
vi.mock("../services/computerServer", async () => {
  const { getLocalPortManager } = await import("../services/localPorts");
  return { clearAllSseEventBuffers: vi.fn(), startComputerServer: async () =>
    getLocalPortManager()!.start("agent", async () => ({ success: true }), async () => {}) };
});
import { createServiceManager } from "./serviceManager";
import { LocalPortManager, setLocalPortManager } from "../services/localPorts";
import type { ManagedProcess } from "../processManager";

function processFixture() {
  const value = { running: false, pid: 123,
    start: vi.fn(async (_config: unknown) => { value.running = true; return { success: true } as { success: boolean; errorCode?: string }; }),
    stopAsync: vi.fn(async () => { value.running = false; return { success: true }; }) };
  return value;
}
let ports: LocalPortManager;
beforeEach(() => {
  mocks.health.mockReset().mockResolvedValue({ healthy: true });
  mocks.gateway = { running: false, port: 0, targetPort: 0 };
  mocks.gatewayStart.mockReset().mockImplementation(async (config) => {
    mocks.gateway = { running: true, port: config.listenPort, targetPort: config.targetPort };
    return { success: true };
  });
  ports = new LocalPortManager({ ranges: [[24600, 24610]], bind: async () => ({ close: async () => {} }) });
  setLocalPortManager(ports);
});
afterEach(async () => { await ports.dispose(); setLocalPortManager(undefined); });
function fixture() {
  const fileServer = processFixture(); const ttyd = processFixture(); const lanproxy = processFixture();
  const sm = createServiceManager({ fileServer: fileServer as unknown as ManagedProcess,
    ttyd: ttyd as unknown as ManagedProcess, lanproxy: lanproxy as unknown as ManagedProcess,
    agentRunner: processFixture() as unknown as ManagedProcess });
  return { sm, fileServer, ttyd, lanproxy };
}
describe("service manager runtime endpoints", () => {
  it("ignores the legacy file port and reselects after the child reports a bind error", async () => {
    const { sm, fileServer } = fixture();
    fileServer.start.mockResolvedValueOnce({ success: false, errorCode: "EADDRINUSE" });
    expect((await sm.startFileServer(61005)).success).toBe(true);
    expect(ports.get("fileServer")).toMatchObject({ port: 24601, status: "ready" });
    const configs = fileServer.start.mock.calls.map(([config]) => config as { env: Record<string, string> });
    expect(configs.map((config) => config.env.PORT)).toEqual(["24600", "24601"]);
    expect(configs[1].env.HOST).toBe("127.0.0.1");
    expect(configs[1].env.NUWAX_SERVICE_INSTANCE_ID).toBeTruthy();
    expect(mocks.health.mock.calls[0][3]).toBe(configs[1].env.NUWAX_SERVICE_INSTANCE_ID);
  });
  it("does not publish readiness if the owned child exited while its health response was in flight", async () => {
    const { sm, fileServer } = fixture();
    mocks.health.mockImplementationOnce(async () => { fileServer.running = false; return { healthy: true }; });
    expect((await sm.startFileServer(61005)).success).toBe(false);
    expect(ports.get("fileServer")?.status).not.toBe("ready");
    expect(fileServer.start).toHaveBeenCalledTimes(1);
  });

  it("does not change the port or respawn a healthy file service", async () => {
    const { sm, fileServer } = fixture();
    await sm.startFileServer(61005); await sm.startFileServer(60005);
    expect(fileServer.start).toHaveBeenCalledTimes(1);
    expect(ports.get("fileServer")?.port).toBe(24600);
  });
  it("allocates both terminal listeners and recovers from a public gateway bind race", async () => {
    const { sm, ttyd } = fixture();
    mocks.gatewayStart.mockResolvedValueOnce({ success: false, errorCode: "EACCES" });
    expect((await sm.startTtyd()).success).toBe(true);
    const publicEndpoint = ports.get("ttyd")!; const internal = ports.get("ttydInternal")!;
    expect(publicEndpoint.status).toBe("ready"); expect(internal.status).toBe("ready");
    expect(publicEndpoint.port).not.toBe(internal.port);
    const finalStart = ttyd.start.mock.calls.at(-1)![0] as { args: string[] };
    expect(finalStart.args[1]).toBe(String(internal.port));
    expect(mocks.gateway.port).toBe(publicEndpoint.port);
    expect(mocks.gateway.targetPort).toBe(internal.port);
  });
  it("waits for every registered local listener before publishing and starting the tunnel", async () => {
    const { sm, lanproxy } = fixture();
    const publish = vi.fn(async () => {
      for (const service of ["agent", "fileServer", "ttyd"] as const) expect(ports.get(service)?.status).toBe("ready");
    });
    ports.setBeforePublish(publish);
    expect((await sm.restartAllServices(new AbortController().signal)).success).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(lanproxy.start.mock.invocationCallOrder[0]);
  });
});
