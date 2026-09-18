/**
 * plan MCP server — 壳内 loopback Streamable HTTP 端点（stateless）
 *
 * 端点 http://127.0.0.1:{DEFAULT_PLAN_MCP_PORT}/mcp，仅监听回环。
 * stateless（sessionIdGenerator: undefined）：MCP 会话无状态，计划状态全在
 * PlanStore 按 planId 键控，由工具入参/返回携带——观测器在引擎侧 tool_call
 * update 上补会话关联（planModeService.observeToolUpdate）。
 *
 * 工具契约见 docs/20260918-plan-mode-via-mcp.md §4。工具描述即提示词层
 * 计划契约（先计划、经 submit 获批准、未批准不改文件）。
 */

import * as http from "http";
import log from "electron-log";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LOCALHOST_IP } from "@shared/constants";
import {
  PLAN_TOOL_CREATE,
  PLAN_TOOL_UPDATE,
  PLAN_TOOL_SUBMIT,
  type PlanEntry,
} from "@shared/planMode";
import type { PlanStore } from "./planStore";

/** submit 挂起兜底超时：审批链路断裂/无人应答时避免工具永久阻塞 */
const SUBMIT_TIMEOUT_MS = 10 * 60 * 1000;

const PLAN_CONTRACT_PROMPT =
  "Plan-mode contract: when the user asks to plan first or a plan approval is expected, " +
  "draft the plan with these tools and request approval via nuwax_plan_submit BEFORE " +
  "making any file changes. Do not modify files while a plan is unapproved.";

const entriesSchema = z.array(
  z.object({
    content: z.string().min(1),
    priority: z.enum(["high", "medium", "low"]).optional(),
    status: z.enum(["pending", "in_progress", "completed"]).optional(),
  }),
);

function buildToolSpecs(): Tool[] {
  return [
    {
      name: PLAN_TOOL_CREATE,
      description:
        `Create an execution plan (task breakdown) for the current work and return planId. ` +
        `${PLAN_CONTRACT_PROMPT}`,
      inputSchema: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            description: "Ordered plan entries (full snapshot)",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                priority: { type: "string", enum: ["high", "medium", "low"] },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["content"],
            },
          },
        },
        required: ["entries"],
      },
    },
    {
      name: PLAN_TOOL_UPDATE,
      description:
        "Update an existing plan (full entries replacement; keep planId from nuwax_plan_create). " +
        "Re-send the complete entry list including updated statuses (pending/in_progress/completed).",
      inputSchema: {
        type: "object",
        properties: {
          planId: { type: "string" },
          entries: entriesSchemaDescription(),
          changelog: {
            type: "string",
            description: "Optional short change note",
          },
        },
        required: ["planId", "entries"],
      },
    },
    {
      name: PLAN_TOOL_SUBMIT,
      description:
        `Submit the plan for user approval and WAIT for the decision. ` +
        `approved=true → proceed to execute the plan; approved=false → revise the plan per user feedback and resubmit. ` +
        `${PLAN_CONTRACT_PROMPT}`,
      inputSchema: {
        type: "object",
        properties: {
          planId: { type: "string" },
          summary: {
            type: "string",
            description: "Optional one-line plan summary",
          },
        },
        required: ["planId"],
      },
    },
  ];
}

function entriesSchemaDescription() {
  return {
    type: "array",
    description: "Full replacement entry list",
    items: {
      type: "object",
      properties: {
        content: { type: "string" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
        },
      },
      required: ["content"],
    },
  };
}

function okResult(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    // MCP 规范向后兼容：非 structuredContent 消费方读文本 JSON
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export interface PlanMcpServerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getUrl(): string | null;
  getPort(): number;
}

