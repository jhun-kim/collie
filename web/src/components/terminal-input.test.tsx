import { createRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TerminalInput } from "./terminal-input";
import type { TerminalInputHandle } from "./terminal-input";
import type { TerminalDraft } from "@/lib/terminal-edit";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";

function setCaret(el: HTMLTextAreaElement, start: number, end = start) {
  el.setSelectionRange(start, end);
  fireEvent.select(el);
}

function renderInput({
  enabled = true,
  draft = { text: "", cursor: 0 },
  revision = 1,
  onSend = vi.fn(),
}: {
  enabled?: boolean;
  draft?: TerminalDraft | null;
  revision?: number;
  onSend?: (data: string) => void;
} = {}) {
  const ref = createRef<TerminalInputHandle>();
  render(
    <TerminalInput
      ref={ref}
      enabled={enabled}
      remoteFrame={{ draft, revision }}
      onSend={onSend}
    />,
  );
  return { ref, onSend, input: screen.getByLabelText("Terminal input") as HTMLTextAreaElement };
}

function renderRemoteHarness(onSend = vi.fn()) {
  const ref = createRef<TerminalInputHandle>();
  function Harness() {
    const [remoteFrame, setRemoteFrame] = useState<{ draft: TerminalDraft | null; revision: number }>({
      draft: { text: "he", cursor: 2 },
      revision: 1,
    });
    return (
      <>
        <button type="button" onClick={() => setRemoteFrame({ draft: { text: "he", cursor: 2 }, revision: 2 })}>
          old echo
        </button>
        <button type="button" onClick={() => setRemoteFrame({ draft: { text: "hel", cursor: 3 }, revision: 3 })}>
          final echo
        </button>
        <button type="button" onClick={() => setRemoteFrame({ draft: { text: "server", cursor: 6 }, revision: 4 })}>
          server correction
        </button>
        <TerminalInput ref={ref} enabled remoteFrame={remoteFrame} onSend={onSend} />
      </>
    );
  }
  render(<Harness />);
  return { ref, onSend, input: screen.getByLabelText("Terminal input") as HTMLTextAreaElement };
}

