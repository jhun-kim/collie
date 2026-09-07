import { lazy, Suspense } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalErrorBoundary } from "./terminal-error-boundary";

it("contains a failed lazy terminal import and keeps Reply available", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const BrokenTerminal = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
  const onReply = vi.fn();
  try {
    render(
      <>
        <nav>Pane navigation</nav>
        <TerminalErrorBoundary onReply={onReply}>
          <Suspense fallback="Loading"><BrokenTerminal /></Suspense>
        </TerminalErrorBoundary>
      </>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("terminal couldn’t load");
    expect(screen.getByText("Pane navigation")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload terminal" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open Reply" }));
    expect(onReply).toHaveBeenCalledOnce();
  } finally {
    errorLog.mockRestore();
  }
});
