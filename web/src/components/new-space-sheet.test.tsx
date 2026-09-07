import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewSpaceSheet } from "./new-space-sheet";
import type { WorkspaceView } from "@/lib/types";

const workspaces: WorkspaceView[] = [
  {
    workspaceId: "w1",
    number: 1,
    label: "main",
    focused: true,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
  },
  {
    workspaceId: "w2",
    number: 2,
    label: "mobile",
    focused: false,
    activeTabId: "w2:t1",
    tabCount: 1,
    paneCount: 1,
  },
];

describe("NewSpaceSheet", () => {
  it("keeps the existing regular space creation flow", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewSpaceSheet open onClose={vi.fn()} onCreate={onCreate} />);

    await user.type(screen.getByLabelText(/directory/i), "/repo");
    await user.type(screen.getByLabelText(/label/i), "demo");
    await user.click(screen.getByRole("button", { name: /create space/i }));

    expect(onCreate).toHaveBeenCalledExactlyOnceWith({ cwd: "/repo", label: "demo" });
  });

  it("requires a branch and creates a worktree from the selected workspace", async () => {
    const user = userEvent.setup();
    const onCreateWorktree = vi.fn();
    render(
      <NewSpaceSheet
        open
        onClose={vi.fn()}
        mode="worktree"
        workspaces={workspaces}
        selectedWorkspaceId="w2"
        onCreateWorktree={onCreateWorktree}
      />,
    );

    const create = screen.getByRole("button", { name: /create worktree/i });
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText(/^branch$/i), "feature/mobile");
    await user.type(screen.getByLabelText(/base/i), "main");
    await user.type(screen.getByLabelText(/label/i), "mobile feature");
    await user.click(create);

    expect(onCreateWorktree).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "w2",
      branch: "feature/mobile",
      base: "main",
      label: "mobile feature",
    });
  });

  it("keeps worktree input open, pending, and inline error on create failure", async () => {
    const user = userEvent.setup();
    let rejectCreate: (error: Error) => void = () => {};
    const onClose = vi.fn();
    const onCreateWorktree = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectCreate = reject;
        }),
    );
    render(
      <NewSpaceSheet
        open
        onClose={onClose}
        mode="worktree"
        workspaces={workspaces}
        selectedWorkspaceId="w2"
        onCreateWorktree={onCreateWorktree}
      />,
    );

    await user.type(screen.getByLabelText(/^branch$/i), "feature/fail");
    await user.click(screen.getByRole("button", { name: /create worktree/i }));

    expect(screen.getByRole("button", { name: /creating worktree/i })).toBeDisabled();
    expect(onCreateWorktree).toHaveBeenCalledOnce();

    rejectCreate(new Error("branch already exists"));
    expect(await screen.findByRole("alert")).toHaveTextContent("branch already exists");
    expect(screen.getByLabelText(/^branch$/i)).toHaveValue("feature/fail");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the worktree sheet only after create succeeds", async () => {
    const user = userEvent.setup();
    let resolveCreate: () => void = () => {};
    const onClose = vi.fn();
    render(
      <NewSpaceSheet
        open
        onClose={onClose}
        mode="worktree"
        workspaces={workspaces}
        selectedWorkspaceId="w2"
        onCreateWorktree={() =>
          new Promise<void>((resolve) => {
            resolveCreate = resolve;
          })
        }
      />,
    );

    await user.type(screen.getByLabelText(/^branch$/i), "feature/success");
    await user.click(screen.getByRole("button", { name: /create worktree/i }));
    expect(onClose).not.toHaveBeenCalled();

    resolveCreate();
    await screen.findByRole("button", { name: /create worktree/i });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
