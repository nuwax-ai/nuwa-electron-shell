import { describe, expect, it } from "vitest";
import { PlanStore, sanitizeEntries } from "./planStore";

describe("PlanStore", () => {
  it("createPlan 生成 draft 计划并清洗条目", () => {
    const store = new PlanStore();
    const plan = store.createPlan([
      { content: "步骤一" },
      { content: "  ", priority: "high" }, // 空内容 → 丢弃
      { content: "步骤二", priority: "high", status: "completed" },
      null, // 非法条目 → 丢弃
    ]);
    expect(plan.status).toBe("draft");
    expect(plan.revision).toBe(1);
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries[0]).toEqual({ content: "步骤一" });
    expect(plan.entries[1].priority).toBe("high");
    expect(plan.entries[1].status).toBe("completed");
  });

  it("updatePlan 全量替换并自增 revision；submitted 态收到更新回到 draft", () => {
    const store = new PlanStore();
    const plan = store.createPlan([{ content: "a" }]);
    store.setStatus(plan.planId, "submitted");
    const updated = store.updatePlan(plan.planId, [
      { content: "b" },
      { content: "c" },
    ]);
    expect(updated?.revision).toBe(2);
    expect(updated?.status).toBe("draft");
    expect(updated?.entries).toHaveLength(2);
    expect(store.updatePlan("plan_missing", [])).toBeNull();
  });

  it("submit 挂起与决定：approve/reject/超时/顶替", async () => {
    const store = new PlanStore();
    const plan = store.createPlan([{ content: "a" }]);

    // approve
    const p1 = store.waitSubmitDecision(plan.planId, 5000);
    store.decideSubmit(plan.planId, { approved: true });
    await expect(p1).resolves.toEqual({ approved: true });

    // reject（带 feedback）
    const p2 = store.waitSubmitDecision(plan.planId, 5000);
    store.decideSubmit(plan.planId, { approved: false, feedback: "revise" });
    await expect(p2).resolves.toEqual({ approved: false, feedback: "revise" });

    // 同 planId 再次挂起会顶替前一个（前一个收到 superseded）
    const p3 = store.waitSubmitDecision(plan.planId, 5000);
    const p4 = store.waitSubmitDecision(plan.planId, 5000);
    await expect(p3).resolves.toEqual({
      approved: false,
      feedback: "superseded",
    });
    store.decideSubmit(plan.planId, { approved: true });
    await expect(p4).resolves.toEqual({ approved: true });

    // 超时兜底
    const p5 = store.waitSubmitDecision(plan.planId, 20);
    await expect(p5).resolves.toMatchObject({
      approved: false,
      feedback: "approval timed out",
    });
  });

  it("轮次生命周期：markApproved 后 beginPlanTurn 重置、clearSession 清理", () => {
    const store = new PlanStore();
    const sid = "sess-1";
    const plan = store.createPlan([{ content: "a" }]);
    store.bindSession(sid, plan.planId);

    expect(store.hasApprovedPlan(sid)).toBe(false);
    store.markApproved(sid, plan.planId);
    expect(store.hasApprovedPlan(sid)).toBe(true);
    expect(store.getPlan(plan.planId)?.status).toBe("approved");

    // 新一轮 plan 请求：重置批准
    store.beginPlanTurn(sid);
    expect(store.hasApprovedPlan(sid)).toBe(false);

    // 会话清理：挂起被唤醒、绑定被清
    store.markApproved(sid, plan.planId);
    store.clearSession(sid);
    expect(store.hasApprovedPlan(sid)).toBe(false);
    expect(store.getSessionPlan(sid)).toBeNull();
  });

  it("sanitizeEntries 截断超限条目", () => {
    const entries = sanitizeEntries(
      Array.from({ length: 60 }, (_, i) => ({ content: `s${i}` })),
    );
    expect(entries).toHaveLength(50);
  });
});
