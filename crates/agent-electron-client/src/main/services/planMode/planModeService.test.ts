/**
 * planModeService 观测器测试：会话关联、SSE 形状对拍（云端 onEvent 白名单基准：
 * SandboxAgentClient.java 的 subType=plan / request_permission 分支）、
 * submit 审批注册与 notify-resolved 应答全回路映射。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionUpdate } from "../engines/acp/acpClient";

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("electron-log/main", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../system/deviceId", () => ({
  getDeviceId: () => "device-test",
}));

import { PlanModeService } from "./planModeService";
import { approvalInterventionService } from "../intervention";

function toolUpdate(partial: {
  sessionUpdate?: "tool_call" | "tool_call_update";
  toolCallId: string;
  title: string;
  status: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}): AcpSessionUpdate {
  return {
    sessionUpdate: partial.sessionUpdate ?? "tool_call_update",
    toolCallId: partial.toolCallId,
    title: partial.title,
    status: partial.status,
    ...(partial.rawInput !== undefined ? { rawInput: partial.rawInput } : {}),
    ...(partial.rawOutput !== undefined
      ? { rawOutput: partial.rawOutput }
      : {}),
  } as AcpSessionUpdate;
}

describe("PlanModeService 观测器", () => {
  let service: PlanModeService;
  let emitted: Array<Record<string, unknown>>;

  beforeEach(() => {
    service = new PlanModeService();
    emitted = [];
    approvalInterventionService.destroy();
  });

  const observe = (update: AcpSessionUpdate, session = "sess-1") =>
    service.observeToolUpdate({
      acpSessionId: session,
      engineName: "claude-code",
      update,
      emit: (payload) => emitted.push(payload),
    });

  it("create 完成：绑定会话并发射云端 plan 词汇（subType=plan + data.entries）", () => {
    const plan = service.store.createPlan([
      { content: "步骤一" },
      { content: "步骤二", status: "completed" },
    ]);
    observe(
      toolUpdate({
        toolCallId: "tc-create",
        title: "mcp__plan__nuwax_plan_create",
        status: "completed",
        rawOutput: JSON.stringify({ planId: plan.planId, revision: 1 }),
      }),
    );

    expect(service.store.getSessionPlan("sess-1")?.planId).toBe(plan.planId);
    expect(emitted).toHaveLength(1);
    const event = emitted[0];
    expect(event.messageType).toBe("plan");
    expect(event.subType).toBe("plan");
    expect(event.sessionId).toBe("sess-1");
    const data = event.data as { entries: Array<{ content: string }> };
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].content).toBe("步骤一");
  });

  it("update 完成：经 rawInput.planId 绑定并发射最新条目", () => {
    const plan = service.store.createPlan([{ content: "a" }]);
    service.store.updatePlan(plan.planId, [{ content: "a2" }]);
    observe(
      toolUpdate({
        toolCallId: "tc-update",
        title: "mcp__plan__nuwax_plan_update",
        status: "completed",
        rawInput: { planId: plan.planId, entries: [{ content: "a2" }] },
      }),
    );
    expect(emitted).toHaveLength(1);
    const data = emitted[0].data as { entries: Array<{ content: string }> };
    expect(data.entries[0].content).toBe("a2");
  });

  it("非 plan 工具与延迟外形状不产生事件", () => {
    observe(
      toolUpdate({
        toolCallId: "tc-x",
        title: "Bash",
        status: "completed",
        rawOutput: "ok",
      }),
    );
    expect(emitted).toHaveLength(0);
  });

  it("submit 挂起：注册审批并发射 acpRequestPermission 形状；approve 应答经 notify-resolved 回路放行", async () => {
    const plan = service.store.createPlan([{ content: "步骤一" }]);
    const decisionPromise = service.store.waitSubmitDecision(plan.planId, 5000);

    observe(
      toolUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-submit",
        title: "mcp__plan__nuwax_plan_submit",
        status: "in_progress",
        rawInput: { planId: plan.planId },
      }),
    );

    // 云端白名单对拍的审批事件形状
    const approvalEvent = emitted.find(
      (e) => e.messageType === "acpRequestPermission",
    );
    expect(approvalEvent).toBeTruthy();
    expect(approvalEvent?.subType).toBe("request_permission");
    const data = approvalEvent?.data as Record<string, any>;
    expect(data.tool_call_id).toBe("tc-submit");
    expect(data.request_permission_request.toolCall.kind).toBe("plan_approval");
    expect(data.request_permission_request.toolCall.rawInput.planId).toBe(
      plan.planId,
    );
    const options = data.request_permission_request.options as Array<{
      optionId: string;
    }>;
    expect(options.map((o) => o.optionId).sort()).toEqual([
      "approve",
      "revise",
    ]);

    // 云端应答 → 壳 notify-resolved 载荷形状（permission_resolve_request 信封）
    const resolveResult =
      approvalInterventionService.resolveFromComputerPermissionCallback({
        permission_resolve_request: {
          session_id: "sess-1",
          tool_call_id: "tc-submit",
          request_permission_response: {
            outcome: { optionId: "approve", outcome: "selected" },
          },
        },
      });
    expect(resolveResult.ok).toBe(true);

    const decision = await decisionPromise;
    expect(decision.approved).toBe(true);
    expect(service.store.hasApprovedPlan("sess-1")).toBe(true);
    expect(service.store.getPlan(plan.planId)?.status).toBe("approved");
  });

  it("revise 应答：计划回到 rejected，submit 返回 approved:false", async () => {
    const plan = service.store.createPlan([{ content: "a" }]);
    const decisionPromise = service.store.waitSubmitDecision(plan.planId, 5000);

    observe(
      toolUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-submit-2",
        title: "mcp__plan__nuwax_plan_submit",
        status: "in_progress",
        rawInput: { planId: plan.planId },
      }),
    );

    approvalInterventionService.resolveFromComputerPermissionCallback({
      permission_resolve_request: {
        session_id: "sess-1",
        tool_call_id: "tc-submit-2",
        request_permission_response: {
          outcome: { optionId: "revise", outcome: "selected" },
        },
      },
    });

    const decision = await decisionPromise;
    expect(decision.approved).toBe(false);
    expect(decision.feedback).toBeTruthy();
    expect(service.store.getPlan(plan.planId)?.status).toBe("rejected");
    expect(service.store.hasApprovedPlan("sess-1")).toBe(false);
  });

  it("submit 幂等：同 toolCallId 重复观测不重复注册", () => {
    const plan = service.store.createPlan([{ content: "a" }]);
    for (let i = 0; i < 3; i++) {
      observe(
        toolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc-submit-3",
          title: "mcp__plan__nuwax_plan_submit",
          status: "in_progress",
          rawInput: { planId: plan.planId },
        }),
      );
    }
    const approvalEvents = emitted.filter(
      (e) => e.messageType === "acpRequestPermission",
    );
    expect(approvalEvents).toHaveLength(1);
  });

  it("title 缺失的 tool_call_update 经 toolCallId 缓存仍可识别", () => {
    const plan = service.store.createPlan([{ content: "a" }]);
    // 先带 title 的 tool_call（缓存 toolCallId → 工具名）
    observe(
      toolUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-submit-4",
        title: "mcp__plan__nuwax_plan_submit",
        status: "pending",
        rawInput: { planId: plan.planId },
      }),
    );
    // 再来不带 title 的 update（nuwaxcode/claude 形态差异）
    observe(
      toolUpdate({
        toolCallId: "tc-submit-4",
        title: "",
        status: "in_progress",
        rawInput: { planId: plan.planId },
      }) as unknown as AcpSessionUpdate,
    );
    const approvalEvents = emitted.filter(
      (e) => e.messageType === "acpRequestPermission",
    );
    expect(approvalEvents).toHaveLength(1);
  });

  it("轮次生命周期透传", () => {
    const plan = service.store.createPlan([{ content: "a" }]);
    service.store.bindSession("sess-1", plan.planId);
    service.store.markApproved("sess-1", plan.planId);
    expect(service.hasApprovedPlan("sess-1")).toBe(true);
    service.beginPlanTurn("sess-1");
    expect(service.hasApprovedPlan("sess-1")).toBe(false);
  });
});
