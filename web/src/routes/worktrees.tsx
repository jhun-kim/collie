import { useEffect, useMemo, useRef, useState } from "react";
import { FolderPlus, GitBranch, RefreshCw } from "lucide-react";
import { useNavigate, useRouteLoaderData, useSearchParams } from "react-router";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { BuildStamp } from "@/components/build-stamp";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { StatusArea } from "@/components/status-area";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { WorktreeCard } from "@/components/worktree-card";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath, panePath, spacePath } from "@/lib/nav";
import { setStatus } from "@/lib/status";
import { isReadOnly } from "@/lib/types";
import type { AgentView } from "@/lib/types";
import {
  createWorktree,
  fetchGitStatus,
  fetchWorktrees,
  openWorktree,
  type GitStatusResult,
  type WorktreeListResult,
} from "@/lib/development-api";
import {
  initialWorkspaceId,
  paneFromWorktreeResult,
  sortWorktrees,
  worktreeStatus,
} from "@/lib/worktrees";

export function WorktreesRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const stalled = useLoadingStalled();
  const readOnly = isReadOnly(data.device);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [result, setResult] = useState<WorktreeListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [gitStatuses, setGitStatuses] = useState<Record<string, GitStatusResult | null>>({});
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const sessionRef = useRef(data.session);
  const openingPathRef = useRef<string | null>(null);
  sessionRef.current = data.session;

  const selectedWorkspaceId = initialWorkspaceId(data.workspaces, searchParams.get("workspace"));

  function freshPaneFrom(created: ReturnType<typeof paneFromWorktreeResult>): AgentView {
    return {
      paneId: created.paneId,
      workspaceId: created.workspaceId,
      workspaceLabel: created.workspaceLabel,
      workspaceNumber: 0,
      tabId: created.tabId,
      agent: "shell",
      status: "unknown",
      cwd: created.cwd,
      focused: false,
      kind: "shell",
    };
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetchWorktrees(selectedWorkspaceId, data.session, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setResult(next);
        setError(null);
        setUpdatedAt(Date.now());
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selectedWorkspaceId, data.session, retry, data.workspaces]);

  const worktrees = useMemo(
    () => sortWorktrees(result?.worktrees ?? [], data.agents),
    [result?.worktrees, data.agents],
  );

  const openWorkspaceIds = useMemo(
    () =>
      [...new Set((result?.worktrees ?? []).map((w) => w.open_workspace_id).filter(Boolean))] as string[],
    [result?.worktrees],
  );

  useEffect(() => {
    if (openWorkspaceIds.length === 0) {
      setGitStatuses({});
      return;
    }
    if (data.error || data.bridge === "disconnected" || document.visibilityState === "hidden") {
      return;
    }
    const controller = new AbortController();
    Promise.all(
      openWorkspaceIds.map(async (workspaceId) => {
        try {
          const status = await fetchGitStatus(workspaceId, data.session, controller.signal);
          return [workspaceId, status] as const;
        } catch {
          return [workspaceId, null] as const;
        }
      }),
    ).then((entries) => {
      if (controller.signal.aborted) return;
      setGitStatuses(Object.fromEntries(entries));
      setUpdatedAt(Date.now());
    });
    return () => controller.abort();
  }, [data.agents, data.bridge, data.error, data.session, openWorkspaceIds]);

  function selectWorkspace(workspaceId: string) {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.set("workspace", workspaceId);
      return next;
    });
  }

  async function create(opts: {
    workspaceId: string;
    branch: string;
    base?: string;
    label?: string;
  }): Promise<void> {
    if (readOnly) throw new Error("Read-only - device not authorised");
    const session = data.session;
    try {
      const created = paneFromWorktreeResult(await createWorktree(opts, session));
      if (!mountedRef.current || sessionRef.current !== session) {
        throw new Error("Worktree create finished after navigation");
      }
      setStatus("New worktree ready - launch your agent", "success");
      navigate(panePath(created.paneId, session), {
        state: { freshPane: freshPaneFrom(created) },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (mountedRef.current && sessionRef.current === session) setStatus(message, "error");
      throw new Error(message);
    }
  }

  async function open(path: string) {
    if (!selectedWorkspaceId) return;
    if (readOnly) return setStatus("Read-only - device not authorised", "error");
    if (openingPathRef.current) return;
    const session = data.session;
    const workspaceId = selectedWorkspaceId;
    openingPathRef.current = path;
    setOpeningPath(path);
    try {
      const opened = paneFromWorktreeResult(
        await openWorktree({ workspaceId, path }, session),
      );
      if (!mountedRef.current || sessionRef.current !== session) return;
      setStatus("Worktree ready - launch your agent", "success");
      navigate(panePath(opened.paneId, session), {
        state: { freshPane: freshPaneFrom(opened) },
      });
    } catch (e) {
      if (mountedRef.current && sessionRef.current === session) {
        setStatus(e instanceof Error ? e.message : String(e), "error");
      }
    } finally {
      if (mountedRef.current && sessionRef.current === session) {
        openingPathRef.current = null;
        setOpeningPath(null);
      }
    }
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <AppHeader
        bridge={data.bridge}
        error={data.error}
        stalled={stalled}
        onHome={() => navigate(homePath(data.session))}
        wordmark
        rightTrail={<SettingsGear session={data.session} />}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ReadOnlyBanner device={data.device} />
        <main className="flex-1 px-3 py-4">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Worktrees <span className="opacity-60">({worktrees.length})</span>
            </h2>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setRetry((n) => n + 1)}
                aria-label="Retry worktrees"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted active:scale-95"
              >
                <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
              </button>
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                aria-label="New worktree"
                disabled={readOnly || !selectedWorkspaceId}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted active:scale-95 disabled:opacity-40"
              >
                <FolderPlus className="size-4" />
              </button>
            </div>
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {data.workspaces.map((workspace) => (
              <button
                key={workspace.workspaceId}
                type="button"
                onClick={() => selectWorkspace(workspace.workspaceId)}
                className={
                  workspace.workspaceId === selectedWorkspaceId
                    ? "shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                    : "shrink-0 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground"
                }
              >
                {workspace.label}
              </button>
            ))}
          </div>

          {result?.source && (
            <div className="mt-3 flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate">
                {result.source.repo_name} / {result.source.source_checkout_path}
              </span>
            </div>
          )}

          {error && (
            <Card className="mt-3 gap-3 rounded-xl px-3.5 py-3">
              <p className="text-sm font-medium">Worktrees unavailable</p>
              <p className="text-xs text-muted-foreground">{error}</p>
              <Button size="sm" variant="secondary" onClick={() => setRetry((n) => n + 1)}>
                Retry
              </Button>
            </Card>
          )}

          <div className="mt-3 flex flex-col gap-2">
            {loading && !result ? (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                Loading worktrees...
              </p>
            ) : worktrees.length > 0 ? (
              worktrees.map((worktree) => {
                const status = worktreeStatus(worktree, data.agents);
                return (
                  <WorktreeCard
                    key={worktree.path}
                    worktree={worktree}
                    status={status}
                    gitStatus={
                      worktree.open_workspace_id ? gitStatuses[worktree.open_workspace_id] : undefined
                    }
                    updatedAt={updatedAt}
                    active={worktree.open_workspace_id === selectedWorkspaceId}
                    onOpen={() =>
                      worktree.open_workspace_id
                        ? navigate(spacePath(worktree.open_workspace_id, data.session))
                        : openingPath === worktree.path
                          ? undefined
                          : open(worktree.path)
                    }
                  />
                );
              })
            ) : (
              !error && (
                <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                  No worktrees for this workspace.
                </p>
              )
            )}
          </div>

          {error && (
            <section className="mt-5 flex flex-col gap-2">
              <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Spaces fallback
              </h3>
              {data.workspaces.map((workspace) => (
                <button
                  key={workspace.workspaceId}
                  type="button"
                  onClick={() => navigate(spacePath(workspace.workspaceId, data.session))}
                  className="w-full text-left transition-transform active:scale-[0.99]"
                >
                  <Card className="flex-row items-center gap-3 rounded-xl px-3.5 py-3 shadow-sm">
                    <span className="min-w-0 flex-1 truncate font-medium">{workspace.label}</span>
                    <span className="text-xs text-muted-foreground">{workspace.paneCount} panes</span>
                  </Card>
                </button>
              ))}
            </section>
          )}
        </main>
        <BuildStamp className="px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]" />
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-screen-sm px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]">
        <StatusArea />
      </div>

      <NewSpaceSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        mode="worktree"
        workspaces={data.workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        onCreateWorktree={create}
      />
    </div>
  );
}
