import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, GitBranch, GitCommit, Loader2, RefreshCw } from "lucide-react";
import { useNavigate, useParams, useRevalidator, useRouteLoaderData } from "react-router";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { DiffView } from "@/components/diff-view";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { Button } from "@/components/ui/button";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import {
  commitChanges,
  fetchGitDiff,
  fetchGitStatus,
  stageFiles,
  unstageFiles,
  type GitChange,
  type GitDiffResult,
  type GitStatusResult,
} from "@/lib/development-api";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath, spacePath } from "@/lib/nav";
import { useSession } from "@/lib/session";
import { isReadOnly } from "@/lib/types";
import { cn } from "@/lib/utils";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    M: "Modified",
    A: "Added",
    D: "Deleted",
    R: "Renamed",
    C: "Copied",
    U: "Conflict",
    "?": "Untracked",
  };
  return labels[status] ?? status;
}

function ChangeList({
  title,
  changes,
  selected,
  busy,
  readOnly,
  actionLabel,
  onSelect,
  onAction,
}: {
  title: string;
  changes: readonly GitChange[];
  selected: GitChange | null;
  busy: boolean;
  readOnly: boolean;
  actionLabel: string;
  onSelect: (change: GitChange) => void;
  onAction: (change: GitChange) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title} · {changes.length}
      </h2>
      {changes.length === 0 ? (
        <p className="rounded-md border bg-card px-3 py-4 text-sm text-muted-foreground">No changes.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {changes.map((change) => {
            const active = selected?.path === change.path && selected.staged === change.staged;
            return (
              <div
                key={`${change.staged ? "s" : "u"}:${change.path}:${change.status}`}
                className={cn("flex items-center gap-2 rounded-md border bg-card p-2", active && "border-primary/50 bg-accent")}
              >
                <button type="button" onClick={() => onSelect(change)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-medium">{change.path}</div>
                  <div className="text-xs text-muted-foreground">{statusLabel(change.status)}</div>
                </button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={readOnly || busy}
                  onClick={() => onAction(change)}
                >
                  {actionLabel}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function SourceControlRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const { spaceId = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const stalled = useLoadingStalled();
  const workspace = data?.workspaces.find((w) => w.workspaceId === spaceId);
  const workspaceId = workspace?.workspaceId;
  const readOnly = isReadOnly(data?.device);

  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GitChange | null>(null);
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [commitOutput, setCommitOutput] = useState<string | null>(null);
  const statusSeq = useRef(0);
  const diffSeq = useRef(0);
  const mutatingRef = useRef(false);
  const statusController = useRef<AbortController | null>(null);
  const diffController = useRef<AbortController | null>(null);
  const activeKey = `${workspaceId ?? ""}\u0000${session ?? ""}`;
  const activeKeyRef = useRef(activeKey);
  mutatingRef.current = mutating;
  activeKeyRef.current = activeKey;

  const staged = useMemo(() => status?.changed.filter((change) => change.staged) ?? [], [status]);
  const unstaged = useMemo(() => status?.changed.filter((change) => !change.staged) ?? [], [status]);

  const refresh = () => {
    if (!workspaceId) return;
    const seq = ++statusSeq.current;
    const controller = new AbortController();
    const requestKey = activeKeyRef.current;
    statusController.current?.abort();
    statusController.current = controller;
    setStatusLoading(true);
    setStatusError(null);
    fetchGitStatus(workspaceId, session, controller.signal)
      .then((next) => {
        if (controller.signal.aborted || seq !== statusSeq.current || activeKeyRef.current !== requestKey) return;
        setStatus(next);
        setSelected((current) =>
          current && next.changed.some((change) => change.path === current.path && change.staged === current.staged)
            ? current
            : (next.changed[0] ?? null),
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || seq !== statusSeq.current || activeKeyRef.current !== requestKey) return;
        setStatusError(errorMessage(error));
      })
      .finally(() => {
        if (seq === statusSeq.current && activeKeyRef.current === requestKey) setStatusLoading(false);
        if (statusController.current === controller) statusController.current = null;
      });
    return () => controller.abort();
  };

  useEffect(() => {
    statusSeq.current += 1;
    diffSeq.current += 1;
    statusController.current?.abort();
    diffController.current?.abort();
    setMutating(false);
    setSelected(null);
    setDiff(null);
    setCommitOutput(null);
    const abort = refresh();
    const id = window.setInterval(() => {
      if (!document.hidden && !mutatingRef.current) refresh();
    }, 4_000);
    return () => {
      abort?.();
      clearInterval(id);
    };
  }, [workspaceId, session]);

  useEffect(() => {
    if (!workspaceId || !selected) {
      diffSeq.current += 1;
      diffController.current?.abort();
      setDiff(null);
      setDiffError(null);
      return;
    }
    const seq = ++diffSeq.current;
    const controller = new AbortController();
    const requestKey = activeKeyRef.current;
    diffController.current?.abort();
    diffController.current = controller;
    setDiffLoading(true);
    setDiffError(null);
    fetchGitDiff(workspaceId, selected.path, selected.staged, session, controller.signal)
      .then((next) => {
        if (controller.signal.aborted || seq !== diffSeq.current || activeKeyRef.current !== requestKey) return;
        setDiff(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || seq !== diffSeq.current || activeKeyRef.current !== requestKey) return;
        setDiffError(errorMessage(error));
      })
      .finally(() => {
        if (seq === diffSeq.current && activeKeyRef.current === requestKey) setDiffLoading(false);
        if (diffController.current === controller) diffController.current = null;
      });
    return () => controller.abort();
  }, [workspaceId, selected, session]);

  async function mutate(change: GitChange, action: "stage" | "unstage") {
    if (!workspaceId || readOnly) return;
    const requestKey = activeKeyRef.current;
    setMutating(true);
    setStatusError(null);
    try {
      if (action === "stage") await stageFiles(workspaceId, [change.path], session);
      else await unstageFiles(workspaceId, [change.path], session);
      if (activeKeyRef.current === requestKey) {
        refresh();
        revalidator.revalidate();
      }
    } catch (error) {
      if (activeKeyRef.current === requestKey) setStatusError(errorMessage(error));
    } finally {
      if (activeKeyRef.current === requestKey) setMutating(false);
    }
  }

  async function commit() {
    if (!workspaceId || readOnly || message.trim().length === 0 || !commitOpen) {
      setCommitOpen(true);
      return;
    }
    const requestKey = activeKeyRef.current;
    setMutating(true);
    setStatusError(null);
    try {
      const result = await commitChanges(workspaceId, message.trim(), session);
      if (activeKeyRef.current === requestKey) {
        setCommitOutput(result.output || "Committed.");
        setMessage("");
        setCommitOpen(false);
        refresh();
        revalidator.revalidate();
      }
    } catch (error) {
      if (activeKeyRef.current === requestKey) setStatusError(errorMessage(error));
    } finally {
      if (activeKeyRef.current === requestKey) setMutating(false);
    }
  }

  useEffect(() => {
    return () => {
      statusSeq.current += 1;
      diffSeq.current += 1;
      statusController.current?.abort();
      diffController.current?.abort();
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <AppHeader
        bridge={data?.bridge}
        error={data?.error ?? false}
        stalled={stalled}
        onHome={() => navigate(homePath(session))}
        rightTrail={<SettingsGear session={session} />}
      >
        <button
          type="button"
          onClick={() => navigate(spacePath(spaceId, session))}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <ArrowLeft className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{workspace?.label ?? "Source"}</div>
            <div className="truncate text-xs text-muted-foreground">Source control</div>
          </div>
        </button>
      </AppHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ReadOnlyBanner device={data?.device} />
        {!workspace ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">Space not found.</p>
        ) : (
          <main className="flex flex-1 flex-col gap-4 px-3 py-4">
            <section className="rounded-md border bg-card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <GitBranch className="size-4 text-muted-foreground" />
                    <span className="truncate">{status?.detached ? "Detached HEAD" : (status?.branch ?? "Unknown branch")}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {status?.upstream ?? "No upstream"}
                    {status && (status.ahead > 0 || status.behind > 0)
                      ? ` · ahead ${status.ahead} · behind ${status.behind}`
                      : ""}
                  </p>
                </div>
                <Button variant="outline" size="sm" disabled={statusLoading || mutating} onClick={refresh}>
                  {statusLoading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  Refresh
                </Button>
              </div>
              {statusError && (
                <p role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {statusError}
                </p>
              )}
              {status?.truncated && <p className="mt-2 text-xs text-muted-foreground">Change list truncated.</p>}
            </section>

            <ChangeList
              title="Staged"
              changes={staged}
              selected={selected}
              busy={mutating}
              readOnly={readOnly}
              actionLabel="Unstage"
              onSelect={setSelected}
              onAction={(change) => mutate(change, "unstage")}
            />
            <ChangeList
              title="Changes"
              changes={unstaged}
              selected={selected}
              busy={mutating}
              readOnly={readOnly}
              actionLabel="Stage"
              onSelect={setSelected}
              onAction={(change) => mutate(change, "stage")}
            />

            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diff</h2>
                <Button
                  size="sm"
                  disabled={readOnly || mutating || staged.length === 0 || (commitOpen && message.trim().length === 0)}
                  onClick={commit}
                >
                  {mutating ? <Loader2 className="size-4 animate-spin" /> : <GitCommit className="size-4" />}
                  {commitOpen ? "Tap to commit" : "Commit"}
                </Button>
              </div>
              {commitOpen && (
                <div className="rounded-md border bg-card p-2">
                  <textarea
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    rows={3}
                    disabled={readOnly || mutating}
                    placeholder="Commit message"
                    className="min-h-20 w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">Enter a message, then tap commit again.</p>
                </div>
              )}
              {commitOutput && <p className="rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground">{commitOutput}</p>}
              <DiffView diff={diff?.diff ?? ""} loading={diffLoading} error={diffError} />
            </section>
          </main>
        )}
      </div>
    </div>
  );
}
