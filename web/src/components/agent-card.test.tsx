import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentCard } from "./agent-card";
import { fixtureAgents } from "@/test/handlers";

describe("agent question card", () => {
  it("shows the captured question as inert text and opens its pane", async () => {
    const onClick = vi.fn();
    const text = '<img src=x onerror="alert(1)"> Deploy now?';
    const { container } = render(<AgentCard agent={{ ...fixtureAgents[0]!, blockingMessage: { text, capturedAt: 1 } }} onClick={onClick} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelector("img[src=x]")).toBeNull();
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not show an old question after the agent resumes", () => {
    render(<AgentCard agent={{ ...fixtureAgents[0]!, status: "working", blockingMessage: { text: "Old?", capturedAt: 1 } }} onClick={() => {}} />);
    expect(screen.queryByText("Old?")).not.toBeInTheDocument();
  });
});
