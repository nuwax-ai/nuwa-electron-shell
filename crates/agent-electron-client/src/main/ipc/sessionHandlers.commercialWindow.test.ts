import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  createWindow: vi.fn(),
  readSetting: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) =>
    state.handlers.set(name, handler) },
  app: { isPackaged: false },
  session: { defaultSession: { cookies: {} } },
  BrowserWindow: class { constructor() { state.createWindow(); } },
}));
vi.mock("electron-log", () => ({ default: {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} }));
vi.mock("@shared/constants", () => ({
  APP_DISPLAY_NAME: "Nuwax",
  APP_NAME_IDENTIFIER: "nuwax",
}));
vi.mock("../db", () => ({
  readSetting: state.readSetting,
  writeSetting: vi.fn(),
}));
vi.mock("@shared/utils/domain", () => ({ getDomainTokenKey: vi.fn() }));
vi.mock("../services/i18n", () => ({ t: (key: string) => key }));

import { registerSessionHandlers } from "./sessionHandlers";

describe("legacy webview window in commercial builds", () => {
  it("rejects an external URL before synchronizing cookies or creating a shared-session window", async () => {
    registerSessionHandlers({ getMainWindow: () => null } as never);
    const handler = state.handlers.get("webview:openWindow");
    expect(handler).toBeDefined();
    expect(await handler!({}, { url: "https://outside.example/" })).toEqual({
      success: false,
      error: "unsupportedCommercialWindow",
    });
    expect(state.readSetting).not.toHaveBeenCalled();
    expect(state.createWindow).not.toHaveBeenCalled();
  });
});
