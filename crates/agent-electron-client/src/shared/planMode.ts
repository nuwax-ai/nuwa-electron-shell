/**
 * 计划模式（PLAN）共享类型与标记 — MCP 外挂式实现
 *
 * 设计约束（docs/20260918-plan-mode-via-mcp.md）：
 * - plan 不进 agentMode 状态机：`agent_mode="plan"` 仅作传输编码，
 *   壳侧视为独立开关标志（权限协调器前置闸），ask/yolo 审批链路零改动。
 * - 工具名带 `nuwax_plan_` 前缀，便于在引擎侧 tool_call title（各引擎前缀
 *   不一，如 mcp__plan__nuwax_plan_submit）与云端 SSE title 特判（ask_question/
 *   openui）之间保持无冲突匹配。
 */

/** plan MCP server 注入名（与 acpNewSessionParams 注入、本地 MCP 管理一致） */
export const PLAN_MCP_SERVER_ID = "plan";

/** plan 工具名前缀标记（title contains 匹配，兼容引擎侧任意 server 前缀） */
export const PLAN_TOOL_MARKER = "nuwax_plan_";

export const PLAN_TOOL_CREATE = "nuwax_plan_create";
export const PLAN_TOOL_UPDATE = "nuwax_plan_update";
export const PLAN_TOOL_SUBMIT = "nuwax_plan_submit";

/** 计划审批请求的 ACP toolCall.kind（自由字符串，云端整体透传） */
export const PLAN_APPROVAL_KIND = "plan_approval";

/** 计划审批 optionId 约定（应答载荷仅 optionId，语义在前端/壳两侧约定） */
export const PLAN_APPROVAL_OPTION_APPROVE = "approve";
export const PLAN_APPROVAL_OPTION_REVISE = "revise";

export type PlanEntryPriority = "high" | "medium" | "low";
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

/** 计划条目（对齐 ACP v2 PlanEntry 的字段面，status 由引擎侧重发 update 维护） */
export interface PlanEntry {
  content: string;
  priority?: PlanEntryPriority;
  status?: PlanEntryStatus;
}

export type PlanStatus = "draft" | "submitted" | "approved" | "rejected";

/** 判断引擎侧 tool_call title 是否为 plan 工具（title contains，兼容 mcp__plan__ 前缀） */
export function isPlanToolTitle(title: string | null | undefined): boolean {
  return !!title && title.includes(PLAN_TOOL_MARKER);
}
