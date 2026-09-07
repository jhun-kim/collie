import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouteLoaderData } from "react-router";
import { ChevronRight, FolderPlus, GitBranch, Layers, LayoutGrid } from "lucide-react";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { SessionSwitcher } from "@/components/session-switcher";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentBoard } from "@/components/agent-board";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { BuildStamp } from "@/components/build-stamp";
import { UpdateBanner } from "@/components/update-banner";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useSpaceActions } from "@/hooks/use-spaces";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath, spacePath, worktreesPath } from "@/lib/nav";

export function HomeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const stalled = useLoadingStalled();
  const navigate = useNavigate();
  const { newSpace } = useSpaceActions();
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);

  const open = (id: string) => navigate(panePath(id, data.session));
  const agents = [...data.agents, ...(data.shellPanes ?? [])];
  const stale = data.error || stalled || data.bridge !== "connected";

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1100px] flex-1 flex-col">
      <AppHeader
        bridge={data.bridge}
        error={data.error}
        stalled={stalled}
        wordmark
        rightLead={<SessionSwitcher sessions={data.sessions ?? []} current={data.session} />}
        rightTrail={<SettingsGear session={data.session} />}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
        <ReadOnlyBanner device={data.device} />

        <main className="flex-1">
          <AgentBoard agents={agents} bridge={data.bridge} stale={stale} onOpen={open} />
          <HomeSpaces
            data={data}
            onNewSpace={() => setNewSpaceOpen(true)}
            onOpenSpace={(id) => navigate(spacePath(id, data.session))}
          />
        </main>

        <UpdateBanner className="px-3 pt-3" />
        <BuildStamp className="px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]" />
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[1100px] px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]">
        <StatusArea />
      </div>

      <NewSpaceSheet open={newSpaceOpen} onClose={() => setNewSpaceOpen(false)} onCreate={newSpace} />
    </div>
  );
}

function HomeSpaces({
  data,
  onNewSpace,
  onOpenSpace,
}: {
  data: HomeData;
  onNewSpace: () => void;
  onOpenSpace: (workspaceId: string) => void;
}) {
  return (
    <section className="px-3 pb-4">
      <details className="rounded-2xl border border-border bg-card/50 px-3 py-2 open:pb-3">
        <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Spaces <span className="opacity-60">({data.workspaces.length})</span>
        </summary>

        <div className="mt-3 flex flex-col gap-2">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.workspaces.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border/80 px-3 py-5 text-center text-sm text-muted-foreground">
                No spaces yet.
              </p>
            ) : (
              data.workspaces.map((workspace) => (
                <button
                  key={workspace.workspaceId}
                  type="button"
                  onClick={() => onOpenSpace(workspace.workspaceId)}
                  className="flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background/40 px-3 text-left text-sm transition-colors hover:bg-muted/50 active:scale-[0.99]"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{workspace.label}</span>
                  <Count n={workspace.tabCount} unit="tab" icon={<Layers className="size-3.5" aria-hidden />} />
                  <Count n={workspace.paneCount} unit="pane" icon={<LayoutGrid className="size-3.5" aria-hidden />} />
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ))
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={onNewSpace}
              className="flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background/40 px-3 text-left text-sm font-medium transition-colors hover:bg-muted/50 active:scale-[0.99]"
            >
              <FolderPlus className="size-4 text-muted-foreground" />
              <span className="flex-1">New space</span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
            <Link
              to={worktreesPath(data.session)}
              className="flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background/40 px-3 text-sm font-medium transition-colors hover:bg-muted/50 active:scale-[0.99]"
            >
              <GitBranch className="size-4 text-muted-foreground" />
              <span className="flex-1">Worktrees</span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </Link>
          </div>
        </div>
      </details>
    </section>
  );
}

function Count({ n, unit, icon }: { n: number; unit: string; icon: ReactNode }) {
  return (
    <span
      aria-label={`${n} ${unit}${n === 1 ? "" : "s"}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
    >
      {icon}
      {n}
    </span>
  );
}
