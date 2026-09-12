/**
 * 单元测试: deviceId
 *
 * 测试设备 ID 生成、缓存与异常回退逻辑，以及商业版独立盐产生的身份隔离。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";

// Mock electron-log
vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock node-machine-id
const mockMachineIdSync = vi.fn();
vi.mock("node-machine-id", () => ({
  machineIdSync: (...args: unknown[]) => mockMachineIdSync(...args),
}));

// Mock os.hostname
const mockHostname = vi.fn(() => "mock-hostname");
vi.mock("os", () => ({
  hostname: () => mockHostname(),
}));

const COMMUNITY_SALT = "nuwax-agent";
const PRODUCT_SALT = "nuwax:device:v1";
const expectedId = (raw: string, salt: string) =>
  createHash("sha256")
    .update(raw + salt)
    .digest("hex");

describe("deviceId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // 默认按社区标识加载，未设 env 时两者等价。
    vi.stubEnv("NUWAX_APP_IDENTIFIER", "nuwaclaw");
    mockMachineIdSync.mockReturnValue("mock-machine-id");
    mockHostname.mockReturnValue("mock-hostname");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should return a 64-char hex string", async () => {
    const { getDeviceId } = await import("./deviceId");
    const id = getDeviceId();

    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should hash machineId + salt with SHA-256", async () => {
    const { getDeviceId } = await import("./deviceId");
    const id = getDeviceId();

    expect(id).toBe(expectedId("mock-machine-id", COMMUNITY_SALT));
  });

  it("should call machineIdSync with original=true", async () => {
    const { getDeviceId } = await import("./deviceId");
    getDeviceId();

    expect(mockMachineIdSync).toHaveBeenCalledWith(true);
  });

  it("should cache the result on subsequent calls", async () => {
    const { getDeviceId } = await import("./deviceId");
    const first = getDeviceId();
    const second = getDeviceId();

    expect(first).toBe(second);
    expect(mockMachineIdSync).toHaveBeenCalledTimes(1);
  });

  it("should log the deviceId on first call", async () => {
    const { getDeviceId } = await import("./deviceId");
    const log = (await import("electron-log")).default;
    const id = getDeviceId();

    expect(log.info).toHaveBeenCalledWith(`[DeviceId] ${id}`);
  });

  it("should fallback to hostname when machineIdSync throws", async () => {
    mockMachineIdSync.mockImplementation(() => {
      throw new Error("no machine-id");
    });

    const { getDeviceId } = await import("./deviceId");
    const log = (await import("electron-log")).default;
    const id = getDeviceId();

    expect(id).toBe(expectedId("mock-hostname", COMMUNITY_SALT));
    expect(log.warn).toHaveBeenCalledWith(
      "[DeviceId] Failed to read machineId, using hostname fallback:",
      expect.any(Error),
    );
  });

  it("should produce different IDs for different machineIds", async () => {
    mockMachineIdSync.mockReturnValue("machine-a");
    const mod1 = await import("./deviceId");
    const idA = mod1.getDeviceId();

    vi.resetModules();
    mockMachineIdSync.mockReturnValue("machine-b");
    const mod2 = await import("./deviceId");
    const idB = mod2.getDeviceId();

    expect(idA).not.toBe(idB);
  });

  it("should derive an independent identity for the commercial product", async () => {
    vi.stubEnv("NUWAX_APP_IDENTIFIER", "nuwax");
    vi.resetModules();
    const product = (await import("./deviceId")).getDeviceId();

    expect(product).toBe(expectedId("mock-machine-id", PRODUCT_SALT));
    expect(product).not.toBe(expectedId("mock-machine-id", COMMUNITY_SALT));
  });

  it("should fall back to the community identity when no env is set", async () => {
    vi.stubEnv("NUWAX_APP_IDENTIFIER", "");
    vi.resetModules();
    const { getDeviceId } = await import("./deviceId");

    expect(getDeviceId()).toBe(expectedId("mock-machine-id", COMMUNITY_SALT));
  });
});
