import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView, WorkspaceView } from "@/lib/types";
import { server } from "@/test/setup";

import { WorktreesRoute } from "./worktrees";

vi.mock("@/hooks/use-loading-stalled", () => ({ useLoadingStalled: () => false }));

type JsonResponse = ReturnType<typeof HttpResponse.json>;

function workspace(workspaceId: string, label: string, focused = false): WorkspaceView {
  return {
    workspaceId,
    number: 1,
    label,
    focused,
    activeTabId: `${workspaceId}:t1`,
    tabCount: 1,
    paneCount: 1,
  };
}

function agent(workspaceId: string, status: AgentView["status"]): AgentView {
  return {
    paneId: `${workspaceId}:p1`,
    workspaceId,
    workspaceLabel: workspaceId,
    workspaceNumber: 1,
    tabId: `${workspaceId}:t1`,
    agent: "claude",
    status,
    cwd: "/repo",
    focused: false,
  };
}

function homeData(overrides: Partial<HomeData> = {}): HomeData {
  return {
  bridge: "connected",
  device: undefined,
  agents: [agent("w-open", "blocked")],
  shellPanes: [],
  workspaces: [workspace("w-main", "main", true), workspace("w-open", "feature")],
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

function makeRouter(initialPath = "/worktrees", loader: () => HomeData = () => homeData()) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader,
        element: <Outlet />,
        children: [
          { path: "worktrees", element: <WorktreesRoute /> },
          { path: "space/:spaceId", element: <div data-testid="space-detail">space detail</div> },
          { path: "pane/:paneId", element: <div data-testid="pane-detail">pane detail</div> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );
}

function worktree(label: string, path: string, open_workspace_id?: string | null) {
  return {
    path,
    branch: label,
    is_bare: false,
    is_detached: false,
    is_prunable: false,
    is_linked_worktree: true,
    label,
    open_workspace_id,
  };
}

describe("WorktreesRoute", () => {
  it("loads worktrees for the selected workspace and opens an already-open worktree detail", async () => {
    let requested = "";
    let requestedGit = "";
    server.use(
      http.get("/api/worktrees", ({ request }) => {
        const url = new URL(request.url);
        requested = `${url.searchParams.get("workspaceId")}:${url.searchParams.get("session")}`;
        return HttpResponse.json({
          type: "worktree_list",
          source: {
            repo_key: "repo",
            repo_name: "repo",
            repo_root: "/repo",
            source_checkout_path: "/repo",
          },
          worktrees: [
            worktree("z-closed", "/repo/z"),
            worktree("a-blocked", "/repo/a", "w-open"),
          ],
        });
      }),
      http.get("/api/git/status", ({ request }) => {
        const url = new URL(request.url);
        requestedGit = `${url.searchParams.get("workspaceId")}:${url.searchParams.get("session")}`;
        return HttpResponse.json({
          workspaceId: "w-open",
          branch: "a-blocked",
          upstream: "origin/a-blocked",
          ahead: 0,
          behind: 0,
          detached: false,
          truncated: false,
          changed: [{ path: "src/app.ts", status: "M", staged: true }],
        });
      }),
    );
    const router = makeRouter();
    render(<RouterProvider router={router} />);

    expect(await screen.findAllByText("a-blocked")).toHaveLength(2);
    expect(requested).toBe("w-main:demo");
    expect(await screen.findByText("1 staged")).toBeInTheDocument();
    expect(requestedGit).toBe("w-open:demo");
    expect(screen.getByRole("button", { name: "main" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "feature" })).toBeInTheDocument();
    expect(screen.getAllByText("z-closed")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: /a-blocked/i }));
    expect(await screen.findByTestId("space-detail")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/space/w-open");
  });

  it("creates a worktree and navigates to its fresh shell", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/worktrees", () =>
        HttpResponse.json({
          type: "worktree_list",
          source: {
            repo_key: "repo",
            repo_name: "repo",
            repo_root: "/repo",
            source_checkout_path: "/repo",
          },
          worktrees: [],
        }),
      ),
      http.post("/api/worktrees", async ({ request }) => {
        expect(await request.json()).toEqual({ workspaceId: "w-main", branch: "feature/new" });
        return HttpResponse.json({
          type: "worktree_created",
          workspace: { workspace_id: "w-new", label: "feature/new" },
          root_pane: {
            pane_id: "w-new:p1",
            workspace_id: "w-new",
            tab_id: "w-new:t1",
            cwd: "/repo/feature-new",
          },
          worktree: worktree("feature/new", "/repo/feature-new", "w-new"),
        });
      }),
    );
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    await screen.findByText(/no worktrees/i);

    await user.click(screen.getByRole("button", { name: /new worktree/i }));
    await user.type(screen.getByLabelText(/^branch$/i), "feature/new");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /create worktree/i }));
    });

    expect(await screen.findByTestId("pane-detail")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/pane/w-new%3Ap1");
  });

  it("opens a closed worktree through the API and navigates to its fresh shell", async () => {
    server.use(
      http.get("/api/worktrees", () =>
        HttpResponse.json({
          type: "worktree_list",
          source: {
            repo_key: "repo",
            repo_name: "repo",
            repo_root: "/repo",
            source_checkout_path: "/repo",
          },
          worktrees: [worktree("closed", "/repo/closed")],
        }),
      ),
      http.post("/api/worktrees/open", async ({ request }) => {
        expect(await request.json()).toEqual({ workspaceId: "w-main", path: "/repo/closed" });
        return HttpResponse.json({
          type: "worktree_opened",
          workspace: { workspace_id: "w-closed", label: "closed" },
          tab: { tab_id: "w-closed:t1" },
          root_pane: {
            pane_id: "w-closed:p1",
            workspace_id: "w-closed",
            tab_id: "w-closed:t1",
            cwd: "/repo/closed",
          },
          worktree: worktree("closed", "/repo/closed", "w-closed"),
          already_open: false,
        });
      }),
    );
    const router = makeRouter();
    render(<RouterProvider router={router} />);

    await userEvent.click(await screen.findByRole("button", { name: /closed/i }));

    expect(await screen.findByTestId("pane-detail")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/pane/w-closed%3Ap1");
  });

  it("shows unknown git state when an open worktree workspace is not a readable repo", async () => {
    server.use(
      http.get("/api/worktrees", () =>
        HttpResponse.json({
          type: "worktree_list",
          source: {
            repo_key: "repo",
            repo_name: "repo",
            repo_root: "/repo",
            source_checkout_path: "/repo",
          },
          worktrees: [worktree("not-readable", "/repo/not-readable", "w-open")],
        }),
      ),
      http.get("/api/git/status", () => new HttpResponse("forbidden", { status: 403 })),
    );
    render(<RouterProvider router={makeRouter()} />);

    expect(await screen.findByText("git unknown")).toBeInTheDocument();
  });

  it("keeps existing spaces reachable when the worktree API fails", async () => {
    server.use(http.get("/api/worktrees", () => new HttpResponse("down", { status: 502 })));
    const router = makeRouter();
    render(<RouterProvider router={router} />);

    expect(await screen.findByText("Worktrees unavailable")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: /main/i }).at(-1)!);
    expect(router.state.location.pathname).toBe("/space/w-main");
  });

  it("refreshes worktrees on root revalidation even when snapshot content is unchanged", async () => {
    let list = [worktree("old", "/repo/old")];
    let secondFetchResolve: (value: JsonResponse) => void = () => {};
    let calls = 0;
    server.use(
      http.get("/api/worktrees", () => {
        calls += 1;
        const response = () =>
          HttpResponse.json({
            type: "worktree_list",
            source: {
              repo_key: "repo",
              repo_name: "repo",
              repo_root: "/repo",
              source_checkout_path: "/repo",
            },
            worktrees: list,
          });
        if (calls === 2) {
          return new Promise<JsonResponse>((resolve) => {
            secondFetchResolve = resolve;
          });
        }
        return response();
      }),
    );
    const router = makeRouter("/worktrees", () => homeData());
    render(<RouterProvider router={router} />);

    expect(await screen.findAllByText("old")).toHaveLength(2);
    list = [worktree("new", "/repo/new")];

    await act(async () => {
      await router.revalidate();
    });
    expect(screen.getAllByText("old")).toHaveLength(2);
    expect(screen.queryByText("new")).not.toBeInTheDocument();

    await act(async () => {
      secondFetchResolve(
        HttpResponse.json({
          type: "worktree_list",
          source: {
            repo_key: "repo",
            repo_name: "repo",
            repo_root: "/repo",
            source_checkout_path: "/repo",
          },
          worktrees: list,
        }),
      );
    });
    expect(await screen.findAllByText("new")).toHaveLength(2);
    expect(screen.queryByText("Worktrees unavailable")).not.toBeInTheDocument();
  });

  it("keeps the create dialog open with an inline error when route create fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/worktrees", () =>
        HttpResponse.json({
          type: "worktree_list",
          source: {
            repo_key: "repo",
            repo_name: "repo",
            repo_root: "/repo",
            source_checkout_path: "/repo",
          },
          worktrees: [],
        }),
      ),
      http.post("/api/worktrees", () => new HttpResponse("branch exists", { status: 502 })),
    );
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    await screen.findByText(/no worktrees/i);

    await user.click(screen.getByRole("button", { name: /new worktree/i }));
    await user.type(screen.getByLabelText(/^branch$/i), "feature/fail");
    await user.click(screen.getByRole("button", { name: /create worktree/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("branch exists");
    expect(screen.getByLabelText(/^branch$/i)).toHaveValue("feature/fail");
    expect(router.state.location.pathname).toBe("/worktrees");
  });

  it("ignores duplicate open taps while an open request is pending", async () => {
    let openCalls = 0;
    let resolveOpen: (value: JsonResponse) => void = () => {};
    server.use(
      http.get("/api/worktrees", () =>
        HttpResponse.json({
          type: "worktree_list",
          source: {
            repo_key: "repo",
            repo_name: "repo",
            repo_root: "/repo",
            source_checkout_path: "/repo",
          },
          worktrees: [worktree("closed", "/repo/closed")],
        }),
      ),
      http.post(
        "/api/worktrees/open",
        () => {
          openCalls += 1;
          return new Promise<JsonResponse>((resolve) => {
            resolveOpen = resolve;
          });
        },
      ),
    );
    const router = makeRouter();
    render(<RouterProvider router={router} />);

    const button = await screen.findByRole("button", { name: /closed/i });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(openCalls).toBe(1);

    await act(async () => {
      resolveOpen(
        HttpResponse.json({
          type: "worktree_opened",
          workspace: { workspace_id: "w-closed", label: "closed" },
          tab: { tab_id: "w-closed:t1" },
          root_pane: {
            pane_id: "w-closed:p1",
            workspace_id: "w-closed",
            tab_id: "w-closed:t1",
            cwd: "/repo/closed",
          },
          worktree: worktree("closed", "/repo/closed", "w-closed"),
          already_open: false,
        }),
      );
    });
    expect(await screen.findByTestId("pane-detail")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/pane/w-closed%3Ap1");
  });

  it("does not navigate after create completes if the route has unmounted", async () => {
    let resolveCreate: (value: JsonResponse) => void = () => {};
    server.use(
      http.get("/api/worktrees", () =>
        HttpResponse.json({
          type: "worktree_list",
          source: {
            repo_key: "repo",
            repo_name: "repo",
            repo_root: "/repo",
            source_checkout_path: "/repo",
          },
          worktrees: [],
        }),
      ),
      http.post(
        "/api/worktrees",
        () =>
          new Promise<JsonResponse>((resolve) => {
            resolveCreate = resolve;
          }),
      ),
    );
    const router = makeRouter();
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);
    await screen.findByText(/no worktrees/i);

    await user.click(screen.getByRole("button", { name: /new worktree/i }));
    await user.type(screen.getByLabelText(/^branch$/i), "feature/new");
    await user.click(screen.getByRole("button", { name: /create worktree/i }));
    await act(async () => {
      await router.navigate("/space/w-main");
    });
    await act(async () => {
      resolveCreate(
        HttpResponse.json({
          type: "worktree_created",
          workspace: { workspace_id: "w-new", label: "feature/new" },
          root_pane: {
            pane_id: "w-new:p1",
            workspace_id: "w-new",
            tab_id: "w-new:t1",
            cwd: "/repo/feature-new",
          },
          worktree: worktree("feature/new", "/repo/feature-new", "w-new"),
        }),
      );
    });

    expect(router.state.location.pathname).toBe("/space/w-main");
  });

  it("does not navigate after open completes if the session changed", async () => {
    let resolveOpen: (value: JsonResponse) => void = () => {};
    let snapshot = homeData({ session: "demo" });
    server.use(
      http.get("/api/worktrees", () =>
        HttpResponse.json({
          type: "worktree_list",
          source: {
            repo_key: "repo",
            repo_name: "repo",
            repo_root: "/repo",
            source_checkout_path: "/repo",
          },
          worktrees: [worktree("closed", "/repo/closed")],
        }),
      ),
      http.post(
        "/api/worktrees/open",
        () =>
          new Promise<JsonResponse>((resolve) => {
            resolveOpen = resolve;
          }),
      ),
    );
    const router = makeRouter("/worktrees?s=demo", () => snapshot);
    render(<RouterProvider router={router} />);

    await userEvent.click(await screen.findByRole("button", { name: /closed/i }));
    snapshot = homeData({ session: "other" });
    await act(async () => {
      await router.revalidate();
    });
    await act(async () => {
      resolveOpen(
        HttpResponse.json({
          type: "worktree_opened",
          workspace: { workspace_id: "w-closed", label: "closed" },
          tab: { tab_id: "w-closed:t1" },
          root_pane: {
            pane_id: "w-closed:p1",
            workspace_id: "w-closed",
            tab_id: "w-closed:t1",
            cwd: "/repo/closed",
          },
          worktree: worktree("closed", "/repo/closed", "w-closed"),
          already_open: false,
        }),
      );
    });

    expect(router.state.location.pathname).toBe("/worktrees");
  });
});
