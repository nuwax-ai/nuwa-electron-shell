import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, unknown>();
vi.mock("../db", () => ({
  readSetting: (key: string) => settings.get(key) ?? null,
}));

import {
  businessBridgeOrigins,
  canUseUpdater,
  isBusinessBridgeSender,
  isHostRendererSender,
  shouldInjectWebviewPerfBridge,
} from "./bridgeTrust";

const business = "https://business.example";
const gateway = "http://127.0.0.1:46800";
const external = "https://external.example";

function event(frame: string, top: string) {
  return {
    senderFrame: { url: `${frame}/page` },
    sender: { getURL: () => `${top}/page` },
  } as never;
}

beforeEach(() => {
  settings.clear();
  settings.set("step1_config", { serverHost: business });
  settings.set("nuwax.loopback", { enabled: true, origin: gateway });
});

describe("business bridge origin policy", () => {
  it("limits commercial first attachment to business and enabled gateway", () => {
    expect(businessBridgeOrigins()).toEqual([business, gateway]);
    expect(shouldInjectWebviewPerfBridge(`${business}/home`, "nuwax")).toBe(true);
    expect(shouldInjectWebviewPerfBridge(`${gateway}/home`, "nuwax")).toBe(true);
    expect(shouldInjectWebviewPerfBridge(`${external}/docs`, "nuwax")).toBe(false);
    expect(shouldInjectWebviewPerfBridge("https://user:pass@business.example/home", "nuwax"))
      .toBe(false);
    expect(shouldInjectWebviewPerfBridge(`${external}/docs`, "nuwaclaw")).toBe(true);
    expect(shouldInjectWebviewPerfBridge("file:///tmp/x", "nuwaclaw")).toBe(false);
  });

  it("accepts a configured hostname with the same HTTPS default as the business session", () => {
    settings.set("step1_config", { serverHost: "business.example" });
    expect(businessBridgeOrigins()).toEqual([business, gateway]);
    expect(shouldInjectWebviewPerfBridge(`${business}/home`, "nuwax")).toBe(true);
  });

  it("checks current frame and top origin after navigation", () => {
    expect(isBusinessBridgeSender(event(gateway, gateway))).toBe(true);
    expect(isBusinessBridgeSender(event(gateway, external))).toBe(false);
    expect(isBusinessBridgeSender(event(external, gateway))).toBe(false);
    expect(isBusinessBridgeSender(event("https://user:pass@business.example", business)))
      .toBe(false);
    settings.set("nuwax.loopback", { enabled: false, origin: gateway });
    expect(isBusinessBridgeSender(event(gateway, gateway))).toBe(false);
  });

  it("allows only the actual local shell main frame to use shell capabilities", () => {
    const mainFrame = { url: "file:///app/index.html" };
    const host = { mainFrame, getURL: () => mainFrame.url };
    expect(isHostRendererSender({ sender: host, senderFrame: mainFrame } as never, host as never, true))
      .toBe(true);
    expect(isHostRendererSender({ sender: host, senderFrame: { url: mainFrame.url } } as never, host as never, true))
      .toBe(false);
    expect(isHostRendererSender(event(business, business), host as never, true)).toBe(false);
    expect(canUseUpdater(event(business, business), host as never, true, "nuwax")).toBe(true);
    expect(canUseUpdater(event(gateway, external), host as never, true, "nuwax")).toBe(false);
    expect(canUseUpdater(event(external, external), host as never, true, "nuwax")).toBe(false);
    expect(canUseUpdater({ sender: host, senderFrame: mainFrame } as never, host as never, true, "nuwax"))
      .toBe(true);
  });
});