export function createPlanMcpServer(args: {
  store: PlanStore;
  port: number;
}): PlanMcpServerHandle {
  const { store, port } = args;
  let httpServer: http.Server | null = null;

  function createConnectedServer(): {
    server: Server;
    transport: StreamableHTTPServerTransport;
  } {
    const server = new Server(
      { name: "plan-mode-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: buildToolSpecs(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const rawArgs = (request.params.arguments ?? {}) as Record<
        string,
        unknown
      >;

      if (name === PLAN_TOOL_CREATE) {
        const parsed = entriesSchema.safeParse(rawArgs.entries);
        if (!parsed.success) {
          return errorResult(
            `nuwax_plan_create: invalid entries (${parsed.error.message})`,
          );
        }
        const record = store.createPlan(parsed.data as PlanEntry[]);
        return okResult({ planId: record.planId, revision: record.revision });
      }

      if (name === PLAN_TOOL_UPDATE) {
        if (typeof rawArgs.planId !== "string" || !rawArgs.planId) {
          return errorResult("nuwax_plan_update: planId is required");
        }
        const parsed = entriesSchema.safeParse(rawArgs.entries);
        if (!parsed.success) {
          return errorResult(
            `nuwax_plan_update: invalid entries (${parsed.error.message})`,
          );
        }
        const record = store.updatePlan(
          rawArgs.planId,
          parsed.data as PlanEntry[],
        );
        if (!record) {
          return errorResult(
            `nuwax_plan_update: unknown planId ${rawArgs.planId}`,
          );
        }
        return okResult({ planId: record.planId, revision: record.revision });
      }

      if (name === PLAN_TOOL_SUBMIT) {
        if (typeof rawArgs.planId !== "string" || !rawArgs.planId) {
          return errorResult("nuwax_plan_submit: planId is required");
        }
        const plan = store.getPlan(rawArgs.planId);
        if (!plan) {
          return errorResult(
            `nuwax_plan_submit: unknown planId ${rawArgs.planId}`,
          );
        }
        store.setStatus(rawArgs.planId, "submitted");
        log.info(
          `[PlanMode] submit pending approval: planId=${rawArgs.planId} revision=${plan.revision}`,
        );
        const decision = await store.waitSubmitDecision(
          rawArgs.planId,
          SUBMIT_TIMEOUT_MS,
        );
        return okResult({
          planId: rawArgs.planId,
          approved: decision.approved,
          ...(decision.feedback ? { feedback: decision.feedback } : {}),
        });
      }

      return errorResult(`Unknown tool: ${name}`);
    });

    // stateless：每请求独立 transport，无会话保持（状态在 PlanStore）
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    return { server, transport };
  }

  return {
    async start(): Promise<void> {
      if (httpServer) return;
      httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://${LOCALHOST_IP}`);
        if (url.pathname !== "/mcp") {
          res.writeHead(404).end();
          return;
        }
        if (req.method === "POST") {
          try {
            const { server, transport } = createConnectedServer();
            res.on("close", () => {
              transport.close().catch(() => undefined);
              server.close().catch(() => undefined);
            });
            await server.connect(transport);
            await transport.handleRequest(req, res);
          } catch (e) {
            log.error("[PlanMode] MCP request handling failed:", e);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
            }
            res.end(JSON.stringify({ error: "plan mcp internal error" }));
          }
          return;
        }
        // stateless 模式不支持 GET(SSE)/DELETE 会话语义
        res.writeHead(405).end();
      });
      await new Promise<void>((resolve, reject) => {
        httpServer!.once("error", reject);
        httpServer!.listen(port, LOCALHOST_IP, () => resolve());
      });
      log.info(
        `[PlanMode] MCP server listening on ${LOCALHOST_IP}:${port}/mcp`,
      );
    },

    async stop(): Promise<void> {
      const server = httpServer;
      httpServer = null;
      if (!server) return;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      log.info("[PlanMode] MCP server stopped");
    },

    isRunning(): boolean {
      return !!httpServer?.listening;
    },

    getUrl(): string | null {
      return this.isRunning() ? `http://${LOCALHOST_IP}:${port}/mcp` : null;
    },

    getPort(): number {
      return port;
    },
  };
}
