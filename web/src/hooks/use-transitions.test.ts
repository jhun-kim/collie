import { renderHook } from "@testing-library/react";
import { useAgentTransitions } from "./use-transitions";
import { fixtureAgents } from "@/test/handlers";
import { setStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";

vi.mock("@/lib/status", () => ({ setStatus: vi.fn() }));

describe("captured question notifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates a blocked notification when its question arrives on a later poll", () => {
    const agent: AgentView = { ...fixtureAgents[0]!, status: "working" };
    const { rerender } = renderHook(({ agents }) => useAgentTransitions(agents, null), {
      initialProps: { agents: [agent] },
    });
    rerender({ agents: [{ ...agent, status: "blocked" }] });
    expect(setStatus).toHaveBeenLastCalledWith("claude needs you · webapp", "warn");
    const captured: AgentView = { ...agent, status: "blocked", blockingMessage: { text: "Ship it?", capturedAt: 1 } };
    rerender({ agents: [captured] });
    expect(setStatus).toHaveBeenLastCalledWith("claude needs you · Ship it?", "warn");
    expect(setStatus).toHaveBeenCalledTimes(2);
    rerender({ agents: [{ ...captured }] });
    expect(setStatus).toHaveBeenCalledTimes(2);
  });

  it("does not notify initial state, the open pane, or a different session", () => {
    const agent = fixtureAgents[0]!;
    const { rerender } = renderHook(({ agents, session }) => useAgentTransitions(agents, agent.paneId, session), {
      initialProps: { agents: [agent], session: "first" },
    });
    rerender({ agents: [{ ...agent, status: "done" }], session: "first" });
    rerender({ agents: [{ ...agent, status: "blocked" }], session: "second" });
    expect(setStatus).not.toHaveBeenCalled();
  });
});
