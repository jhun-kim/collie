import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { server } from "@/test/setup";
import { fixtureSnapshot } from "@/test/handlers";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { FilesRoute } from "./files";

function homeData(): HomeData {
  return {
    bridge: fixtureSnapshot.bridge,
    device: fixtureSnapshot.device,
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

function renderFiles() {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => homeData(),
        element: <Outlet />,
        children: [{ path: "space/:spaceId/files", element: <FilesRoute /> }],
      },
    ],
    { initialEntries: ["/space/w2/files?s=demo"] },
  );
  render(<RouterProvider router={router} />);
}

describe("FilesRoute", () => {
  it("lazy-expands and collapses a folder while preserving folder navigation", async () => {
    const requests: string[] = [];
    server.use(
      http.get("/api/files", ({ request }) => {
        const url = new URL(request.url);
        requests.push(url.search);
        const path = url.searchParams.get("path") ?? "";
        if (path === "src") {
          return HttpResponse.json({
            workspaceId: "w2",
            root: "/repo",
            path: "src",
            depth: 2,
            truncated: false,
            entries: [{ name: "README.md", type: "file", path: "src/README.md", size: 42 }],
          });
        }
        return HttpResponse.json({
          workspaceId: "w2",
          root: "/repo",
          path: "",
          depth: 2,
          truncated: false,
          entries: [{ name: "src", type: "dir", path: "src" }],
        });
      }),
      http.get("/api/file", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("workspaceId")).toBe("w2");
        expect(url.searchParams.get("path")).toBe("src/README.md");
        expect(url.searchParams.get("session")).toBe("demo");
        return HttpResponse.json({
          workspaceId: "w2",
          path: "src/README.md",
          kind: "text",
          mime: "text/plain",
          encoding: "utf-8",
          size: 29,
          content: "# Hello\n<script>bad()</script>",
        });
      }),
    );

    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole("button", { name: "Expand src" }));
    expect(await screen.findByRole("button", { name: /README\.md/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse src" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse src" }));
    expect(screen.queryByRole("button", { name: /README\.md/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open src" }));
    expect(await screen.findByRole("button", { name: /README\.md/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /README\.md/ }));
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("<script>bad()</script>")).toBeInTheDocument();
    expect(requests.some((query) => query.includes("workspaceId=w2") && query.includes("session=demo"))).toBe(true);

    await user.click(screen.getByRole("button", { name: "Parent" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand src" })).toBeInTheDocument());
  });

  it("retries the same path after a bounded API failure", async () => {
    let failed = false;
    server.use(
      http.get("/api/files", () => {
        if (!failed) {
          failed = true;
          return HttpResponse.text("directory is not readable", { status: 403 });
        }
        return HttpResponse.json({
          workspaceId: "w2",
          root: "/repo",
          path: "",
          depth: 1,
          truncated: false,
          entries: [{ name: "package.json", type: "file", path: "package.json", size: 10 }],
        });
      }),
    );

    const user = userEvent.setup();
    renderFiles();

    expect(await screen.findByRole("alert")).toHaveTextContent("directory is not readable");
    expect(screen.getByText("Files")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(await screen.findByRole("button", { name: /package\.json/ })).toBeInTheDocument();
  });

  it("ignores a stale file preview response after another file is selected", async () => {
    let resolveSlow: ((response: Response) => void) | undefined;
    server.use(
      http.get("/api/files", () =>
        HttpResponse.json({
          workspaceId: "w2",
          root: "/repo",
          path: "",
          depth: 1,
          truncated: false,
          entries: [
            { name: "a.md", type: "file", path: "a.md", size: 1 },
            { name: "b.md", type: "file", path: "b.md", size: 1 },
          ],
        }),
      ),
      http.get("/api/file", ({ request }) => {
        const path = new URL(request.url).searchParams.get("path");
        if (path === "a.md") {
          return new Promise<Response>((resolve) => {
            resolveSlow = resolve;
          });
        }
        return HttpResponse.json({
          workspaceId: "w2",
          path: "b.md",
          kind: "text",
          mime: "text/plain",
          encoding: "utf-8",
          size: 7,
          content: "# Newer",
        });
      }),
    );

    const user = userEvent.setup();
    renderFiles();

    await user.click(await screen.findByRole("button", { name: /a\.md/ }));
    await user.click(screen.getByRole("button", { name: /b\.md/ }));
    expect(await screen.findByText("Newer")).toBeInTheDocument();

    resolveSlow?.(
      HttpResponse.json({
        workspaceId: "w2",
        path: "a.md",
        kind: "text",
        mime: "text/plain",
        encoding: "utf-8",
        size: 7,
        content: "# Stale",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Stale")).not.toBeInTheDocument());
  });
});
