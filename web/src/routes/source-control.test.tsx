import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { server } from "@/test/setup";
import { fixtureSnapshot } from "@/test/handlers";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { SourceControlRoute } from "./source-control";

function homeData(readOnly = false): HomeData {
  return {
    bridge: fixtureSnapshot.bridge,
    device: readOnly ? { enforced: true, device: "phone", authorized: false } : undefined,
    agents: fixtureSnapshot.agents,
    shellPanes: fixtureSnapshot.shellPanes,
    workspaces: fixtureSnapshot.workspaces,
    tabs: fixtureSnapshot.tabs,
    sessions: fixtureSnapshot.sessions ?? [],
    session: "demo",
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
}

function renderSource(readOnly = false) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(readOnly),
        element: <Outlet />,
        children: [{ path: "space/:spaceId/git", element: <SourceControlRoute /> }],
      },
    ],
    { initialEntries: ["/space/w2/git?s=demo"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("SourceControlRoute", () => {
  it("renders branch status, lists changes, and stages through the bridge API", async () => {
    const stageBodies: unknown[] = [];
    let staged = false;
    server.use(
      http.get("/api/git/status", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("workspaceId")).toBe("w2");
        expect(url.searchParams.get("session")).toBe("demo");
        return HttpResponse.json({
          workspaceId: "w2",
          branch: "main",
          upstream: "origin/main",
          ahead: 1,
          behind: 0,
          detached: false,
          truncated: false,
          changed: [{ path: "src/app.tsx", status: "M", staged }],
        });
      }),
      http.get("/api/git/diff", ({ request }) => {
        const url = new URL(request.url);
        return HttpResponse.json({
          workspaceId: "w2",
          file: url.searchParams.get("file") ?? "",
          staged: url.searchParams.get("staged") === "true",
          truncated: false,
          diff: "diff --git a/src/app.tsx b/src/app.tsx\n-old\n+new",
        });
      }),
      http.post("/api/git/stage", async ({ request }) => {
        const body = await request.json();
        stageBodies.push(body);
        staged = true;
        return HttpResponse.json({ workspaceId: "w2", files: ["src/app.tsx"] });
      }),
    );

    const user = userEvent.setup();
    renderSource();

    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.getByText(/origin\/main/)).toBeInTheDocument();
    expect(await screen.findByText("src/app.tsx")).toBeInTheDocument();
    expect(await screen.findByText("+new")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stage" }));

    await waitFor(() =>
      expect(stageBodies).toEqual([{ workspaceId: "w2", files: ["src/app.tsx"] }]),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Unstage" })).toBeInTheDocument());
  });

  it("uses a two-step commit and blocks blank commit messages", async () => {
    const commits: unknown[] = [];
    server.use(
      http.get("/api/git/status", () =>
        HttpResponse.json({
          workspaceId: "w2",
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          detached: false,
          truncated: false,
          changed: [{ path: "README.md", status: "M", staged: true }],
        }),
      ),
      http.get("/api/git/diff", () =>
        HttpResponse.json({
          workspaceId: "w2",
          file: "README.md",
          staged: true,
          truncated: false,
          diff: "+docs",
        }),
      ),
      http.post("/api/git/commit", async ({ request }) => {
        const body = await request.json();
        commits.push(body);
        return HttpResponse.json({ workspaceId: "w2", message: "docs", output: "[main abc] docs" });
      }),
    );

    const user = userEvent.setup();
    renderSource();

    await screen.findByText("README.md");
    await user.click(screen.getByRole("button", { name: "Commit" }));
    expect(screen.getByPlaceholderText("Commit message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tap to commit" })).toBeDisabled();
    expect(commits).toEqual([]);

    await user.type(screen.getByPlaceholderText("Commit message"), "docs");
    await user.click(screen.getByRole("button", { name: "Tap to commit" }));

    await waitFor(() => expect(commits).toEqual([{ workspaceId: "w2", message: "docs" }]));
    expect(await screen.findByText("[main abc] docs")).toBeInTheDocument();
  });

  it("disables write actions for read-only devices", async () => {
    server.use(
      http.get("/api/git/status", () =>
        HttpResponse.json({
          workspaceId: "w2",
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          detached: false,
          truncated: false,
          changed: [{ path: "src/app.tsx", status: "M", staged: false }],
        }),
      ),
      http.get("/api/git/diff", () =>
        HttpResponse.json({
          workspaceId: "w2",
          file: "src/app.tsx",
          staged: false,
          truncated: false,
          diff: "+new",
        }),
      ),
    );

    renderSource(true);

    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Stage" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });

  it("does not refresh the old workspace after a mutation resolves post-navigation", async () => {
    const statusWorkspaceIds: string[] = [];
    let resolveStage: ((response: Response) => void) | undefined;
    server.use(
      http.get("/api/git/status", ({ request }) => {
        const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
        statusWorkspaceIds.push(workspaceId);
        return HttpResponse.json({
          workspaceId,
          branch: workspaceId === "w1" ? "feature" : "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          detached: false,
          truncated: false,
          changed: workspaceId === "w2" ? [{ path: "src/app.tsx", status: "M", staged: false }] : [],
        });
      }),
      http.get("/api/git/diff", () =>
        HttpResponse.json({
          workspaceId: "w2",
          file: "src/app.tsx",
          staged: false,
          truncated: false,
          diff: "+new",
        }),
      ),
      http.post("/api/git/stage", () =>
        new Promise<Response>((resolve) => {
          resolveStage = resolve;
        }),
      ),
    );

    const user = userEvent.setup();
    const router = renderSource();
    await screen.findByText("src/app.tsx");
    await user.click(screen.getByRole("button", { name: "Stage" }));
    const oldWorkspaceRefreshes = statusWorkspaceIds.filter((id) => id === "w2").length;

    await act(async () => {
      await router.navigate("/space/w1/git?s=demo");
    });
    expect(await screen.findByText("feature")).toBeInTheDocument();

    resolveStage?.(HttpResponse.json({ workspaceId: "w2", files: ["src/app.tsx"] }));
    await waitFor(() =>
      expect(statusWorkspaceIds.filter((id) => id === "w2")).toHaveLength(oldWorkspaceRefreshes),
    );
  });
});
