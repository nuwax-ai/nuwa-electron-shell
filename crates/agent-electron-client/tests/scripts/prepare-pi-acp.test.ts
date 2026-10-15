import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testFileDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testFileDir, "..", "..");
const require = createRequire(import.meta.url);
const { resolvePkgDir, shouldCopy, collectRuntimeDeps } = require(
  path.join(projectRoot, "scripts", "prepare", "prepare-pi-acp.js"),
) as {
  resolvePkgDir: (pkgName: string) => string;
  shouldCopy: (relPath: string) => boolean;
  collectRuntimeDeps: (
    entryPkgDir: string,
    destRoot: string,
  ) => Map<string, string>;
};

describe("prepare-pi-acp helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function mkTmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-acp-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("resolves installed pi-acp and pi packages from node_modules", () => {
    const acpDir = resolvePkgDir("pi-acp");
    expect(fs.existsSync(path.join(acpDir, "package.json"))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(acpDir, "package.json"), "utf8")).name,
    ).toBe("pi-acp");

    const piDir = resolvePkgDir("@earendil-works/pi-coding-agent");
    expect(
      fs.existsSync(path.join(piDir, "dist", "bundle", "cli.js")),
    ).toBe(true);
  });

  it("filters out sources, maps, prebuilds and tests from copied deps", () => {
    expect(shouldCopy("dist/index.js")).toBe(true);
    expect(shouldCopy("package.json")).toBe(true);
    expect(shouldCopy("dist/index.js.map")).toBe(false);
    expect(shouldCopy("src/index.ts")).toBe(false);
    expect(shouldCopy("native/prebuilds/darwin-x64/x.node")).toBe(false);
    expect(shouldCopy("lib/test/foo.js")).toBe(false);
    expect(shouldCopy("docs/readme.md")).toBe(false);
    expect(shouldCopy("node_modules/.bin/pi")).toBe(false);
  });

  it("collects runtime dependency closure flat under dest node_modules", () => {
    const src = mkTmp();
    const dest = mkTmp();
    // fake pkg tree: entry -> dep-a -> dep-b
    const writePkg = (name: string, deps: Record<string, string>) => {
      const dir = path.join(src, "pkgs", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name, version: "1.0.0", dependencies: deps }),
      );
      fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
      fs.writeFileSync(path.join(dir, "dist", "index.js"), "//");
      return dir;
    };
    writePkg("dep-b", {});
    writePkg("dep-a", { "dep-b": "^1.0.0" });
    const entry = writePkg("entry", { "dep-a": "^1.0.0" });

    const seen = collectRuntimeDeps(entry, dest);
    expect([...seen.keys()].sort()).toEqual(["dep-a", "dep-b"]);
    expect(
      fs.existsSync(path.join(dest, "node_modules", "dep-a", "dist", "index.js")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(dest, "node_modules", "dep-b", "package.json")),
    ).toBe(true);
  });
});
