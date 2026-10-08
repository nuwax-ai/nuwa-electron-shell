import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ version: "3.0.10", settings: new Map<string, string>() }));
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/channel-test", getVersion: () => state.version } }));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), error: vi.fn() } }));
vi.mock("better-sqlite3", () => ({ default: class {
  exec() {}
  close() {}
  prepare(sql: string) {
    return {
      run(key: string, value: string) {
        if (!sql.includes("OR IGNORE") || !state.settings.has(key)) state.settings.set(key, value);
      },
      get(key: string) { return state.settings.has(key) ? { value: state.settings.get(key) } : undefined; },
    };
  }
} }));
import { closeDb, initDatabase, readSetting, writeSetting } from "./db";

describe("packaged update subscription defaults", () => {
  beforeEach(() => { closeDb(); state.settings.clear(); });
  it.each([["3.0.10", "stable"], ["3.0.11-beta.1", "beta"], ["3.0.11-beta.10", "beta"]])(
    "first installation of %s defaults to %s", (version, channel) => {
      state.version = version; initDatabase();
      expect(readSetting("update_channel")).toBe(channel);
    },
  );
  it.each(["stable", "beta"])("retains saved %s through beta upgrade, promotion and restart", (saved) => {
    state.version = "3.0.11-beta.1"; initDatabase(); writeSetting("update_channel", saved);
    for (const version of ["3.0.11-beta.2", "3.0.11", "3.0.12"]) {
      closeDb(); state.version = version; initDatabase();
      expect(readSetting("update_channel")).toBe(saved);
    }
  });
});
