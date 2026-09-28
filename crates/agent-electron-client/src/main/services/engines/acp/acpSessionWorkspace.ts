/** 会话真实 cwd 与平台请求标识的运行时关联；不使用引擎进程的总工作区推断。 */
export interface SessionWorkspaceRef {
  id: string;
  acpSessionId?: string;
  projectId?: string;
  cwd?: string;
  /** projectId 兼作 agent_work_dir，另存真实请求 project_id，避免绝对路径覆盖它。 */
  requestProjectIds?: string[];
}

export function rememberSessionRequestProject(
  session: SessionWorkspaceRef,
  projectId: string | undefined,
): void {
  if (!projectId) return;
  const ids = session.requestProjectIds ?? [];
  if (!ids.includes(projectId)) session.requestProjectIds = [...ids, projectId];
}

/** 返回全部匹配目录，调用方必须处理跨会话/跨引擎歧义，不能取首个或最近一个。 */
export function collectSessionWorkspaceCandidates(
  sessions: Iterable<SessionWorkspaceRef>,
  projectId: string,
): string[] {
  if (!projectId) return [];
  const directories = new Set<string>();
  for (const session of sessions) {
    if (
      session.requestProjectIds?.includes(projectId) ||
      session.projectId === projectId ||
      session.id === projectId ||
      session.acpSessionId === projectId
    ) {
      if (session.cwd) directories.add(session.cwd);
    }
  }
  return [...directories];
}
