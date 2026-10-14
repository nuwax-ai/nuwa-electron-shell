import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildEffectiveConfig } from "../requestConfigResolver";
import type { AgentEngineType } from "../types";
import type { ComputerChatRequest } from "@shared/types/computerTypes";
import {
  resolveSessionForChat,
  type AcpSessionLike,
  type SessionSetupDeps,
} from "./acpSessionSetup";
import { collectSessionWorkspaceCandidates } from "./acpSessionWorkspace";

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ttyd-session-cwd-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function sessionHarness(engine: AgentEngineType, baseWorkspace: string) {
  const sessions = new Map<string, AcpSessionLike>();
  const deps: SessionSetupDeps = {
    logTag: "[test]",
    workspaceDir: baseWorkspace,
    engineName: engine,
    agentCapabilities: null,
    getSession: (id) => sessions.get(id),
    findSessionByProjectId: (id) =>
      [...sessions.values()].find(
        (session) =>
          session.id === id ||
          session.acpSessionId === id ||
          session.projectId === id,
      ) ?? null,
    loadSession: async () => {
      throw new Error("unexpected session/load");
    },
    // 仅模拟 ACP 外部 RPC；cwd/title 完全取自实际 resolveSessionForChat 的请求参数。
    createSession: async (opts) => {
      const id = `ses_${sessions.size + 1}`;
      sessions.set(id, {
        id,
        acpSessionId: id,
        cwd: opts.cwd,
        title: opts.title,
        createdAt: 1,
        status: "idle",
      });
      return { id };
    },
    getSessionRecord: (id) => sessions.get(id)!,
  };
  const send = (request: ComputerChatRequest) => {
    const config = buildEffectiveConfig({
      base: { engine, workspaceDir: baseWorkspace },
      requiredEngine: engine,
      mp: undefined,
      model: "test",
      resolvedEnv: undefined,
      freshMcpServers: undefined,
      request,
      engineKey: request.agent_work_dir || request.project_id || "default",
    });
    return resolveSessionForChat(
      { ...deps, workspaceDir: config.workspaceDir },
      request,
    );
  };
  return {
    send,
    sessions,
    candidates: (id: string) =>
      collectSessionWorkspaceCandidates(sessions.values(), id),
  };
}

describe.each<AgentEngineType>(["claude-code", "nuwaxcode", "codex-cli"])(
  "%s 终端 session cwd",
  (engine) => {
    it.each([false, true])(
      "真实会话配置链：absolute=%s，两会话目录区分且允许空目录",
      async (absolute) => {
        const base = fs.mkdtempSync(path.join(tmpRoot, `${engine}-`));
        const harness = sessionHarness(engine, base);
        for (const id of ["1694106", "1694107"]) {
          const expected = absolute
            ? path.join(base, `中文工作区-${id}`)
            : path.join(base, "computer-project-workspace", "u1", id);
          fs.mkdirSync(expected, { recursive: true });
          const { session } = await harness.send({
            user_id: "u1",
            project_id: id,
            prompt: "hi",
            ...(absolute ? { agent_work_dir: expected } : {}),
          });
          expect(session.cwd).toBe(expected);
          expect(harness.candidates(id)).toEqual([expected]);
          expect(fs.readdirSync(expected)).toEqual([]);
        }
        expect(harness.candidates("1694106")).not.toEqual(
          harness.candidates("1694107"),
        );
        expect(harness.candidates("not-recovered")).toEqual([]);
        // 删除/清理 session 后关联随它失效，不保留指向已经销毁引擎的全局映射。
        harness.sessions.clear();
        expect(harness.candidates("1694106")).toEqual([]);
      },
    );

    it("同工作目录、不同对话各自独立会话，cwd 仍共享该目录（A2）", async () => {
      const base = fs.mkdtempSync(path.join(tmpRoot, `${engine}-shared-`));
      const harness = sessionHarness(engine, base);
      for (const id of ["1694106", "1694107", "1694106"]) {
        await harness.send({
          user_id: "u1",
          project_id: id,
          agent_work_dir: base,
          prompt: "hi",
        });
      }
      // A2：不同 conversationId 各自独立会话，不再按 agent_work_dir 归并复用（这正是
      // 同项目多对话互相抢占的根因）；第三次重复 1694106 复用其自身会话，故共 2 个。
      expect(harness.sessions.size).toBe(2);
      const byProject = new Map(
        [...harness.sessions.values()].map((s) => [s.projectId, s]),
      );
      const s106 = byProject.get("1694106");
      const s107 = byProject.get("1694107");
      expect(s106).toBeDefined();
      expect(s107).toBeDefined();
      expect(s106!.id).not.toBe(s107!.id);
      // session.projectId 归一为 conversationId，不再被绝对路径 agent_work_dir 覆盖；
      // 各会话仅保留自身对话标识。
      expect(s106!.requestProjectIds).toEqual(["1694106"]);
      expect(s107!.requestProjectIds).toEqual(["1694107"]);
      // cwd 仍取自 agent_work_dir（同项目共享工作目录），终端按各自 conversationId
      // 均能解析到 base——agent_work_dir 归属未被篡改。
      expect(s106!.cwd).toBe(base);
      expect(s107!.cwd).toBe(base);
      expect(harness.candidates("1694106")).toEqual([base]);
      expect(harness.candidates("1694107")).toEqual([base]);
    });
  },
);

it("候选目录保留歧义，缺 cwd 的会话不会伪造目录", () => {
  expect(
    collectSessionWorkspaceCandidates(
      [
        { id: "s1", requestProjectIds: ["p1"], cwd: "/first" },
        { id: "s2", requestProjectIds: ["p1"], cwd: "/second" },
        { id: "s3", requestProjectIds: ["p1"] },
      ],
      "p1",
    ),
  ).toEqual(["/first", "/second"]);
  expect(
    collectSessionWorkspaceCandidates([{ id: "s1", projectId: "p1" }], "p1"),
  ).toEqual([]);
});
