import { ipcMain } from "electron";
import { agentService } from "../services/engines/unifiedAgent";
import {
  chatDispatchCoordinator,
  resolveChatDispatchKey,
  type ChatDispatchContext,
} from "../services/computer/chatDispatchCoordinator";
import { validateAgentWorkDirInput } from "../services/computer/agentWorkDir";
import type {
  ComputerChatRequest,
  ComputerAgentStatusResponse,
  ComputerAgentStopResponse,
  ComputerAgentCancelResponse,
  HttpResult,
} from "../services/engines/unifiedAgent";

export function registerComputerHandlers(): void {
  ipcMain.handle("computer:chat", async (_, request: ComputerChatRequest) => {
    // 兜底+双轨校验与 HTTP 入口（computer/router.ts）同口径：project_id 兜底值
    // 同样过校验，防渲染层传入路径段绕过格式约束；绝对路径归一化后回写。
    if (!request.agent_work_dir && request.project_id) {
      request.agent_work_dir = request.project_id;
    }
    if (request.agent_work_dir) {
      const resolved = validateAgentWorkDirInput(request.agent_work_dir);
      if (!resolved.ok) {
        return {
          code: "4000",
          message: resolved.message,
          data: null,
          tid: null,
          success: false,
        } as HttpResult;
      }
      request.agent_work_dir = resolved.value;
    }

    const dispatchKey = resolveChatDispatchKey(request);
    const chatDispatch: ChatDispatchContext = {
      dispatchKey,
      turnGeneration: chatDispatchCoordinator.bumpArrival(
        dispatchKey,
        request.request_id,
      ),
    };

    // 与 HTTP 路径一致：按 project_id 路由到对应 AcpEngine
    let acpEngine;
    try {
      acpEngine = await agentService.ensureEngineForRequest(request);
    } catch (err: any) {
      return {
        code: "5000",
        message: err.message || "Engine switch failed",
        data: null,
        tid: null,
        success: false,
      } as HttpResult;
    }
    if (!acpEngine) {
      return {
        code: "5000",
        message: "Agent not initialized",
        data: null,
        tid: null,
        success: false,
      } as HttpResult;
    }
    return acpEngine.chat(request, chatDispatch);
  });

  ipcMain.handle(
    "computer:agentStatus",
    async (
      _,
      request: {
        user_id: string;
        project_id?: string;
        agent_work_dir?: string;
      },
    ) => {
      // 引擎 key 口径与 chat 侧一致（agent_work_dir 优先，见 chatEngineKey.ts）：
      // 以 agent_work_dir 建键的引擎仅凭 project_id 查不到。
      const projectKey = request.agent_work_dir || request.project_id || "";
      const projectEngine = agentService.getEngineForProject(projectKey);
      const acpEngine = projectEngine || agentService.getAcpEngine();
      const session = acpEngine?.findSessionByProjectId(projectKey) ?? null;
      const response: ComputerAgentStatusResponse = {
        user_id: request.user_id,
        project_id: projectKey,
        is_alive: !!projectEngine,
        session_id: session?.id ?? null,
        status: session
          ? session.status === "active"
            ? "Busy"
            : "Idle"
          : null,
        last_activity: session?.lastActivity
          ? new Date(session.lastActivity).toISOString()
          : null,
        created_at: session ? new Date(session.createdAt).toISOString() : null,
      };
      return {
        code: "0000",
        message: "success",
        data: response,
        tid: null,
        success: true,
      } as HttpResult<ComputerAgentStatusResponse>;
    },
  );

  ipcMain.handle(
    "computer:agentStop",
    async (
      _,
      request: {
        user_id: string;
        project_id?: string;
        agent_work_dir?: string;
      },
    ) => {
      const projectKey = request.agent_work_dir || request.project_id || "";
      const acpEngine = projectKey
        ? agentService.getEngineForProject(projectKey)
        : agentService.getAcpEngine();
      if (acpEngine) {
        await agentService.stopEngine(projectKey || undefined);
      }
      const response: ComputerAgentStopResponse = {
        success: true,
        message: acpEngine
          ? "Agent stopped successfully"
          : "Agent not found (already stopped)",
        user_id: request.user_id,
        project_id: projectKey,
      };
      return {
        code: "0000",
        message: "success",
        data: response,
        tid: null,
        success: true,
      } as HttpResult<ComputerAgentStopResponse>;
    },
  );

  ipcMain.handle(
    "computer:cancelSession",
    async (
      _,
      request: {
        user_id: string;
        project_id?: string;
        agent_work_dir?: string;
        session_id?: string;
      },
    ) => {
      const projectKey = request.agent_work_dir || request.project_id || "";
      const acpEngine =
        agentService.getEngineForProject(projectKey) ||
        agentService.getAcpEngine();
      if (acpEngine && request.session_id) {
        await acpEngine.abortSession(request.session_id);
      } else if (acpEngine && projectKey) {
        const session = acpEngine.findSessionByProjectId(projectKey);
        if (session) await acpEngine.abortSession(session.id);
      }
      const response: ComputerAgentCancelResponse = {
        success: true,
        session_id: request.session_id || "",
      };
      return {
        code: "0000",
        message: "success",
        data: response,
        tid: null,
        success: true,
      } as HttpResult<ComputerAgentCancelResponse>;
    },
  );

  ipcMain.handle("computer:health", async () => {
    return {
      status: agentService.isReady ? "healthy" : "offline",
      engineType: agentService.getEngineType(),
      timestamp: new Date().toISOString(),
    };
  });
}
