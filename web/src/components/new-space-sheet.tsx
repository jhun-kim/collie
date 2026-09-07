import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { useHoldReload } from "@/lib/reload-guard";
import type { WorkspaceView } from "@/lib/types";

type SpaceCreateOptions = { label?: string; cwd?: string };
type WorktreeCreateOptions = {
  workspaceId: string;
  branch: string;
  base?: string;
  label?: string;
};

interface BaseProps {
  open: boolean;
  onClose: () => void;
}

type NewSpaceSheetProps =
  | (BaseProps & {
      mode?: "space";
      onCreate: (opts: SpaceCreateOptions) => void;
    })
  | (BaseProps & {
      mode: "worktree";
      workspaces: readonly WorkspaceView[];
      selectedWorkspaceId?: string;
      onCreateWorktree: (opts: WorktreeCreateOptions) => void | Promise<void>;
    });

// Create a new space (workspace). Both fields are optional and dictation-friendly: leave the
// directory blank to open the shell in your home dir (it's a shell — cd from there), or set a path
// for a specific project. The new space opens a fresh shell you launch your own agent in.
export function NewSpaceSheet(props: NewSpaceSheetProps) {
  const { open, onClose } = props;
  const worktreeProps = props.mode === "worktree" ? props : null;
  const mode = worktreeProps ? "worktree" : "space";
  const selectedWorkspaceId = worktreeProps?.selectedWorkspaceId;
  const [label, setLabel] = useState("");
  const [cwd, setCwd] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Don't let a self-update reload yank this tab/space form out from under a half-typed
  // directory/label — hold while it's open; the self-updater shows the banner and updates on close.
  useHoldReload("new-space", open);

  useEffect(() => {
    if (open) {
      setLabel("");
      setCwd("");
      setBranch("");
      setBase("");
      setWorkspaceId(selectedWorkspaceId ?? "");
      setPending(false);
      setError(null);
    }
  }, [open, mode, selectedWorkspaceId]);

  async function create() {
    if (props.mode === "worktree") {
      setPending(true);
      setError(null);
      try {
        await props.onCreateWorktree({
          workspaceId,
          branch: branch.trim(),
          base: base.trim() || undefined,
          label: label.trim() || undefined,
        });
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(false);
      }
      return;
    }
    props.onCreate({ label: label.trim() || undefined, cwd: cwd.trim() || undefined });
    onClose();
  }

  const branchRequiredMissing = mode === "worktree" && branch.trim().length === 0;
  const workspaceMissing = mode === "worktree" && workspaceId.trim().length === 0;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={mode === "worktree" ? "New worktree" : "New space"}
    >
      <div className="flex flex-col gap-3">
        {mode === "worktree" ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Source workspace</span>
              <select
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                disabled={pending}
                className="h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {worktreeProps?.workspaces.length === 0 && <option value="">No workspaces</option>}
                {worktreeProps?.workspaces.map((workspace) => (
                  <option key={workspace.workspaceId} value={workspace.workspaceId}>
                    {workspace.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Branch</span>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="feature/mobile-worktrees"
                disabled={pending}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Base (optional)</span>
              <input
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="main"
                disabled={pending}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Directory (optional)</span>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="~ (home dir)"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Label (optional)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="name this space"
            disabled={pending}
            className="h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </label>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-status-blocked/30 bg-status-blocked/10 px-3 py-2 text-sm text-status-blocked"
          >
            {error}
          </p>
        )}
        <Button
          onClick={create}
          disabled={pending || branchRequiredMissing || workspaceMissing}
          className="mt-1 h-11"
        >
          {mode === "worktree" && <GitBranch className="size-4" />}
          {mode === "worktree"
            ? pending
              ? "Creating worktree..."
              : "Create worktree & open shell"
            : "Create space & open shell"}
        </Button>
      </div>
    </BottomSheet>
  );
}
