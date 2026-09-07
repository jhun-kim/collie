import {
  decodeTerminalFrame,
  liveTerminalUrl,
  parseTerminalServerMessage,
  specialKeyInput,
  terminalInput,
  terminalRelease,
  terminalResize,
} from "./live-terminal";

describe("live terminal protocol helpers", () => {
  it("builds same-origin websocket URLs with pane, session, mode, and dimensions", () => {
    window.history.replaceState(null, "", "/pane/w1:p1");

    expect(
      liveTerminalUrl({
        paneId: "w1:p1",
        session: "work",
        mode: "control",
        dimensions: { cols: 100, rows: 32 },
      }),
    ).toBe("/ws/terminal/w1%3Ap1?mode=control&cols=100&rows=32&session=work");
  });

  it("decodes ansi base64 frames into bytes", () => {
    const message = parseTerminalServerMessage(
      JSON.stringify({
        type: "terminal.frame",
        encoding: "ansi",
        bytes: btoa("\u001b[31mred"),
        width: 80,
        height: 24,
        full: true,
        seq: 7,
      }),
    );

    expect(message).toMatchObject({ type: "terminal.frame", full: true, seq: 7 });
    if (message.type !== "terminal.frame") throw new Error("expected frame");
    expect([...decodeTerminalFrame(message)]).toEqual([...new TextEncoder().encode("\u001b[31mred")]);
  });

  it("serializes only the client commands the bridge accepts", () => {
    expect(terminalInput("ls\n")).toBe('{"cmd":"terminal.input","text":"ls\\n"}');
    expect(terminalResize({ cols: 90, rows: 30 })).toBe('{"cmd":"terminal.resize","cols":90,"rows":30}');
    expect(terminalRelease()).toBe('{"cmd":"terminal.release"}');
  });

  it("maps the mobile special keys to terminal input text", () => {
    expect(specialKeyInput("Escape")).toBe("\u001b");
    expect(specialKeyInput("Ctrl+C")).toBe("\u0003");
    expect(specialKeyInput("Enter")).toBe("\r");
    expect(specialKeyInput("Backspace")).toBe("\u007f");
    expect(specialKeyInput("Shift+Tab")).toBe("\u001b[Z");
    expect(specialKeyInput("ArrowUp")).toBe("\u001b[A");
  });

  it("rejects malformed server records", () => {
    expect(() => parseTerminalServerMessage('{"type":"terminal.frame","encoding":"text"}')).toThrow(
      /ansi bytes/,
    );
    expect(() => parseTerminalServerMessage('{"type":"other"}')).toThrow(/unknown/);
  });
});
