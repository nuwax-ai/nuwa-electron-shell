import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ send: vi.fn(), start: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [{ webContents: { send: h.send } }] } }));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../localPorts", () => ({ getLocalPortManager: () => ({}) }));
vi.mock("../auth/lifecycle", () => ({ commercialLifecycle: { start: h.start } }));
vi.mock("../packages/lanproxyHealth", () => ({ checkLanproxyHealth: vi.fn() }));
vi.mock("../engines/unifiedAgent", () => ({ agentService: {} }));
vi.mock("./router", () => ({ parseBody: vi.fn() }));

import { handleAdminRequest } from "./adminServer";

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

it.each([
  [{ success: true, results: { fileServer: { success: true } } }, { success: true, results: { fileServer: { success: true } } }],
  [{ success: false, error: "Registration failed" }, { success: false, results: { services: { success: false, error: "Registration failed" } } }],
])("finishes the restart notification for an automatic lifecycle result", async (result, expected) => {
  h.start.mockResolvedValue(result);
  await handleAdminRequest(
    { url: "/admin/services/restart", method: "POST" } as any,
    { writeHead: vi.fn(), end: vi.fn() } as any,
  );
  expect(h.send).toHaveBeenCalledWith("admin:servicesRestarting");
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.start).toHaveBeenCalledWith(true);
  expect(h.send).toHaveBeenLastCalledWith("admin:servicesRestarted", expected);
});
