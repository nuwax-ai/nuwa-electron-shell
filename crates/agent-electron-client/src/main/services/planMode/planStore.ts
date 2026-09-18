/**
 * PlanStore — 计划模式状态机（纯逻辑，无 I/O）
 *
 * 状态按 planId 键控（MCP stateless 连接无会话语境，工具入参/返回携带 planId），
 * 会话关联（acpSessionId → planId）由观测器（planModeService.observeToolUpdate）
 * 在引擎侧 tool_call update 上补齐。submit 的「挂起等审批」在此实现：
 * 工具处理器 await waitSubmitDecision，审批应答/取消经 decideSubmit 唤醒。
 */

import { randomUUID } from "crypto";
import type { PlanEntry, PlanStatus } from "@shared/planMode";

export interface PlanRecord {
  planId: string;
  entries: PlanEntry[];
  status: PlanStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SubmitDecision {
  approved: boolean;
  feedback?: string;
}

/** 单计划条目数/内容长度上限（防御性收口，模型可能超发） */
const MAX_ENTRIES = 50;
const MAX_ENTRY_CONTENT_LENGTH = 2000;
/** 计划记录数软上限（超出淘汰最旧，防长会话内存增长） */
const MAX_PLANS = 200;

export class PlanStore {
  private plans = new Map<string, PlanRecord>();
  /** 会话 → 当前计划（最新一次绑定为准） */
  private sessionPlans = new Map<string, string>();
  /** 已批准计划的会话集合（beginPlanTurn 重置；硬闸放行依据） */
  private approvedSessions = new Set<string>();
  /** submit 挂起：planId → { resolve, timer } */
  private pendingSubmits = new Map<
    string,
    {
      resolve: (d: SubmitDecision) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  // === 计划 CRUD ===

  createPlan(rawEntries: unknown): PlanRecord {
    const entries = sanitizeEntries(rawEntries);
    const now = Date.now();
    const record: PlanRecord = {
      planId: `plan_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      entries,
      status: "draft",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(record.planId, record);
    if (this.plans.size > MAX_PLANS) {
      const oldest = this.plans.keys().next().value;
      if (oldest) this.plans.delete(oldest);
    }
    return record;
  }

  updatePlan(planId: string, rawEntries: unknown): PlanRecord | null {
    const record = this.plans.get(planId);
    if (!record) return null;
    record.entries = sanitizeEntries(rawEntries);
    record.revision += 1;
    record.updatedAt = Date.now();
    // submit 挂起期间收到更新视为撤回重拟（防御：正常时序 revise 先唤醒 submit）
    if (record.status === "submitted") {
      record.status = "draft";
    }
    return record;
  }

  getPlan(planId: string): PlanRecord | null {
    return this.plans.get(planId) ?? null;
  }

  setStatus(planId: string, status: PlanStatus): void {
    const record = this.plans.get(planId);
    if (record) {
      record.status = status;
      record.updatedAt = Date.now();
    }
  }

  // === 会话关联（观测器补齐） ===

  bindSession(acpSessionId: string, planId: string): void {
    if (!this.plans.has(planId)) return;
    this.sessionPlans.set(acpSessionId, planId);
  }

  getSessionPlan(acpSessionId: string): PlanRecord | null {
    const planId = this.sessionPlans.get(acpSessionId);
    return planId ? (this.plans.get(planId) ?? null) : null;
  }

  // === 硬闸查询 / 轮次生命周期 ===

  hasApprovedPlan(acpSessionId: string): boolean {
    return this.approvedSessions.has(acpSessionId);
  }

  /** agent_mode="plan" 的 chat 请求到达：重置批准标记（新一轮需重新提交计划） */
  beginPlanTurn(acpSessionId: string): void {
    this.approvedSessions.delete(acpSessionId);
  }

  /** agent_mode 回到 ask/yolo：清批准标记（闸门本身由 mode 判定，此处仅清状态） */
  endPlanTurn(acpSessionId: string): void {
    this.approvedSessions.delete(acpSessionId);
  }

  markApproved(acpSessionId: string, planId: string): void {
    this.setStatus(planId, "approved");
    if (this.sessionPlans.get(acpSessionId) === planId) {
      this.approvedSessions.add(acpSessionId);
    }
  }

  // === submit 挂起 ===

  /**
   * 挂起等待审批决定。timeoutMs 兜底（防观测器缺席/审批链路断裂时工具永久阻塞），
   * 到时返回 approved:false。
   */
  waitSubmitDecision(
    planId: string,
    timeoutMs: number,
  ): Promise<SubmitDecision> {
    this.cancelPendingSubmit(planId, {
      approved: false,
      feedback: "superseded",
    });
    return new Promise<SubmitDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSubmits.delete(planId);
        resolve({ approved: false, feedback: "approval timed out" });
      }, timeoutMs);
      this.pendingSubmits.set(planId, { resolve, timer });
    });
  }

  decideSubmit(planId: string, decision: SubmitDecision): void {
    const pending = this.pendingSubmits.get(planId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSubmits.delete(planId);
    pending.resolve(decision);
  }

  /** 唤醒该会话全部挂起 submit（turn 取消/会话清理路径） */
  decideSubmitsForSession(
    acpSessionId: string,
    decision: SubmitDecision,
  ): void {
    const planId = this.sessionPlans.get(acpSessionId);
    if (planId) this.decideSubmit(planId, decision);
  }

  hasPendingSubmit(planId: string): boolean {
    return this.pendingSubmits.has(planId);
  }

  private cancelPendingSubmit(planId: string, decision: SubmitDecision): void {
    const pending = this.pendingSubmits.get(planId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSubmits.delete(planId);
    pending.resolve(decision);
  }

  // === 清理 ===

  clearSession(acpSessionId: string): void {
    this.decideSubmitsForSession(acpSessionId, {
      approved: false,
      feedback: "session cleared",
    });
    this.sessionPlans.delete(acpSessionId);
    this.approvedSessions.delete(acpSessionId);
  }

  /** 引擎销毁收尾：唤醒全部挂起并清空状态 */
  destroy(): void {
    for (const [planId, pending] of this.pendingSubmits) {
      clearTimeout(pending.timer);
      pending.resolve({ approved: false, feedback: "destroyed" });
      this.pendingSubmits.delete(planId);
    }
    this.plans.clear();
    this.sessionPlans.clear();
    this.approvedSessions.clear();
  }
}

/** 条目清洗：保留合法条目、丢弃空内容、截断超限（不因个别坏条目整体失败） */
export function sanitizeEntries(raw: unknown): PlanEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: PlanEntry[] = [];
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.content !== "string" || !record.content.trim()) continue;
    const entry: PlanEntry = {
      content: record.content.slice(0, MAX_ENTRY_CONTENT_LENGTH),
    };
    if (
      record.priority === "high" ||
      record.priority === "medium" ||
      record.priority === "low"
    ) {
      entry.priority = record.priority;
    }
    if (
      record.status === "pending" ||
      record.status === "in_progress" ||
      record.status === "completed"
    ) {
      entry.status = record.status;
    }
    entries.push(entry);
  }
  return entries;
}
