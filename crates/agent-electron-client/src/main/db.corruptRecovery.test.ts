import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_DATA_DIR_NAME } from "./services/constants";
import { APP_NAME_IDENTIFIER } from "@shared/constants";

const env = vi.hoisted(() => ({ home: "", renameFails: false, failRenameOf: "" }));
const sqlite = vi.hoisted(() => ({ opened: 0, closed: 0, openFailsFrom: 0, execFailsFrom: 0, readonlyWrites: false }));

vi.mock("electron", () => ({ app: { getPath: () => env.home, getVersion: () => "3.0.10" } }));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (env.renameFails || (env.failRenameOf && from.endsWith(env.failRenameOf))) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return actual.renameSync(from, to);
    },
  };
});
vi.mock("better-sqlite3", async () => {
  const fsActual = await import("node:fs");
  const bytes = (file: string) => fsActual.readFileSync(file, "latin1");
  return {
    default: class FakeDatabase {
      private readonly rows = new Map<string, string>();
      private readonly index: number;
      constructor(private readonly file: string) {
        sqlite.opened += 1;
        this.index = sqlite.opened;
        if (sqlite.openFailsFrom && sqlite.opened >= sqlite.openFailsFrom) {
          throw Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
        }
        if (!fsActual.existsSync(file)) fsActual.writeFileSync(file, "SQLite format 3\0");
      }
      exec() {
        if (sqlite.execFailsFrom && this.index >= sqlite.execFailsFrom) {
          throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
        }
        if (bytes(this.file).startsWith("GARBAGE")) {
          throw Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" });
        }
      }
      pragma() {
        return bytes(this.file).includes("DAMAGED") ? "row 1 missing from index sqlite_autoindex_settings_1" : "ok";
      }
      close() {
        sqlite.closed += 1;
      }
      prepare(sql: string) {
        return {
          run: (key: string, value: string) => {
            if (sqlite.readonlyWrites) {
              throw Object.assign(new Error("attempt to write a readonly database"), { code: "SQLITE_READONLY" });
            }
            if (!sql.includes("OR IGNORE") || !this.rows.has(key)) this.rows.set(key, value);
          },
          get: (key: string) => (this.rows.has(key) ? { value: this.rows.get(key) } : undefined),
        };
      }
    },
  };
});

async function load(files: Record<string, string> = {}) {
  env.home = fs.mkdtempSync(path.join(os.tmpdir(), "db-recovery-"));
  const dir = path.join(env.home, APP_DATA_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${APP_NAME_IDENTIFIER}.db`);
  for (const [suffix, content] of Object.entries(files)) fs.writeFileSync(file + suffix, content);
  vi.resetModules();
  const mod = await import("./db");
  const backups = () => fs.readdirSync(dir).filter((name) => name.includes(".corrupt-")).sort();
  return { mod, dir, file, backups };
}

describe("database corruption self-healing", () => {
  beforeEach(() => {
    env.renameFails = false;
    env.failRenameOf = "";
    sqlite.opened = 0;
    sqlite.closed = 0;
    sqlite.openFailsFrom = 0;
    sqlite.execFailsFrom = 0;
    sqlite.readonlyWrites = false;
  });

  it("leaves a healthy database untouched", async () => {
    const { mod, backups } = await load({ "": "SQLite format 3\0healthy" });
    mod.initDatabase();
    expect(mod.getDb()).not.toBeNull();
    expect(backups()).toEqual([]);
    expect(sqlite.opened).toBe(1);
  });

  it("moves a file that is not a database aside, keeping its bytes, and starts fresh", async () => {
    const { mod, dir, file, backups } = await load({ "": "GARBAGE-bytes" });
    mod.initDatabase();
    const [backup] = backups();
    expect(backups()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backup), "utf8")).toBe("GARBAGE-bytes");
    expect(fs.readFileSync(file, "latin1").startsWith("SQLite format 3")).toBe(true);
    expect(mod.getDb()).not.toBeNull();
    expect(mod.writeSetting("greeting", "hi")).toBe(true);
    expect(mod.readSetting("greeting")).toBe("hi");
  });

  it("treats a failing quick_check as corruption", async () => {
    const { mod, dir, backups } = await load({ "": "SQLite format 3\0DAMAGED pages" });
    mod.initDatabase();
    const [backup] = backups();
    expect(backups()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backup), "latin1")).toContain("DAMAGED");
    expect(mod.getDb()).not.toBeNull();
    expect(mod.readSetting("update_channel")).toBe("stable");
  });

  it("moves WAL and SHM sidecars together with the corrupt file", async () => {
    const { mod, file, backups } = await load({ "": "GARBAGE", "-wal": "wal", "-shm": "shm" });
    mod.initDatabase();
    expect(backups()).toHaveLength(3);
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-shm`)).toBe(false);
  });

  it("does not move the file for non-corruption failures and keeps the handle readable", async () => {
    sqlite.readonlyWrites = true;
    const { mod, backups } = await load({ "": "SQLite format 3\0healthy" });
    mod.initDatabase();
    expect(backups()).toEqual([]);
    expect(mod.getDb()).not.toBeNull();
    expect(mod.readSetting("anything")).toBeNull();
  });

  it("gives up without throwing when the corrupt file cannot be moved", async () => {
    env.renameFails = true;
    const { mod, file, backups } = await load({ "": "GARBAGE-bytes" });
    expect(() => mod.initDatabase()).not.toThrow();
    expect(mod.getDb()).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe("GARBAGE-bytes");
    expect(backups()).toEqual([]);
  });

  it("gives up without throwing when the fresh database also cannot be opened", async () => {
    sqlite.openFailsFrom = 2;
    const { mod, backups } = await load({ "": "GARBAGE-bytes" });
    expect(() => mod.initDatabase()).not.toThrow();
    expect(mod.getDb()).toBeNull();
    expect(backups()).toHaveLength(1);
  });

  it("closes and drops the fresh handle when creating its schema fails, so startup reads see null", async () => {
    sqlite.execFailsFrom = 2;
    const { mod, backups } = await load({ "": "GARBAGE-bytes" });
    expect(() => mod.initDatabase()).not.toThrow();
    expect(mod.getDb()).toBeNull();
    expect(mod.readSetting("update_channel")).toBeNull();
    expect(sqlite.closed).toBe(2);
    expect(backups()).toHaveLength(1);
  });

  it("restores sidecars already moved when a later sidecar cannot be moved", async () => {
    env.failRenameOf = "-shm";
    const { mod, file, backups } = await load({ "": "GARBAGE-bytes", "-wal": "wal", "-shm": "shm" });
    expect(() => mod.initDatabase()).not.toThrow();
    expect(mod.getDb()).toBeNull();
    expect(backups()).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("GARBAGE-bytes");
    expect(fs.readFileSync(`${file}-wal`, "utf8")).toBe("wal");
    expect(fs.readFileSync(`${file}-shm`, "utf8")).toBe("shm");
  });

  it("restores the sidecars when the main file is the one that cannot be moved", async () => {
    env.failRenameOf = ".db";
    const { mod, file, backups } = await load({ "": "GARBAGE-bytes", "-wal": "wal", "-shm": "shm" });
    expect(() => mod.initDatabase()).not.toThrow();
    expect(mod.getDb()).toBeNull();
    expect(backups()).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("GARBAGE-bytes");
    expect(fs.readFileSync(`${file}-wal`, "utf8")).toBe("wal");
    expect(fs.readFileSync(`${file}-shm`, "utf8")).toBe("shm");
  });
});
