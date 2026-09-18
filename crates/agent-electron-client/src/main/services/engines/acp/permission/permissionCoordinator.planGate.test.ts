/**
 * 计划模式外挂分支（⓪a plan 工具自动放行 / ⓪b plan 轮写类硬闸）单测。
 * 语义见 docs/20260918-plan-mode-via-mcp.md §5。
 */

import { describe, expect, it, vi } from "vitest";
import type { AcpPermissionRequest } from "../acpClient";
import { AcpPermissionCoordinator } from "./permissionCoordinator";

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@main/services/planMode/planModeService", () => ({
  planModeService: {
    hasApprovedPlan: (sessionId: string) => sessionId === "sess-approved",
  },
}));

function request(
  overrides: Partial<AcpPermissionRequest> = {},
): AcpPermissionRequest {
  return {
    sessionId: "sess-1",
    toolCall: {
      toolCallId: "tc-1",
      kind: "edit",
      title: "Edit",
      rawInput: { path: "/tmp/ws/a.txt" },
    },
    options: [
      { optionId: "opt-always", kind: "allow_always", name: "Always" },
      { optionId: "opt-once", kind: "allow_once", name: "Once" },
    ],
    ...overrides,
  };
}

const ctx = {
  strictEnabled: false,
  sandboxMode: "compat" as const,
  workspaceDir: "/tmp/ws",
  tempDirs: [],
};

describe("AcpPermissionCoordinator 计划模式分支", () => {
  it("plan 轮写类工具、计划未批准 → 硬闸拒绝", () => {
    const coordinator = new AcpPermissionCoordinator("test");
    coordinator.setEffectiveMode("sess-1", "plan");
    const decision = coordinator.evaluate(request(), ctx);
    expect(decision).toEqual({
      kind: "cancel",
      reason: "plan_mode_requires_approval",
    });
  });

  it("plan 轮写类工具、计划已批准 → 放行走既有 ask 链", () => {
    const coordinator = new AcpPermissionCoordinator("test");
    // planGate stub：sess-approved 恒已批准
    coordinator.setEffectiveMode("sess-approved", "plan");
    const decision = coordinator.evaluate(
      request({ sessionId: "sess-approved" }),
      ctx,
    );
    expect(decision).toEqual({ kind: "ask" });
  });

  it("ask/yolo 轮不受硬闸影响（ask → ask）", () => {
    const coordinator = new AcpPermissionCoordinator("test");
    coordinator.setEffectiveMode("sess-1", "ask");
    const decision = coordinator.evaluate(request(), ctx);
    expect(decision).toEqual({ kind: "ask" });
  });

  it("plan 轮非写类工具不被硬闸拦截", () => {
    const coordinator = new AcpPermissionCoordinator("test");
    coordinator.setEffectiveMode("sess-1", "plan");
    const decision = coordinator.evaluate(
      request({
        toolCall: {
          toolCallId: "tc-read",
          kind: "read",
          title: "Read",
          rawInput: { path: "/tmp/ws/a.txt" },
        },
      }),
      ctx,
    );
    expect(decision).toEqual({ kind: "ask" });
  });

  it("plan 工具（nuwax_plan_*）自动放行，不弹审批卡", () => {
    const coordinator = new AcpPermissionCoordinator("test");
    coordinator.setEffectiveMode("sess-1", "plan");
    const decision = coordinator.evaluate(
      request({
        toolCall: {
          toolCallId: "tc-plan",
          kind: "execute",
          title: "mcp__plan__nuwax_plan_create",
          rawInput: { entries: [] },
        },
      }),
      ctx,
    );
    expect(decision.kind).toBe("select");
    expect(decision.reason).toBe("plan_tool_auto_allow");
  });
});
