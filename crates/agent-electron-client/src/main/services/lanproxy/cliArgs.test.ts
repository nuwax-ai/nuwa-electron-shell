import { describe, expect, it } from "vitest";
import { CLIENT_KEY_ENV, parseArgs } from "./cliArgs";

describe("parseArgs", () => {
  it("parses the arguments the shell passes to the client today", () => {
    const r = parseArgs(
      ["-s", "tunnel.example.com", "-p", "10076", "-k", "abc", "--ssl=true"],
      {},
    );
    expect(r).toEqual({
      ok: true,
      options: {
        server: "tunnel.example.com",
        port: 10076,
        key: "abc",
        ssl: true,
        cer: undefined,
        logFile: undefined,
        poolSize: 100,
      },
    });
  });

  it("accepts --ssl as a separate value and treats anything but 'true' as off", () => {
    const on = parseArgs(["-s", "h", "-k", "k", "--ssl", "true"], {});
    const off = parseArgs(["-s", "h", "-k", "k", "--ssl=false"], {});
    expect(on.ok && on.options.ssl).toBe(true);
    expect(off.ok && off.options.ssl).toBe(false);
  });

  it("defaults the port to 4900 like the Go client", () => {
    const r = parseArgs(["-s", "h", "-k", "k"], {});
    expect(r.ok && r.options.port).toBe(4900);
  });

  it("reads the key from the environment so it stays off the command line", () => {
    const r = parseArgs(["-s", "h"], { [CLIENT_KEY_ENV]: "from-env" });
    expect(r.ok && r.options.key).toBe("from-env");
  });

  it("prefers -k over the environment", () => {
    const r = parseArgs(["-s", "h", "-k", "cli"], { [CLIENT_KEY_ENV]: "env" });
    expect(r.ok && r.options.key).toBe("cli");
  });

  it("supports --disable-connection-pool, --cer and --log-file", () => {
    const r = parseArgs(
      [
        "-s",
        "h",
        "-k",
        "k",
        "--disable-connection-pool",
        "--cer",
        "/c.pem",
        "--log-file",
        "/l.log",
      ],
      {},
    );
    expect(r.ok && r.options).toMatchObject({
      poolSize: 0,
      cer: "/c.pem",
      logFile: "/l.log",
    });
  });

  it("reports missing server, missing key, bad port, unknown flags and dangling values", () => {
    expect(parseArgs(["-k", "k"], {})).toEqual({
      ok: false,
      error: "server ip addr is required, use -s",
    });
    expect(parseArgs(["-s", "h"], {}).ok).toBe(false);
    expect(parseArgs(["-s", "h", "-k", "k", "-p", "70000"], {}).ok).toBe(false);
    expect(parseArgs(["-s", "h", "-k", "k", "-p", "abc"], {}).ok).toBe(false);
    expect(parseArgs(["-s", "h", "-k", "k", "--bogus"], {}).ok).toBe(false);
    expect(parseArgs(["-s"], {}).ok).toBe(false);
  });
});
