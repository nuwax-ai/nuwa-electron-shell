import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

describe("signing upload recovery", () => {
  for (const name of ["sign-release-win.sh", "sign-release-win-v2.sh"]) {
    it.each([false, true])(`${name} cleans the CI original only after successful upload (failure=%s)`, (failure) => {
      const root = mkdtempSync(join(tmpdir(), "sign-retry-"));
      try {
        const work = join(root, "work"), signed = join(work, "signed"), trace = join(root, "trace"), gh = join(root, "gh");
        mkdirSync(signed, { recursive: true });
        for (const prefix of ["Nuwax", "NuwaClaw"]) writeFileSync(join(signed, `${prefix}.Setup.3.0.10.exe`), "previously signed fixture");
        writeFileSync(gh, `#!/bin/sh
if [ "$1" = release ]; then
  printf '%s %s\\n' "$2" "$3" >> "$SIGN_TEST_TRACE"
  if [ "$2" = upload ] && [ "$SIGN_TEST_FAILURE" = true ]; then exit 1; fi
fi
`, { mode: 0o755 });
        const result = spawnSync("bash", [resolve("scripts/build", name), "3.0.10", "--upload-only"], {
          encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GH_TOKEN: "fixture-invalid", GH_BIN: gh, SIGN_WORK_DIR: work,
            SIGN_WIN_ARTIFACT_PREFIX: "Nuwax", SIGN_RELEASE_TAG: "v3.0.10", SIGN_SKIP_BLOCKMAP: "true",
            SIGN_TEST_TRACE: trace, SIGN_TEST_FAILURE: String(failure) },
        });
        const commands = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [];
        expect(commands[0], result.stdout + result.stderr).toBe("upload v3.0.10");
        if (failure) {
          expect(result.status).not.toBe(0);
          expect(commands).toEqual(["upload v3.0.10"]);
        } else {
          expect(result.status, result.stderr).toBe(0);
          expect(commands.slice(1).every(command => command === "delete-asset v3.0.10")).toBe(true);
          expect(commands).toHaveLength(4);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});
