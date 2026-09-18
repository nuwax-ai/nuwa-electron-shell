/**
 * planModeService — 计划模式外挂门面（单例）
 *
 * 职责：
 * 1. plan MCP server 生命周期（serviceManager 编排启动，会话注入见 acpNewSessionParams）
 * 2. 观测器：从引擎侧 tool_call/tool_call_update 补会话关联、发射 plan 进度 SSE
 *    （云端既有词汇 subType=plan）与计划审批 SSE（复用 acpRequestPermission 形状 +
 *    approvalInterventionService 挂起，应答经云端通用路由 /computer/notify-resolved 唤醒）
 * 3. 硬闸查询：permissionCoordinator 前置闸读 hasApprovedPlan
 *
 * 契约：docs/20260918-plan-mode-via-mcp.md。零后端改动；plan 不进 agentMode 状态机。
 */

import log from "electron-log";
import { DEFAULT_PLAN_MCP_PORT } from "@shared/constants";
import {
  PLAN_APPROVAL_KIND,
  PLAN_APPROVAL_OPTION_APPROVE,
  PLAN_APPROVAL_OPTION_REVISE,
  PLAN_TOOL_CREATE,
  PLAN_TOOL_SUBMIT,
  PLAN_TOOL_UPDATE,
  isPlanToolTitle,
  type PlanEntry,
} from "@shared/planMode";
import type { AcpSessionUpdate } from "../engines/acp/acpClient";
import { approvalInterventionService } from "../intervention";
import { toComputerPermissionProgressData } from "../intervention/computerPermissionProtocol";
import { PlanStore } from "./planStore";
import { createPlanMcpServer, type PlanMcpServerHandle } from "./planMcpServer";

/** computer:progress 发射回调（acpEngine 注入 this.emit 绑定） */
export type PlanProgressEmitter = (payload: Record<string, unknown>) => void;

export interface ObserveToolUpdateArgs {
  acpSessionId: string;
  engineName: string;
  update: AcpSessionUpdate;
  emit: PlanProgressEmitter;
}

/** toolCallId → plan 工具名缓存（tool_call_update 可能不带 title） */
const MAX_TRACKED_TOOL_CALLS = 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return null;
}

function extractPlanId(source: unknown): string | null {
  const record = asRecord(source);
  if (!record) return null;
  if (typeof record.planId === "string" && record.planId) return record.planId;
  // MCP CallToolResult 形态兜底（structuredContent / content[0].text 内嵌 JSON）
  const nested = asRecord(record.structuredContent);
  if (nested?.planId && typeof nested.planId === "string") return nested.planId;
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      const partRecord = asRecord(part);
      const text = partRecord?.text;
      if (typeof text === "string") {
        const parsed = asRecord(text);
        if (parsed?.planId && typeof parsed.planId === "string") {
          return parsed.planId;
        }
      }
    }
  }
  return null;
}

export class PlanModeService {
  readonly store = new PlanStore();
  private server: PlanMcpServerHandle | null = null;
  private planToolCalls = new Map<string, string>();
  /** submit 审批注册去重：toolCallId → interventionId */
  private registeredSubmits = new Map<string, string>();

  // === 生命周期（serviceManager 编排） ===

  async start(): Promise<void> {
    if (this.server?.isRunning()) return;
    if (!this.server) {
      this.server = createPlanMcpServer({
        store: this.store,
        port: DEFAULT_PLAN_MCP_PORT,
      });
    }
    await this.server.start();
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.store.destroy();
    this.planToolCalls.clear();
    this.registeredSubmits.clear();
  }

  isRunning(): boolean {
    return !!this.server?.isRunning();
  }

  getUrl(): string | null {
    return this.server?.getUrl() ?? null;
  }

  // === 硬闸查询 / 轮次生命周期（acpEngine 与 coordinator 调用） ===

  hasApprovedPlan(acpSessionId: string): boolean {
    return this.store.hasApprovedPlan(acpSessionId);
  }

