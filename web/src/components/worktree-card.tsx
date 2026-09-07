import {
  ChevronRight,
  Circle,
  GitBranch,
  GitFork,
  HardDrive,
  Link2,
  PauseCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";
import { StatusDot } from "@/components/status-badge";
import type { GitStatusResult } from "@/lib/development-api";
import { STATUS_LABEL, type AgentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { WorktreeInfo } from "@/lib/worktrees";

interface WorktreeCardProps {
  worktree: WorktreeInfo;
  status: AgentStatus | null;
  gitStatus?: GitStatusResult | null;
  updatedAt?: number | null;
  active?: boolean;
  onOpen: () => void;
}

export function WorktreeCard({
  worktree,
  status,
  gitStatus,
  updatedAt,
  active,
  onOpen,
}: WorktreeCardProps) {
  const branch = worktree.branch || (worktree.is_detached ? "detached" : "no branch");
  const blocked = status === "blocked";
  const gitBadge = gitBadgeFor(gitStatus);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left transition-transform active:scale-[0.99]"
    >
      <Card
        className={cn(
          "gap-2 rounded-xl px-3.5 py-3 shadow-sm",
          blocked && "border-status-blocked/40 bg-status-blocked/5",
          active && !blocked && "border-primary/40 bg-primary/5",
        )}
      >
        <div className="flex items-center gap-3">
          {status ? (
            <>
              <StatusDot status={status} />
              <span className="sr-only">{STATUS_LABEL[status]}</span>
            </>
          ) : (
            <span className="size-2.5 shrink-0 rounded-full border border-muted-foreground/40" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">{worktree.label}</span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </div>
        <div className="ml-5 flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{branch}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <HardDrive className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{worktree.path}</span>
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {worktree.open_workspace_id && <Flag icon={Link2} label="open" />}
            {worktree.is_linked_worktree && <Flag icon={GitFork} label="linked" />}
            {worktree.is_bare && <Flag icon={HardDrive} label="bare" />}
            {worktree.is_prunable && <Flag icon={PauseCircle} label="prunable" />}
            {worktree.open_workspace_id && <GitFlag tone={gitBadge.tone} label={gitBadge.label} />}
          </div>
          {updatedAt && (
            <div className="pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Updated {formatUpdatedAt(updatedAt)}
            </div>
          )}
        </div>
      </Card>
    </button>
  );
}

function Flag({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

function GitFlag({ tone, label }: { tone: "clean" | "modified" | "staged" | "unknown"; label: string }) {
  const toneClass = {
    clean: "border-status-done/30 bg-status-done/10 text-status-done",
    modified: "border-status-working/30 bg-status-working/10 text-status-working",
    staged: "border-primary/30 bg-primary/10 text-primary",
    unknown: "border-border bg-muted text-muted-foreground",
  }[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        toneClass,
      )}
    >
      <Circle className="size-2 fill-current" aria-hidden />
      {label}
    </span>
  );
}

function gitBadgeFor(status: GitStatusResult | null | undefined): {
  tone: "clean" | "modified" | "staged" | "unknown";
  label: string;
} {
  if (!status) return { tone: "unknown", label: "git unknown" };
  const staged = status.changed.filter((change) => change.staged).length;
  const modified = status.changed.length - staged;
  if (staged > 0) return { tone: "staged", label: `${staged} staged` };
  if (modified > 0) return { tone: "modified", label: `${modified} modified` };
  return { tone: "clean", label: "clean" };
}

function formatUpdatedAt(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}
