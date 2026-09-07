import { Component, type ReactNode } from "react";

/** Keep a failed terminal chunk/render from taking down pane navigation and reply drafts. */
export class TerminalErrorBoundary extends Component<
  { children: ReactNode; onReply: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm">The terminal couldn’t load. Reload to try again, or open Reply.</p>
        <div className="flex gap-3">
          <button type="button" className="min-h-11 rounded-lg border px-3 text-sm" onClick={() => window.location.reload()}>
            Reload terminal
          </button>
          <button type="button" className="min-h-11 rounded-lg border px-3 text-sm" onClick={this.props.onReply}>
            Open Reply
          </button>
        </div>
      </section>
    );
  }
}