  beginPlanTurn(acpSessionId: string): void {
    this.store.beginPlanTurn(acpSessionId);
  }

  endPlanTurn(acpSessionId: string): void {
    this.store.endPlanTurn(acpSessionId);
  }

  clearSession(acpSessionId: string): void {
    this.store.clearSession(acpSessionId);
  }

  destroy(): void {
    this.store.destroy();
    this.planToolCalls.clear();
    this.registeredSubmits.clear();
  }

  // === 观测器 ===

  /**
   * acpEngine.handleAcpSessionUpdate 对 tool_call/tool_call_update 的透传钩子。
   * 负责：会话关联、plan 进度 SSE、submit 审批注册与 SSE。
   */
  observeToolUpdate(args: ObserveToolUpdateArgs): void {
    const { acpSessionId, engineName, update, emit } = args;
    if (
      update.sessionUpdate !== "tool_call" &&
      update.sessionUpdate !== "tool_call_update"
    ) {
      return;
    }
    const toolUpdate = update as Record<string, unknown>;
    const toolCallId =
      typeof toolUpdate.toolCallId === "string" ? toolUpdate.toolCallId : null;
    const title =
      typeof toolUpdate.title === "string" ? toolUpdate.title : null;
    const status =
      typeof toolUpdate.status === "string" ? toolUpdate.status : null;

    const toolName = this.resolvePlanToolName(toolCallId, title);
    if (!toolName) return;
    if (toolCallId) this.trackToolCall(toolCallId, toolName);

    if (toolName === PLAN_TOOL_CREATE && status === "completed") {
      const planId = extractPlanId(toolUpdate.rawOutput);
      if (planId) {
        this.store.bindSession(acpSessionId, planId);
        this.emitPlanProgress(acpSessionId, planId, emit);
      }
      return;
    }

    if (toolName === PLAN_TOOL_UPDATE) {
      const planId = extractPlanId(toolUpdate.rawInput);
      if (planId) {
        this.store.bindSession(acpSessionId, planId);
        if (status === "completed") {
          this.emitPlanProgress(acpSessionId, planId, emit);
        }
      }
      return;
    }

    if (toolName === PLAN_TOOL_SUBMIT && toolCallId) {
      if (status === "completed") return; // 审批决定已出，仅收尾事件
      if (this.registeredSubmits.has(toolCallId)) return; // 幂等
      const planId = extractPlanId(toolUpdate.rawInput);
      if (!planId) {
        log.warn(
          `[PlanMode] submit observed without planId, skip approval registration: toolCallId=${toolCallId}`,
        );
        return;
      }
      this.registerSubmitApproval({
        acpSessionId,
        engineName,
        toolCallId,
        planId,
        emit,
      });
    }
  }

  private resolvePlanToolName(
    toolCallId: string | null,
    title: string | null,
  ): string | null {
    if (title && isPlanToolTitle(title)) {
      if (title.includes(PLAN_TOOL_CREATE)) return PLAN_TOOL_CREATE;
      if (title.includes(PLAN_TOOL_UPDATE)) return PLAN_TOOL_UPDATE;
      if (title.includes(PLAN_TOOL_SUBMIT)) return PLAN_TOOL_SUBMIT;
      return null;
    }
    if (toolCallId) {
      return this.planToolCalls.get(toolCallId) ?? null;
    }
    return null;
  }

  private trackToolCall(toolCallId: string, toolName: string): void {
    if (this.planToolCalls.size >= MAX_TRACKED_TOOL_CALLS) {
      const oldest = this.planToolCalls.keys().next().value;
      if (oldest) this.planToolCalls.delete(oldest);
    }
    this.planToolCalls.set(toolCallId, toolName);
  }

  private emitPlanProgress(
    acpSessionId: string,
    planId: string,
    emit: PlanProgressEmitter,
  ): void {
    const plan = this.store.getPlan(planId);
    if (!plan || plan.entries.length === 0) return;
    // 云端既有词汇：subType=plan → ComponentTypeEnum.Plan，data.entries 原样透传
    emit({
      sessionId: acpSessionId,
      acpSessionId,
      messageType: "plan",
      subType: "plan",
      data: { entries: plan.entries },
      timestamp: new Date().toISOString(),
    });
  }

