import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView, WorkspaceView } from "@/lib/types";
import { HomeRoute } from "./home";

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

function workspace(overrides: Partial<WorkspaceView>): WorkspaceView {
  return {
    workspaceId: "w1",
    number: 1,
    label: "webapp",
    focused: false,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
    ...overrides,
  };
}

function homeData(overrides: Partial<HomeData> = {}): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [
      agent({ paneId: "w1:p1", status: "working", agent: "claude" }),
      agent({
        paneId: "w2:p1",
        workspaceId: "w2",
        workspaceLabel: "collie",
        status: "blocked",
        agent: "codex",
        blockingMessage: { text: "Pick an option", capturedAt: 1 },
      }),
    ],
    shellPanes: [
      agent({
        paneId: "w3:p1",
        workspaceId: "w3",
        workspaceLabel: "shells",
        status: "unknown",
        agent: "shell",
        kind: "shell",
      }),
    ],
    workspaces: [workspace({ workspaceId: "w1", label: "webapp" }), workspace({ workspaceId: "w2", label: "collie", tabCount: 2, paneCount: 3 })],
    tabs: [],
    sessions: [],
    session: "demo",
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
    ...overrides,
  };
}

function renderHome(loader: () => HomeData = () => homeData()) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader,
        element: <Outlet />,
        children: [
          { index: true, element: <HomeRoute /> },
          { path: "pane/:paneId", element: <div data-testid="pane">Pane</div> },
          { path: "space/:spaceId", element: <div data-testid="space">Space</div> },
          { path: "worktrees", element: <div data-testid="worktrees">Worktrees</div> },
        ],
      },
    ],
    { initialEntries: ["/?s=demo"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("HomeRoute", () => {
  it("renders a single live board with status lanes and the blocked question", async () => {
    renderHome();
    expect(await screen.findByRole("region", { name: "Live agent board" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Working" })).toHaveTextContent("claude");
    expect(screen.getByRole("region", { name: "Needs you" })).toHaveTextContent("codex");
    expect(screen.getByText("Pick an option")).toBeInTheDocument();
  });

  it("keeps unknown shell panes reachable from the compact section", async () => {
    const user = userEvent.setup();
    const router = renderHome();
    await screen.findByRole("region", { name: "Live agent board" });
    await user.click(screen.getByText(/idle \/ unknown/i));
    await user.click(screen.getByRole("button", { name: /shell/ }));
    expect(router.state.location.pathname).toBe("/pane/w3%3Ap1");
    expect(router.state.location.search).toBe("?s=demo");
  });

  it("keeps spaces, new space, and worktrees accessible without duplicated hero cards", async () => {
    const user = userEvent.setup();
    const router = renderHome();
    await screen.findByRole("region", { name: "Live agent board" });
    await user.click(screen.getByText(/spaces/i));

    const spaces = screen.getByText(/spaces/i).closest("details");
    expect(spaces).not.toBeNull();
    expect(within(spaces!).getByRole("button", { name: /new space/i })).toBeInTheDocument();
    await user.click(within(spaces!).getByRole("button", { name: /collie/ }));
    expect(router.state.location.pathname).toBe("/space/w2");
    expect(router.state.location.search).toBe("?s=demo");

    await router.navigate("/?s=demo");
    await screen.findByRole("region", { name: "Live agent board" });
    await user.click(screen.getByText(/spaces/i));
    const reopenedSpaces = screen.getByText(/spaces/i).closest("details");
    expect(reopenedSpaces).not.toBeNull();
    await user.click(within(reopenedSpaces!).getByRole("link", { name: /worktrees/i }));
    expect(router.state.location.pathname).toBe("/worktrees");
    expect(router.state.location.search).toBe("?s=demo");
  });

  it("pauses and recovers the board status from loader freshness", async () => {
    let snapshot = homeData({ error: true });
    const router = renderHome(() => snapshot);

    expect(await screen.findByText("Updates paused")).toBeInTheDocument();

    snapshot = homeData({ error: false });
    router.revalidate();

    expect(await screen.findByText("Updates live")).toBeInTheDocument();
  });

  it("shows read-only state without hiding the board", async () => {
    renderHome(() =>
      homeData({ device: { enforced: true, device: "phone", authorized: false } }),
    );
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Live agent board" })).toBeInTheDocument();
  });
});
