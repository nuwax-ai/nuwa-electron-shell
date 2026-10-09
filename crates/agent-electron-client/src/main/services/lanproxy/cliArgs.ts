/**
 * lanproxy 客户端命令行参数解析。参数名与 lanproxy-go-client 保持一致：
 *   -s <host> -p <port> -k <clientKey> --ssl[=true|false] --cer <path>
 *   --log-file <path> --disable-connection-pool
 * 另支持从环境变量 LANPROXY_CLIENT_KEY 读取 clientKey，避免密钥出现在进程命令行。
 */

export const CLIENT_KEY_ENV = "LANPROXY_CLIENT_KEY";
export const DEFAULT_SERVER_PORT = 4900;

export interface CliOptions {
  server: string;
  port: number;
  key: string;
  ssl: boolean;
  cer?: string;
  logFile?: string;
  poolSize: number;
}

export type ParseResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string };

const VALUE_FLAGS = new Set(["-s", "-p", "-k", "--ssl", "--cer", "--log-file"]);

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParseResult {
  const values = new Map<string, string>();
  let disablePool = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq > 0 ? token.slice(0, eq) : token;

    if (flag === "--disable-connection-pool") {
      disablePool = true;
    } else if (VALUE_FLAGS.has(flag)) {
      let value: string | undefined;
      if (eq > 0) {
        value = token.slice(eq + 1);
      } else {
        value = argv[++i];
      }
      if (value === undefined)
        return { ok: false, error: `missing value for ${flag}` };
      values.set(flag, value);
    } else {
      return { ok: false, error: `unknown argument: ${token}` };
    }
  }

  const server = values.get("-s") ?? "";
  if (!server)
    return { ok: false, error: "server ip addr is required, use -s" };

  const key = values.get("-k") || env[CLIENT_KEY_ENV] || "";
  if (!key) {
    return {
      ok: false,
      error: `clientkey is required, use -k or ${CLIENT_KEY_ENV}`,
    };
  }

  const portText = values.get("-p");
  const port = portText === undefined ? DEFAULT_SERVER_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `invalid server port: ${portText}` };
  }

  return {
    ok: true,
    options: {
      server,
      port,
      key,
      ssl: values.get("--ssl") === "true",
      cer: values.get("--cer") || undefined,
      logFile: values.get("--log-file") || undefined,
      poolSize: disablePool ? 0 : 100,
    },
  };
}
