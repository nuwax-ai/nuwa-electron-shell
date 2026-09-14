/**
 * agent_work_dir 双轨校验与归一化（/computer/chat 及 IPC computer:chat 共用）。
 *
 * 双轨制（2026-09-14 需求：web 端工作空间选择打通）：
 * - 标识符轨道：!path.isAbsolute(v) —— 维持原校验 [a-zA-Z0-9_-]{1,64}，
 *   目录由 {workspace}/computer-project-workspace/{userId}/{id} 拼接（存量调用零影响）。
 * - 绝对路径轨道：path.isAbsolute(v) —— nuwax web 目录选择弹窗（file-server fs/roots
 *   + fs/children）回传的本机目录。须存在（fail fast 不误建）、是目录、可写；
 *   realpathSync 归一化（消解 symlink / macOS 大小写形态）后作为唯一形态回写
 *   body.agent_work_dir——下游引擎复用、会话注册表、派发串行化、SSE 清理等
 *   把它当 key 的位置拿到的都是同一字符串，key 函数免改。
 *
 * 安全边界（产品拍板 2026-09-14）：默认全放，仅存在性+可写校验；边界=lanproxy
 * 登录隧道（请求来自登录用户的后端转发）。后续如需收紧为目录白名单，收口在本
 * 模块单点。
 *
 * 历史兼容：旧正则保证存量成功请求不可能含 / 或盘符，双轨判别无旧数据误判。
 */
import * as fs from "fs";
import * as path from "path";

/** 绝对路径轨道长度上限（常见 PATH_MAX；标识符轨道维持 64） */
const MAX_ABS_PATH_LENGTH = 4096;

/** 标识符轨道原正则（与改造前 router.ts validateAgentWorkDir 一致） */
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type AgentWorkDirErrorCode =
  | "AGENT_WORK_DIR_INVALID"
  | "AGENT_WORK_DIR_NOT_FOUND"
  | "AGENT_WORK_DIR_NOT_A_DIRECTORY"
  | "AGENT_WORK_DIR_NOT_WRITABLE";

export type AgentWorkDirResolution =
  | { ok: true; kind: "id" | "abs"; value: string }
  | { ok: false; code: AgentWorkDirErrorCode; message: string };

export function isAbsoluteAgentWorkDir(value: string): boolean {
  return path.isAbsolute(value);
}

/**
 * 双轨校验入口。成功返回归一化后的唯一形态 value（标识符原样；绝对路径为
 * realpath），失败返回分类错误码与可读 message（经 HTTP 400 / IPC 错误体透出，
 * 前端 toast 直接展示）。
 */
export function validateAgentWorkDirInput(raw: string): AgentWorkDirResolution {
  if (!raw) {
    return {
      ok: false,
      code: "AGENT_WORK_DIR_INVALID",
      message: "agent_work_dir must be 1-64 characters",
    };
  }

  if (path.isAbsolute(raw)) {
    if (raw.length > MAX_ABS_PATH_LENGTH) {
      return {
        ok: false,
        code: "AGENT_WORK_DIR_INVALID",
        message: `agent_work_dir path exceeds ${MAX_ABS_PATH_LENGTH} characters`,
      };
    }
    let resolved: string;
    try {
      // 存在性 fail-fast + 消解 symlink / macOS 大小写形态（唯一形态的关键）
      resolved = fs.realpathSync(raw);
    } catch {
      return {
        ok: false,
        code: "AGENT_WORK_DIR_NOT_FOUND",
        message: `agent_work_dir directory does not exist: ${raw}`,
      };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return {
        ok: false,
        code: "AGENT_WORK_DIR_NOT_FOUND",
        message: `agent_work_dir directory does not exist: ${raw}`,
      };
    }
    if (!stat.isDirectory()) {
      return {
        ok: false,
        code: "AGENT_WORK_DIR_NOT_A_DIRECTORY",
        message: `agent_work_dir is not a directory: ${raw}`,
      };
    }
    try {
      fs.accessSync(resolved, fs.constants.W_OK);
    } catch {
      return {
        ok: false,
        code: "AGENT_WORK_DIR_NOT_WRITABLE",
        message: `agent_work_dir directory is not writable: ${raw}`,
      };
    }
    return { ok: true, kind: "abs", value: resolved };
  }

  // 标识符轨道：原正则（天然拒绝 / \ .. 与盘符）
  if (raw.length > 64) {
    return {
      ok: false,
      code: "AGENT_WORK_DIR_INVALID",
      message: "agent_work_dir must be 1-64 characters",
    };
  }
  if (!IDENTIFIER_PATTERN.test(raw)) {
    return {
      ok: false,
      code: "AGENT_WORK_DIR_INVALID",
      message: "agent_work_dir may only contain [a-zA-Z0-9_-]",
    };
  }
  return { ok: true, kind: "id", value: raw };
}