describe("TerminalInput", () => {
  it("sends native inserted text through editTerminalDraft", () => {
    const { input, onSend } = renderInput({ draft: { text: "he", cursor: 2 } });
    input.focus();
    setCaret(input, 2);

    fireEvent.change(input, { target: { value: "hel", selectionStart: 3, selectionEnd: 3 } });

    expect(onSend).toHaveBeenCalledWith("l");
    expect(input).toHaveValue("hel");
  });

  it("turns a native selection replacement into relative cursor and backspace edits", () => {
    const { input, onSend } = renderInput({ draft: { text: "hello", cursor: 5 } });
    input.focus();
    setCaret(input, 1, 4);

    fireEvent.change(input, { target: { value: "ho", selectionStart: 1, selectionEnd: 1 } });

    expect(onSend).toHaveBeenCalledWith(`${LEFT}${BACKSPACE.repeat(3)}`);
    expect(input).toHaveValue("ho");
  });

  it("sends accessory Backspace with collapsed and selected carets", () => {
    const { ref, input, onSend } = renderInput({ draft: { text: "a👍b", cursor: 4 } });
    input.focus();
    setCaret(input, 3);

    act(() => ref.current?.sendKey("Backspace"));
    expect(onSend).toHaveBeenLastCalledWith(BACKSPACE);
    expect(input).toHaveValue("ab");

    setCaret(input, 0, 2);
    act(() => ref.current?.sendKey("Backspace"));
    expect(onSend).toHaveBeenLastCalledWith(`${RIGHT}${BACKSPACE.repeat(2)}`);
    expect(input).toHaveValue("");
  });

  it("moves left and right by grapheme", () => {
    const { ref, input, onSend } = renderInput({ draft: { text: "a👍b", cursor: 4 } });
    input.focus();

    act(() => ref.current?.sendKey("ArrowLeft"));
    expect(onSend).toHaveBeenLastCalledWith(LEFT);
    expect(input.selectionStart).toBe(3);

    act(() => ref.current?.sendKey("ArrowRight"));
    expect(onSend).toHaveBeenLastCalledWith(RIGHT);
    expect(input.selectionStart).toBe(4);
  });

  it("sends Enter and Ctrl+C as raw special keys and clears the visible draft", () => {
    const { ref, input, onSend } = renderInput({ draft: { text: "npm test", cursor: 8 } });
    input.focus();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith("\r");
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "sleep", selectionStart: 5, selectionEnd: 5 } });
    act(() => ref.current?.sendKey("Ctrl+C"));
    expect(onSend).toHaveBeenLastCalledWith("\u0003");
    expect(input).toHaveValue("");
  });

  it("keeps Enter-cleared input empty across old draft and null echoes", () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <TerminalInput
        enabled
        remoteFrame={{ draft: { text: "npm test", cursor: 8 }, revision: 1 }}
        onSend={onSend}
      />,
    );
    const input = screen.getByLabelText("Terminal input");

    fireEvent.keyDown(input, { key: "Enter" });
    rerender(
      <TerminalInput
        enabled
        remoteFrame={{ draft: { text: "npm test", cursor: 8 }, revision: 2 }}
        onSend={onSend}
      />,
    );
    rerender(<TerminalInput enabled remoteFrame={{ draft: null, revision: 3 }} onSend={onSend} />);

    expect(onSend).toHaveBeenCalledWith("\r");
    expect(input).toHaveValue("");
  });

  it("keeps Ctrl+C-cleared input empty across old draft and null echoes", () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <TerminalInput
        enabled
        remoteFrame={{ draft: { text: "sleep 10", cursor: 8 }, revision: 1 }}
        onSend={onSend}
      />,
    );
    const input = screen.getByLabelText("Terminal input");

    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    rerender(
      <TerminalInput
        enabled
        remoteFrame={{ draft: { text: "sleep 10", cursor: 8 }, revision: 2 }}
        onSend={onSend}
      />,
    );
    rerender(<TerminalInput enabled remoteFrame={{ draft: null, revision: 3 }} onSend={onSend} />);

    expect(onSend).toHaveBeenCalledWith("\u0003");
    expect(input).toHaveValue("");
  });

  it("sends Tab and history keys raw, then adopts the next remote echo", async () => {
    const user = userEvent.setup();
    const { input, onSend } = renderRemoteHarness();

    fireEvent.keyDown(input, { key: "Tab" });
    expect(onSend).toHaveBeenLastCalledWith("\t");
    await user.click(screen.getByRole("button", { name: "server correction" }));

    expect(input).toHaveValue("server");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onSend).toHaveBeenLastCalledWith("\x1b[A");
  });

  it("sends native Escape as a raw special key", () => {
    const { input, onSend } = renderInput({ draft: { text: "open", cursor: 4 } });

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onSend).toHaveBeenCalledWith("\x1b");
    expect(input).toHaveValue("open");
  });

  it("ignores older optimistic echoes and clears pending on the final match", async () => {
    const user = userEvent.setup();
    const { input, onSend } = renderRemoteHarness();
    input.focus();
    setCaret(input, 2);

    fireEvent.change(input, { target: { value: "hel", selectionStart: 3, selectionEnd: 3 } });
    expect(onSend).toHaveBeenLastCalledWith("l");
    await user.click(screen.getByRole("button", { name: "old echo" }));
    expect(input).toHaveValue("hel");

    await user.click(screen.getByRole("button", { name: "final echo" }));
    expect(input).toHaveValue("hel");

    await user.click(screen.getByRole("button", { name: "server correction" }));
    expect(input).toHaveValue("server");
  });

  it("adopts an unmatched remote correction after the recovery window", async () => {
    vi.useFakeTimers();
    try {
      const { input } = renderRemoteHarness();
      input.focus();

      fireEvent.change(input, { target: { value: "local", selectionStart: 5, selectionEnd: 5 } });
      fireEvent.click(screen.getByRole("button", { name: "server correction" }));
      expect(input).toHaveValue("local");

      act(() => vi.advanceTimersByTime(1_500));
      expect(input).toHaveValue("server");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send intermediate IME composition changes", () => {
    const { input, onSend } = renderInput();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "ㅎ", selectionStart: 1, selectionEnd: 1 } });
    expect(input).toHaveValue("ㅎ");
    fireEvent.change(input, { target: { value: "한", selectionStart: 1, selectionEnd: 1 } });
    expect(input).toHaveValue("한");
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { data: "한" });
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith("한");
  });

  it("commits active IME composition before an accessory Enter and ignores the later compositionend", () => {
    const { ref, input, onSend } = renderInput();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "한", selectionStart: 1, selectionEnd: 1 } });
    act(() => ref.current?.sendKey("Enter"));
    fireEvent.compositionEnd(input, { data: "한" });

    expect(onSend).toHaveBeenNthCalledWith(1, "한");
    expect(onSend).toHaveBeenNthCalledWith(2, "\r");
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(input).toHaveValue("");
  });

  it("does not clear local text when the remote draft is unknown", () => {
    function Harness() {
      const [remoteFrame, setRemoteFrame] = useState<{ draft: TerminalDraft | null; revision: number }>({
        draft: { text: "local", cursor: 5 },
        revision: 1,
      });
      return (
        <>
          <button type="button" onClick={() => setRemoteFrame({ draft: null, revision: 2 })}>
            unknown
          </button>
          <TerminalInput enabled remoteFrame={remoteFrame} onSend={vi.fn()} />
        </>
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText("Terminal input");

    fireEvent.click(screen.getByRole("button", { name: "unknown" }));

    expect(input).toHaveValue("local");
  });

  it("keeps an active selection when an identical remote frame repeats", async () => {
    const onSend = vi.fn();
    const firstFrame = { draft: { text: "select me", cursor: 9 }, revision: 1 };
    const secondFrame = { draft: { text: "select me", cursor: 9 }, revision: 2 };
    const { rerender } = render(<TerminalInput enabled remoteFrame={firstFrame} onSend={onSend} />);
    const input = screen.getByLabelText("Terminal input") as HTMLTextAreaElement;
    input.focus();
    setCaret(input, 0, 6);

    rerender(<TerminalInput enabled remoteFrame={secondFrame} onSend={onSend} />);

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(6);
  });

  it("focus(reopen) refocuses with preventScroll", () => {
    const { ref, input } = renderInput();
    const focusSpy = vi.spyOn(input, "focus");
    const blurSpy = vi.spyOn(input, "blur");

    act(() => ref.current?.focus(true));

    expect(blurSpy).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(input).toHaveFocus();
  });

  it("honors the enabled gate for native and imperative input", () => {
    const { ref, input, onSend } = renderInput({ enabled: false, draft: { text: "locked", cursor: 6 } });

    fireEvent.change(input, { target: { value: "locked!", selectionStart: 7, selectionEnd: 7 } });
    act(() => ref.current?.sendKey("Enter"));
    act(() => ref.current?.focus());

    expect(onSend).not.toHaveBeenCalled();
    expect(input).toBeDisabled();
    expect(input).not.toHaveFocus();
  });
});
