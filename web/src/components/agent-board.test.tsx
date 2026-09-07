import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentBoard } from "./agent-board";
import type { AgentView } from "@/lib/types";

function agent(overrides: Partial<AgentView>): AgentView {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "webapp",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "working",
    cwd: "/repo",
    focused: false,
    ...overrides,
  };
}

describe("AgentBoard", () => {
  it("moves cards by live snapshot status and shows the real blocked question", () => {
    const pane = agent({ paneId: "w1:p1", status: "working" });
    const { rerender } = render(<AgentBoard agents={[pane]} bridge="connected" onOpen={vi.fn()} />);

    expect(screen.getByRole("region", { name: "Working" })).toHaveTextContent("claude");
    expect(screen.getByRole("region", { name: "Needs you" })).not.toHaveTextContent("claude");

    rerender(
      <AgentBoard
        agents={[
          agent({
            paneId: "w1:p1",
            status: "blocked",
            blockingMessage: { text: "Approve deploy?", capturedAt: 1 },
          }),
        ]}
        bridge="connected"
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Working" })).not.toHaveTextContent("claude");
    expect(screen.getByRole("region", { name: "Needs you" })).toHaveTextContent("claude");
    expect(screen.getByText("Approve deploy?")).toBeInTheDocument();
  });

  it("scrolls the board row to a lane from mobile jump buttons", async () => {
    const user = userEvent.setup();
    render(
      <AgentBoard
        agents={[
          agent({ paneId: "w1:p1", status: "working" }),
          agent({ paneId: "w2:p1", status: "blocked", agent: "codex" }),
        ]}
        bridge="connected"
        onOpen={vi.fn()}
      />,
    );

    const targetLane = screen.getByRole("region", { name: "Needs you" });
    const scroller = targetLane.parentElement as HTMLDivElement;
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, "scrollTo", { value: scrollTo });
    Object.defineProperty(scroller, "offsetLeft", { configurable: true, value: 20 });
    Object.defineProperty(targetLane, "offsetLeft", { configurable: true, value: 340 });

    await user.click(screen.getByRole("button", { name: "Needs you lane, 1 agents" }));

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 320, behavior: "smooth" });
  });

  it("keeps idle and unknown agents reachable in a compact section", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <AgentBoard
        agents={[
          agent({ paneId: "w1:p1", status: "idle", agent: "codex" }),
          agent({ paneId: "w2:p1", workspaceLabel: "ops", status: "unknown", agent: "shell", kind: "shell" }),
        ]}
        bridge="connected"
        onOpen={onOpen}
      />,
    );

    await user.click(screen.getByText(/idle \/ unknown/i));
    await user.click(screen.getByRole("button", { name: /codex/ }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("w1:p1");
    expect(screen.getByRole("button", { name: /shell/ })).toBeInTheDocument();
  });

  it("marks stale data as paused, suppresses working pulse, and recovers to live", () => {
    const { container, rerender } = render(
      <AgentBoard agents={[agent({ status: "working" })]} bridge="connected" stale onOpen={vi.fn()} />,
    );

    expect(screen.getByText("Updates paused")).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Live agent board"]')).toHaveClass(
      "[&_.animate-ping]:animate-none",
    );
    expect(screen.getByRole("region", { name: "Working" })).toHaveClass("opacity-60");

    rerender(<AgentBoard agents={[agent({ status: "working" })]} bridge="connected" onOpen={vi.fn()} />);

    expect(screen.getByText("Updates live")).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Live agent board"]')).not.toHaveClass(
      "[&_.animate-ping]:animate-none",
    );
    expect(screen.getByRole("region", { name: "Working" })).not.toHaveClass("opacity-60");
  });

  it("shows the connected empty state", () => {
    render(<AgentBoard agents={[]} bridge="connected" onOpen={vi.fn()} />);
    expect(screen.getByText("No agents running.")).toBeInTheDocument();
  });
});
