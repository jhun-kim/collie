import { useMemo, useRef } from "react";
import { ChevronRight, Inbox } from "lucide-react";

import { Card } from "@/components/ui/card";
import { StatusDot } from "@/components/status-badge";
import { paneDisplayName, STATUS_LABEL } from "@/lib/types";
import type { AgentStatus, AgentView, BridgeStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AgentBoardProps {
  agents: readonly AgentView[];
  bridge?: BridgeStatus | undefined;
  stale?: boolean;
  onOpen: (paneId: string) => void;
}

type Lane = {
  key: string;
  label: string;
  statuses: readonly AgentStatus[];
  dot: string;
  accent?: boolean;
};

const MAIN_LANES: readonly Lane[] = [
  { key: "working", label: "Working", statuses: ["working"], dot: "bg-status-working" },
  { key: "needs", label: "Needs you", statuses: ["blocked"], dot: "bg-status-blocked", accent: true },
  { key: "done", label: "Done", statuses: ["done"], dot: "bg-status-done" },
];

const OTHER_STATUSES: readonly AgentStatus[] = ["idle", "unknown"];

export function AgentBoard({ agents, bridge, stale = false, onOpen }: AgentBoardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const laneRefs = useRef<Record<string, HTMLElement | null>>({});
  const lanes = useMemo(
    () =>
      MAIN_LANES.map((lane) => ({
        lane,
        members: agents.filter((agent) => lane.statuses.includes(agent.status)),
      })),
    [agents],
  );

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-3 py-20 text-muted-foreground">
        <Inbox className="size-7" />
        <span className="text-sm">
          {bridge === "connected" ? "No agents running." : "Waiting for Herdr…"}
        </span>
      </div>
    );
  }

  const otherAgents = agents.filter((agent) => OTHER_STATUSES.includes(agent.status));

  function jumpToLane(key: string) {
    const scroller = scrollRef.current;
    const lane = laneRefs.current[key];
    if (!scroller || !lane) return;
    scroller.scrollTo({ left: lane.offsetLeft - scroller.offsetLeft, behavior: "smooth" });
  }

  return (
    <section
      aria-label="Live agent board"
      className={cn("px-3 py-4", stale && "[&_.animate-ping]:animate-none")}
    >
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Live agents <span className="opacity-60">({agents.length})</span>
        </h2>
        <span className="text-[11px] text-muted-foreground">{stale ? "Updates paused" : "Updates live"}</span>
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2 md:hidden" aria-label="Agent lane jumps">
        {lanes.map(({ lane, members }) => (
          <button
            key={lane.key}
            type="button"
            aria-label={`${lane.label} lane, ${members.length} agents`}
            onClick={() => jumpToLane(lane.key)}
            className="rounded-lg border border-border bg-card/70 px-2 py-2 text-left active:scale-[0.98]"
          >
            <span className="block truncate text-xs font-medium">{lane.label}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{members.length}</span>
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="-mx-3 flex snap-x gap-3 overflow-x-auto px-3 pb-2 md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0">
        {lanes.map(({ lane, members }) => (
          <LaneColumn
            key={lane.key}
            ref={(node) => {
              laneRefs.current[lane.key] = node;
            }}
            lane={lane}
            members={members}
            stale={stale}
            onOpen={onOpen}
          />
        ))}
      </div>

      {otherAgents.length > 0 && (
        <details className="mt-3 rounded-xl border border-border bg-card/60 px-3 py-2 open:pb-3">
          <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Idle / unknown <span className="opacity-60">({otherAgents.length})</span>
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {otherAgents.map((agent) => (
              <AgentBoardCard key={agent.paneId} agent={agent} stale={stale} onOpen={onOpen} compact />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function LaneColumn({
  ref,
  lane,
  members,
  stale,
  onOpen,
}: {
  ref: (node: HTMLElement | null) => void;
  lane: Lane;
  members: AgentView[];
  stale: boolean;
  onOpen: (paneId: string) => void;
}) {
  return (
    <section
      ref={ref}
      aria-label={lane.label}
      className={cn(
        "flex min-h-52 w-[min(82vw,20rem)] shrink-0 snap-start flex-col rounded-2xl border bg-card/50 p-3 shadow-sm md:min-h-64 md:w-auto",
        lane.accent && "border-status-blocked/40 bg-status-blocked/5",
        stale && "opacity-60",
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", lane.dot)} />
          <h3 className="text-sm font-semibold">{lane.label}</h3>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
          {members.length}
        </span>
      </div>

      {members.length === 0 ? (
        <p className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border/80 px-3 text-center text-sm text-muted-foreground">
          No agents here.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {members.map((agent) => (
            <AgentBoardCard key={agent.paneId} agent={agent} stale={stale} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

function AgentBoardCard({
  agent,
  stale = false,
  onOpen,
  compact = false,
}: {
  agent: AgentView;
  stale?: boolean;
  onOpen: (paneId: string) => void;
  compact?: boolean;
}) {
  const blockedText = agent.status === "blocked" ? agent.blockingMessage?.text : undefined;
  return (
    <button
      type="button"
      onClick={() => onOpen(agent.paneId)}
      className="w-full text-left transition-transform active:scale-[0.99]"
    >
      <Card
        className={cn(
          "flex-row items-start gap-3 rounded-xl px-3 py-3 shadow-sm",
          agent.status === "blocked" && "border-status-blocked/40 bg-status-blocked/10",
          compact && "py-2.5",
          stale && "opacity-70",
        )}
      >
        <StatusDot status={agent.status} className="mt-1" />
        <span className="sr-only">{STATUS_LABEL[agent.status]}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{paneDisplayName(agent)}</div>
          <div className="truncate text-xs text-muted-foreground">{agent.workspaceLabel}</div>
          {blockedText && (
            <p className="mt-2 line-clamp-3 break-words rounded-lg bg-background/60 px-2 py-1.5 text-sm text-foreground">
              {blockedText}
            </p>
          )}
        </div>
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </Card>
    </button>
  );
}
