import type { AgentStatus, AgentView, WorkspaceView } from "@/lib/types";
import type { WorktreeInfo, WorktreeResult } from "@/lib/development-api";

export type { WorktreeInfo } from "@/lib/development-api";

export interface CreatedWorktreePane {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  readonly tabId: string;
  readonly cwd: string;
}

export function paneFromWorktreeResult(result: WorktreeResult): CreatedWorktreePane {
  return {
    paneId: result.root_pane.pane_id,
    workspaceId: result.workspace.workspace_id,
    workspaceLabel: result.workspace.label,
    tabId: result.root_pane.tab_id,
    cwd: result.root_pane.cwd,
  };
}

const STATUS_ORDER: Record<AgentStatus | "none", number> = {
  blocked: 0,
  working: 1,
  idle: 2,
  unknown: 3,
  done: 4,
  none: 5,
};

export function worktreeStatus(
  worktree: WorktreeInfo,
  agents: readonly AgentView[],
): AgentStatus | null {
  const workspaceId = worktree.open_workspace_id;
  if (!workspaceId) return null;
  const statuses = agents.filter((agent) => agent.workspaceId === workspaceId).map((a) => a.status);
  if (statuses.length === 0) return null;
  return statuses.reduce((worst, status) =>
    STATUS_ORDER[status] < STATUS_ORDER[worst] ? status : worst,
  );
}

export function sortWorktrees(
  worktrees: readonly WorktreeInfo[],
  agents: readonly AgentView[],
): WorktreeInfo[] {
  return [...worktrees].sort((a, b) => {
    const statusDelta =
      STATUS_ORDER[worktreeStatus(a, agents) ?? "none"] -
      STATUS_ORDER[worktreeStatus(b, agents) ?? "none"];
    if (statusDelta !== 0) return statusDelta;
    const openDelta = Number(!a.open_workspace_id) - Number(!b.open_workspace_id);
    if (openDelta !== 0) return openDelta;
    return a.label.localeCompare(b.label);
  });
}

export function initialWorkspaceId(
  workspaces: readonly WorkspaceView[],
  requested?: string | null,
): string | undefined {
  if (requested && workspaces.some((workspace) => workspace.workspaceId === requested)) {
    return requested;
  }
  return workspaces.find((workspace) => workspace.focused)?.workspaceId ?? workspaces[0]?.workspaceId;
}
