/**
 * pi 引擎（pi-acp 适配器 + pi coding agent）spawn 前的配置文件生成。
 *
 * pi 不认 ANTHROPIC_BASE_URL/ANTHROPIC_MODEL 这类 env 直连自定义端点（key 只对原生
 * provider 生效），因此模型/MCP 配置必须落盘到 pi 的 agent 目录（PI_CODING_AGENT_DIR，
 * 壳内为 isolated home 下的 ~/.pi/agent）：
 *
 *   models.json  —— providers.<id> 自定义端点（apiKey 走 $NUWAX_PI_API_KEY env 插值，
 *                   不落盘明文；api 类型按 apiProtocol 选 anthropic-messages /
 *                   openai-completions）
 *   settings.json —— defaultProvider/defaultModel/quietStartup
 *   mcp.json     —— mcpServers（exposure:"direct" 使工具直接声明给模型）
 *
 * 纯函数 + 最小写盘 IO，便于单测。
 */
import * as fs from "fs";
import * as path from "path";

export const PI_API_KEY_ENV = "NUWAX_PI_API_KEY";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_COMMAND_ENV = "PI_ACP_PI_COMMAND";

/** pi models.json 支持的 wire API（取自 pi-ai 常用类型） */
export function resolvePiApiType(
  apiProtocol?: string,
  model?: string,
): "anthropic-messages" | "openai-completions" {
  const proto = (apiProtocol || "").toLowerCase();
  if (proto === "openai" || proto.startsWith("openai")) {
    return "openai-completions";
  }
  if (proto === "anthropic") return "anthropic-messages";
  // openai-compatible/ 前缀模型走 OpenAI 协议（与 openAICompatRouting 口径一致）
  if (model && model.startsWith("openai-compatible/")) {
    return "openai-completions";
  }
  return "anthropic-messages";
}

export interface PiModelConfigInput {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  apiProtocol?: string;
}

/** 生成 models.json（apiKey 用 env 插值占位，不写明文） */
export function buildPiModelsJson(input: PiModelConfigInput): string {
  const modelId = (input.model || "").trim() || "nuwax-default";
  const provider: Record<string, unknown> = {
    baseUrl: (input.baseUrl || "").trim() || "http://127.0.0.1:1",
    api: resolvePiApiType(input.apiProtocol, input.model),
    // pi 支持 $VAR 环境插值；无 key 时也给占位（pi 需要非空 apiKey 字段才视为可用）
    apiKey: `$${PI_API_KEY_ENV}`,
    models: [{ id: modelId }],
  };
  return JSON.stringify({ providers: { nuwax: provider } }, null, 2) + "\n";
}

/** 生成 settings.json（defaultProvider/defaultModel 指向 nuwax 自定义端点） */
export function buildPiSettingsJson(input: PiModelConfigInput): string {
  const modelId = (input.model || "").trim() || "nuwax-default";
  return (
    JSON.stringify(
      {
        defaultProvider: "nuwax",
        defaultModel: modelId,
        quietStartup: true,
        // 项目目录自带的 AGENTS.md/CLAUDE.md 一律不采信（客户 README 会污染会话）；
        // 引擎指令统一放 agent 目录（isolated home）
        defaultProjectTrust: "never",
      },
      null,
      2,
    ) + "\n"
  );
}

export interface PiMcpServerInput {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
}

/**
 * ACP session mcpServers → pi mcp.json。pi 1.2.0 原生读 <agentDir>/mcp.json；
 * ACP session/new 传参不会进 pi（pi-acp 只存不用），必须落盘。
 * exposure:"direct" 让工具直接声明给模型（默认 codemode 需脚本调用）。
 */
export function buildPiMcpJson(
  mcpServers: Record<string, PiMcpServerInput> | undefined,
): string | null {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const [name, srv] of Object.entries(mcpServers)) {
    if (srv.url) {
      out[name] = {
        url: srv.url,
        type: srv.type || "http",
        ...(srv.env && Object.keys(srv.env).length
          ? { headers: srv.env }
          : {}),
        exposure: "direct",
      };
    } else if (srv.command) {
      out[name] = {
        command: srv.command,
        args: srv.args ?? [],
        ...(srv.env && Object.keys(srv.env).length ? { env: srv.env } : {}),
        exposure: "direct",
      };
    }
  }
  return JSON.stringify({ mcpServers: out }, null, 2) + "\n";
}

/**
 * 写入 pi agent 目录配置（models/settings/mcp）。已存在的 mcp.json 以本次会话
 * 聚合结果整文件覆盖（会话级 MCP 与壳内其他引擎的 session/new 语义一致）。
 */
export function writePiAgentConfig(options: {
  agentDir: string;
  model?: PiModelConfigInput;
  mcpServers?: Record<string, PiMcpServerInput>;
}): { agentDir: string; wrote: string[] } {
  const { agentDir, model = {}, mcpServers } = options;
  fs.mkdirSync(agentDir, { recursive: true });
  const wrote: string[] = [];

  fs.writeFileSync(path.join(agentDir, "models.json"), buildPiModelsJson(model));
  wrote.push("models.json");

  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    buildPiSettingsJson(model),
  );
  wrote.push("settings.json");

  const mcpJson = buildPiMcpJson(mcpServers);
  if (mcpJson) {
    fs.writeFileSync(path.join(agentDir, "mcp.json"), mcpJson);
    wrote.push("mcp.json");
  }
  return { agentDir, wrote };
}