  private registerSubmitApproval(args: {
    acpSessionId: string;
    engineName: string;
    toolCallId: string;
    planId: string;
    emit: PlanProgressEmitter;
  }): void {
    const { acpSessionId, engineName, toolCallId, planId, emit } = args;
    const plan = this.store.getPlan(planId);
    const entries: PlanEntry[] = plan?.entries ?? [];
    this.store.bindSession(acpSessionId, planId);
    this.store.setStatus(planId, "submitted");

    // 合成 ACP 审批请求：kind=plan_approval 自由字符串（云端整体透传），
    // options 即前端按钮（应答载荷仅 optionId）
    const acpRequest = {
      sessionId: acpSessionId,
      toolCall: {
        toolCallId,
        title: PLAN_TOOL_SUBMIT,
        kind: PLAN_APPROVAL_KIND,
        rawInput: {
          planId,
          revision: plan?.revision ?? 1,
          entries,
        },
      },
      options: [
        {
          optionId: PLAN_APPROVAL_OPTION_APPROVE,
          kind: "allow_once" as const,
          name: "Approve",
        },
        {
          optionId: PLAN_APPROVAL_OPTION_REVISE,
          kind: "reject_once" as const,
          name: "Revise",
        },
      ],
    };

    const { interventionRequest, acpResponsePromise } =
      approvalInterventionService.createPending({
        engine: engineName,
        appSessionId: acpSessionId,
        acpSessionId,
        acpRequest,
      });
    this.registeredSubmits.set(toolCallId, interventionRequest.id);
    log.info(
      `[PlanMode] Plan approval pending: intervention=${interventionRequest.id} session=${acpSessionId} planId=${planId} entries=${entries.length}`,
    );

    // 形状复刻 acpEngine.handlePermissionRequest 的审批发射（data 整体透传）
    emit({
      sessionId: acpSessionId,
      acpSessionId,
      messageType: "acpRequestPermission",
      subType: "request_permission",
      data: {
        ...toComputerPermissionProgressData({
          acpRequest,
          interventionId: interventionRequest.id,
          revision: interventionRequest.revision,
        }),
        _intervention: interventionRequest,
        _engine: engineName,
      },
      timestamp: new Date().toISOString(),
    });

    void acpResponsePromise
      .then((response) => {
        const outcome = response.outcome;
        if (
          outcome.outcome === "selected" &&
          outcome.optionId === PLAN_APPROVAL_OPTION_APPROVE
        ) {
          this.store.markApproved(acpSessionId, planId);
          this.store.decideSubmit(planId, { approved: true });
          log.info(
            `[PlanMode] Plan approved: session=${acpSessionId} planId=${planId}`,
          );
        } else if (outcome.outcome === "selected") {
          // revise：回到待修订，用户下一条消息即修订意见
          this.store.setStatus(planId, "rejected");
          this.store.decideSubmit(planId, {
            approved: false,
            feedback: "User requested plan revision",
          });
          log.info(
            `[PlanMode] Plan revision requested: session=${acpSessionId} planId=${planId}`,
          );
        } else {
          this.store.setStatus(planId, "draft");
          this.store.decideSubmit(planId, {
            approved: false,
            feedback: "approval cancelled",
          });
          log.info(
            `[PlanMode] Plan approval cancelled: session=${acpSessionId} planId=${planId}`,
          );
        }
      })
      .catch((e) => {
        this.store.setStatus(planId, "draft");
        this.store.decideSubmit(planId, {
          approved: false,
          feedback: "approval failed",
        });
        log.error("[PlanMode] Plan approval promise rejected:", e);
      })
      .finally(() => {
        this.registeredSubmits.delete(toolCallId);
      });
  }
}

export const planModeService = new PlanModeService();
