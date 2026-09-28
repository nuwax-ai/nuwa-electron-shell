import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const { home } = vi.hoisted(() => ({ home: `/tmp/nuwax-ttyd-wrapper-${process.pid}` }));
vi.mock("electron", () => ({ app: { getPath: () => home, isPackaged: false } }));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../db", () => ({ readSetting: vi.fn() }));
vi.mock("../engines/unifiedAgent", () => ({ agentService: {} }));
vi.mock("../system/dependencies", () => ({ getAppEnv: vi.fn() }));
vi.mock("../system/binaryLocator", () => ({
  getClaudeCodeAcpBundledDir: vi.fn(), getNuwaxFileServerBundledDir: vi.fn(),
}));
vi.mock("./packageLocator", () => ({ getBundledMcpProxyDir: vi.fn() }));
import { ensureTtydShellWrapper } from "./ttydHelper";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ttyd-wrapper-test-"));
const project = path.join(root, "项目 with spaces");
fs.mkdirSync(project);
const probe = path.join(root, "probe-shell");
fs.writeFileSync(probe, '#!/bin/bash\nprintf "cwd=%s\\nctype=%s\\nall=%s\\n" "$PWD" "$LC_CTYPE" "$LC_ALL"\nlocale charmap\nprintf "中文输入回显\\n"\n', { mode: 0o755 });
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("ttyd actual generated shell wrapper", () => {
  it.each([
    {},
    { LANG: "C" },
    { LANG: "en_US.UTF-8", LC_CTYPE: "C" },
    { LANG: "en_US.UTF-8", LC_ALL: "C" },
  ])("honors selected Chinese cwd and repairs effective locale: %j", (locale) => {
    const wrapper = ensureTtydShellWrapper()!;
    const env = { ...process.env, SHELL: probe };
    delete env.LANG; delete env.LC_ALL; delete env.LC_CTYPE;
    const result = spawnSync("/bin/bash", [wrapper, "--cwd", project], {
      env: { ...env, ...locale }, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`cwd=${project}\n`);
    expect(result.stdout).toMatch(/UTF-?8/i);
    expect(result.stdout).toContain("中文输入回显");
    expect(result.stdout).not.toContain("ANSI_X3.4");
  });
  it("preserves an existing effective UTF-8 locale", () => {
    const result = spawnSync("/bin/bash", [ensureTtydShellWrapper()!, "--cwd", project], {
      env: { ...process.env, SHELL: probe, LC_ALL: "en_US.UTF-8", LC_CTYPE: "C" }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("all=en_US.UTF-8");
    expect(result.stdout).toContain("ctype=C");
  });
});
