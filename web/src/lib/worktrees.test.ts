import type { AgentView, WorkspaceView } from "@/lib/types";

import {
  initialWorkspaceId,
  paneFromWorktreeResult,
  sortWorktrees,
  worktreeStatus,
  type WorktreeInfo,
} from "./worktrees";

function wt(label: string, open_workspace_id?: string | null): WorktreeInfo {
  return {
    path: `/repo/${label}`,
    branch: label,
    is_bare: false,
    is_detached: false,
    is_prunable: false,
    is_linked_worktree: true,
    label,
    open_workspace_id,
  };
}

function agent(workspaceId: string, status: AgentView["status"]): AgentView {
  return {
    paneId: `${workspaceId}:p1`,
    workspaceId,
    workspaceLabel: workspaceId,
    workspaceNumber: 1,
    tabId: `${workspaceId}:t1`,
    agent: "claude",
    status,
    cwd: "/repo",
    focused: false,
  };
}

function workspace(workspaceId: string, focused = false): WorkspaceView {
  return {
    workspaceId,
    number: 1,
    label: workspaceId,
    focused,
    activeTabId: `${workspaceId}:t1`,
    tabCount: 1,
    paneCount: 1,
  };
}

describe("worktree helpers", () => {
  it("sorts blocked open worktrees before other open and closed worktrees", () => {
    const sorted = sortWorktrees(
      [wt("closed"), wt("idle", "w2"), wt("blocked", "w1")],
      [agent("w1", "blocked"), agent("w2", "idle")],
    );
    expect(sorted.map((w) => w.label)).toEqual(["blocked", "idle", "closed"]);
  });

  it("uses the worst status from the open workspace", () => {
    expect(worktreeStatus(wt("feature", "w1"), [agent("w1", "working"), agent("w1", "blocked")]))
      .toBe("blocked");
    expect(worktreeStatus(wt("feature"), [agent("w1", "blocked")])).toBeNull();
  });

  it("chooses the requested workspace, then focused workspace, then first workspace", () => {
    const workspaces = [workspace("w1"), workspace("w2", true)];
    expect(initialWorkspaceId(workspaces, "w1")).toBe("w1");
    expect(initialWorkspaceId(workspaces, "missing")).toBe("w2");
    expect(initialWorkspaceId([workspace("w1")])).toBe("w1");
  });

  it("converts a worktree create/open response into a fresh pane target", () => {
    expect(
      paneFromWorktreeResult({
        type: "worktree_created",
        workspace: { workspace_id: "w9", label: "feature" },
        tab: { tab_id: "w9:t1" },
        root_pane: { pane_id: "w9:p1", tab_id: "w9:t1", cwd: "/repo/feature" },
        worktree: wt("feature", "w9"),
      }),
    ).toEqual({
      paneId: "w9:p1",
      workspaceId: "w9",
      workspaceLabel: "feature",
      tabId: "w9:t1",
      cwd: "/repo/feature",
    });
  });
});
