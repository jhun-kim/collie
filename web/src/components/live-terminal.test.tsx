import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LiveTerminal } from "./live-terminal";

type MessageHandler = (event: MessageEvent<string>) => void;
type CloseHandler = (event: CloseEvent) => void;
type OpenHandler = (event: Event) => void;

const terminalInstances: MockTerminal[] = [];
const webLinksInstances: MockWebLinksAddon[] = [];
const sockets: MockSocket[] = [];
const resizeObservers: MockResizeObserver[] = [];

let proposed = { cols: 80, rows: 24 };
let autoOpenSockets = true;
const socketBase = `ws://${window.location.host}`;

type MockVisualViewport = EventTarget & {
  height: number;
  width: number;
  offsetTop: number;
  scale: number;
};

function installVisualViewport(overrides: Partial<Pick<MockVisualViewport, "height" | "width" | "offsetTop" | "scale">> = {}) {
  const viewport = Object.assign(new EventTarget(), {
    height: 800,
    width: 390,
    offsetTop: 0,
    scale: 1,
    ...overrides,
  }) as MockVisualViewport;
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  return viewport;
}

function promptBuffer(text = "", cursor = text.length) {
  const prefix = "chai@host repo % ";
  const value = `${prefix}${text}`;
  const padded = value.padEnd(120, " ");
  const line = {
    isWrapped: false,
    length: padded.length,
    getCell: (x: number) => ({
      getWidth: () => 1,
      getChars: () => padded[x] ?? " ",
    }),
    translateToString: (_trimRight?: boolean, startColumn = 0, endColumn = padded.length) =>
      padded.slice(startColumn, endColumn),
  };
  return {
    type: "normal" as const,
    cursorY: 0,
    cursorX: prefix.length + cursor,
    baseY: 0,
    length: 1,
    getLine: (y: number) => (y === 0 ? line : undefined),
  };
}

class MockTerminal {
  writes: Array<string | Uint8Array> = [];
  cleared = 0;
  disposed = false;
  focused = false;
  options: { disableStdin?: boolean; fontSize?: number } = {};
  dataHandler: ((data: string) => void) | null = null;
  oscHandlers: number[] = [];
  textarea = document.createElement("textarea");
  textareaBlur = vi.spyOn(this.textarea, "blur");
  textareaFocus = vi.spyOn(this.textarea, "focus");
  host: HTMLElement | null = null;
  buffer = { active: promptBuffer() };
  parser = {
    registerOscHandler: (identifier: number) => {
      this.oscHandlers.push(identifier);
      return { dispose() {} };
    },
  };

  constructor(options: { disableStdin?: boolean; fontSize?: number }) {
    this.options = options;
    terminalInstances.push(this);
  }

  open(element: HTMLElement) {
    this.host = element;
    element.append(this.textarea);
  }
  focus() {
    this.focused = true;
    this.textarea.focus({ preventScroll: true });
  }
  setPrompt(text: string, cursor = text.length) {
    this.buffer.active = promptBuffer(text, cursor);
  }
  write(data: string | Uint8Array, callback?: () => void) {
    this.writes.push(data);
    callback?.();
  }
  clear() {
    this.cleared += 1;
  }
  dispose() {
    this.disposed = true;
  }
  loadAddon() {}
  onData(callback: (data: string) => void) {
    this.dataHandler = callback;
    return { dispose: () => (this.dataHandler = null) };
  }
  getSelection() {
    return "selected text";
  }
}

class MockFitAddon {
  disposed = false;
  fit = vi.fn();
  proposeDimensions = vi.fn(() => proposed);
  dispose() {
    this.disposed = true;
  }
}

class MockWebLinksAddon {
  handler: (event: MouseEvent, uri: string) => void;
  constructor(handler: (event: MouseEvent, uri: string) => void) {
    this.handler = handler;
    webLinksInstances.push(this);
  }
  dispose() {}
}

class MockSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  url: string;
  readyState = MockSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  private openHandlers: OpenHandler[] = [];
  private messageHandlers: MessageHandler[] = [];
  private closeHandlers: CloseHandler[] = [];

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
    if (autoOpenSockets) queueMicrotask(() => this.open());
  }

  addEventListener(type: "open" | "message" | "close", handler: OpenHandler | MessageHandler | CloseHandler) {
    if (type === "open") this.openHandlers.push(handler as OpenHandler);
    else if (type === "message") this.messageHandlers.push(handler as MessageHandler);
    else this.closeHandlers.push(handler as CloseHandler);
  }
  open() {
    if (this.closed) return;
    this.readyState = MockSocket.OPEN;
    this.openHandlers.forEach((handler) => handler(new Event("open")));
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.closeHandlers.forEach((handler) => handler(new CloseEvent("close", { code, reason })));
  }
  emit(raw: string) {
    this.messageHandlers.forEach((handler) => handler(new MessageEvent("message", { data: raw })));
  }
}

class MockResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire() {
    this.callback([], this);
  }
}

vi.mock("@xterm/xterm", () => ({ Terminal: MockTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: MockFitAddon }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: MockWebLinksAddon }));

beforeEach(() => {
  terminalInstances.length = 0;
  webLinksInstances.length = 0;
  sockets.length = 0;
  resizeObservers.length = 0;
  proposed = { cols: 80, rows: 24 };
  autoOpenSockets = true;
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: undefined,
  });
  vi.stubGlobal("WebSocket", Object.assign(MockSocket, { CONNECTING: MockSocket.CONNECTING, OPEN: MockSocket.OPEN }));
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderLive(readOnly = false) {
  const fallback = vi.fn();
  render(<LiveTerminal paneId="w1:p1" session="work" readOnly={readOnly} onFallback={fallback} />);
  await waitFor(() => expect(sockets).toHaveLength(1));
  return fallback;
}

function terminalContainer() {
  const container = terminalInstances[0]?.host;
  if (!(container instanceof HTMLElement)) throw new Error("terminal container missing");
  Object.defineProperty(container, "clientHeight", { configurable: true, value: 80 });
  return container;
}

function inputDock() {
  const dock = screen.getByLabelText("Terminal input").parentElement;
  if (!(dock instanceof HTMLElement)) throw new Error("terminal input dock missing");
  return dock;
}

function terminalInputElement() {
  const input = screen.getByLabelText("Terminal input");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("terminal input missing");
  return input;
}

async function waitForControl() {
  await waitFor(() => expect(screen.getByText("control", { exact: true })).toBeInTheDocument());
}

async function releaseControl(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("Terminal options"));
  await user.click(screen.getByRole("button", { name: /release/i }));
}

function sentTexts(socket: MockSocket) {
  return socket.sent
    .map((raw) => JSON.parse(raw) as { cmd: string; text?: string })
    .filter((message) => message.cmd === "terminal.input")
    .map((message) => message.text ?? "");
}

function touchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { configurable: true, value: touches });
  return event;
}

describe("LiveTerminal", () => {
  it("starts in control mode and writes decoded full frames to xterm", async () => {
    await renderLive();
    const input = terminalInputElement();

    expect(screen.getByLabelText("Terminal input")).toBeInTheDocument();
    await waitForControl();
    expect(screen.getByText("Tap the input below to type · Swipe terminal to scroll")).toBeInTheDocument();
    expect(input).not.toBeDisabled();
    expect(sockets[0]!.url).toBe(`${socketBase}/ws/terminal/w1%3Ap1?mode=control&cols=80&rows=24&session=work`);
    act(() =>
      sockets[0]!.emit(
        JSON.stringify({
          type: "terminal.frame",
          encoding: "ansi",
          bytes: btoa("hello"),
          full: true,
        }),
      ),
    );

    expect(terminalInstances[0]!.cleared).toBe(1);
    expect([...(terminalInstances[0]!.writes[0] as Uint8Array)]).toEqual([
      ...new TextEncoder().encode("hello"),
    ]);
    expect(terminalInstances[0]!.oscHandlers).toContain(52);
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
  });

  it("keeps read-only terminals in observe mode while applying successive frames", async () => {
    await renderLive(true);

    expect(screen.getByText("Read-only terminal")).toBeInTheDocument();
    expect(sockets[0]!.url).toBe(`${socketBase}/ws/terminal/w1%3Ap1?mode=observe&cols=80&rows=24&session=work`);
    act(() => {
      sockets[0]!.emit(JSON.stringify({ type: "terminal.frame", encoding: "ansi", bytes: btoa("first"), full: true }));
      sockets[0]!.emit(JSON.stringify({ type: "terminal.frame", encoding: "ansi", bytes: btoa("second") }));
    });

    expect(terminalInstances[0]!.cleared).toBe(1);
    expect(terminalInstances[0]!.writes).toHaveLength(2);
    expect([...(terminalInstances[0]!.writes[0] as Uint8Array)]).toEqual([...new TextEncoder().encode("first")]);
    expect([...(terminalInstances[0]!.writes[1] as Uint8Array)]).toEqual([...new TextEncoder().encode("second")]);
    expect(screen.queryByRole("button", { name: "Retry input" })).toBeNull();
  });

  it("syncs the visible input from the parsed xterm prompt after frame writes", async () => {
    await renderLive();
    const input = terminalInputElement();
    terminalInstances[0]!.setPrompt("echo existing", 5);

    act(() =>
      sockets[0]!.emit(
        JSON.stringify({
          type: "terminal.frame",
          encoding: "ansi",
          bytes: btoa("prompt"),
          full: true,
        }),
      ),
    );

    await waitFor(() => expect(input).toHaveValue("echo existing"));
  });

  it("enables native input after the initial control socket opens and releases to observe", async () => {
    const user = userEvent.setup();
    await renderLive();
    const input = terminalInputElement();

    await waitForControl();
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    expect(screen.getByText("Tap the input below to type · Swipe terminal to scroll")).toBeInTheDocument();
    expect(input).not.toBeDisabled();

    await user.type(input, "ls");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(sockets[0]!.url).toContain("mode=control");
    expect(sentTexts(sockets[0]!)).toEqual(["l", "s", "\r"]);

    await releaseControl(user);
    expect(sockets[0]!.sent.at(-1)).toBe('{"cmd":"terminal.release"}');
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    await waitFor(() => expect(sockets.at(-1)!.url).toContain("mode=observe"));
    fireEvent.change(input, { target: { value: "ignored", selectionStart: 7 } });
    expect(sockets.at(-1)!.sent).toEqual([]);
  });

  it("does not auto-focus on control open; Keyboard focuses the visible native input", async () => {
    const user = userEvent.setup();
    autoOpenSockets = false;
    await renderLive();
    const input = terminalInputElement();

    expect(screen.getByRole("button", { name: "Connecting" })).toBeDisabled();
    expect(input).toBeDisabled();
    expect(terminalInstances[0]!.focused).toBe(false);
    expect(terminalInstances[0]!.textareaFocus).not.toHaveBeenCalled();
    act(() => sockets[0]!.open());
    await waitForControl();
    expect(terminalInstances[0]!.focused).toBe(false);
    expect(terminalInstances[0]!.textareaFocus).not.toHaveBeenCalled();
    expect(input).not.toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Focus terminal input" }));

    expect(terminalInstances[0]!.textareaBlur).not.toHaveBeenCalled();
    expect(terminalInstances[0]!.textareaFocus).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
  });

  it("keeps the xterm helper textarea hidden while the native input toggles with control ownership", async () => {
    const user = userEvent.setup();
    await renderLive();
    const helper = terminalInstances[0]!.textarea;
    const input = terminalInputElement();

    expect(input).not.toBe(helper);
    expect(inputDock()).toHaveClass("live-terminal-input");
    expect(helper).toBeDisabled();
    expect(helper).toHaveAttribute("aria-hidden", "true");

    await waitForControl();
    expect(helper).toBeDisabled();
    expect(input).not.toBeDisabled();

    await releaseControl(user);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry input" })).toBeInTheDocument());
    expect(helper).toBeDisabled();
    expect(input).toBeDisabled();
  });

  it("caps the live terminal to the shrunken visual viewport without reacting to pinch zoom", async () => {
    const viewport = installVisualViewport();
    await renderLive();
    const region = screen.getByRole("region", { name: "Live terminal" });
    vi.spyOn(region, "getBoundingClientRect").mockReturnValue({
      bottom: 748,
      height: 700,
      left: 0,
      right: 390,
      top: 48,
      width: 390,
      x: 0,
      y: 48,
      toJSON: () => ({}),
    });

    act(() => {
      viewport.height = 500;
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(region.style.maxHeight).toBe("452px");
    expect(terminalContainer()).toHaveClass("min-h-0");

    act(() => {
      viewport.height = 220;
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(region.style.maxHeight).toBe("172px");

    act(() => {
      viewport.scale = 1.5;
      viewport.height = 360;
      viewport.dispatchEvent(new Event("resize"));
    });

    expect(region.style.maxHeight).toBe("");
  });

  it("sends enter and backspace through the compact accessory row via the native input model", async () => {
    const user = userEvent.setup();
    await renderLive();
    await waitForControl();
    const input = terminalInputElement();

    await user.type(input, "x");
    await user.click(screen.getByRole("button", { name: "Backspace" }));
    await user.click(screen.getByRole("button", { name: "Enter" }));

    expect(sentTexts(sockets[0]!)).toEqual(["x", "\u007f", "\r"]);
  });

  it("keeps touch pointerdown clickable, prevents mouse focus theft, and preserves native input focus", async () => {
    const user = userEvent.setup();
    await renderLive();
    await waitForControl();
    const input = terminalInputElement();
    const enter = screen.getByRole("button", { name: "Enter" });
    input.focus();
    terminalInstances[0]!.focused = false;
    terminalInstances[0]!.textareaFocus.mockClear();

    expect(fireEvent.pointerDown(enter, { cancelable: true, pointerType: "touch" })).toBe(true);
    expect(fireEvent.mouseDown(enter, { cancelable: true })).toBe(false);
    await user.click(enter);

    expect(terminalInstances[0]!.focused).toBe(false);
    expect(terminalInstances[0]!.textareaFocus).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    expect(sentTexts(sockets[0]!)).toEqual(["\r"]);
  });

  it("sends terminal.scroll for control wheel gestures without terminal.input", async () => {
    await renderLive();
    await waitForControl();
    const container = terminalContainer();

    fireEvent.wheel(container, { deltaY: 80, deltaMode: 0, cancelable: true });
    fireEvent.wheel(container, { deltaY: -16, deltaMode: 0, cancelable: true });

    expect(sockets[0]!.sent.map((raw) => JSON.parse(raw) as { cmd: string; direction?: string; lines?: number })).toEqual([
      { cmd: "terminal.scroll", direction: "down", lines: 10, source: "wheel" },
      { cmd: "terminal.scroll", direction: "up", lines: 2, source: "wheel" },
    ]);
  });

  it("accumulates small wheel deltas before sending a scroll command", async () => {
    await renderLive();
    await waitForControl();
    const container = terminalContainer();

    fireEvent.wheel(container, { deltaY: 4, deltaMode: 0, cancelable: true });
    expect(sockets[0]!.sent).toEqual([]);

    fireEvent.wheel(container, { deltaY: 4, deltaMode: 0, cancelable: true });
    expect(sockets[0]!.sent).toEqual(['{"cmd":"terminal.scroll","direction":"down","lines":1,"source":"wheel"}']);
  });

  it("sends terminal.scroll for one-finger control touch swipes and ignores multitouch", async () => {
    await renderLive();
    await waitForControl();
    const container = terminalContainer();

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 120 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 80 }]));
    container.dispatchEvent(touchEvent("touchend", []));
    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 120 }, { clientX: 40, clientY: 120 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 40 }, { clientX: 40, clientY: 40 }]));

    expect(sockets[0]!.sent).toEqual(['{"cmd":"terminal.scroll","direction":"down","lines":5,"source":"wheel"}']);
  });

  it("does not send scroll or input commands from observe and read-only gestures", async () => {
    const user = userEvent.setup();
    await renderLive();
    await waitForControl();
    await releaseControl(user);
    await waitFor(() => expect(sockets.at(-1)!.url).toContain("mode=observe"));
    const observeContainer = terminalContainer();

    fireEvent.wheel(observeContainer, { deltaY: 80, deltaMode: 0, cancelable: true });
    observeContainer.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 120 }]));
    observeContainer.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 40 }]));

    expect(sockets.at(-1)!.sent).toEqual([]);

    cleanup();
    sockets.length = 0;
    terminalInstances.length = 0;
    render(<LiveTerminal paneId="w1:p1" session="work" readOnly onFallback={vi.fn()} />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    const readOnlyContainer = terminalContainer();

    fireEvent.wheel(readOnlyContainer, { deltaY: 80, deltaMode: 0, cancelable: true });
    readOnlyContainer.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 120 }]));
    readOnlyContainer.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 40 }]));
    terminalInstances[0]!.dataHandler?.("ignored");

    expect(sockets[0]!.sent).toEqual([]);
  });

  it("sends terminal.resize in control mode and reconnects read-only observe on resize", async () => {
    await renderLive();
    await waitForControl();

    proposed = { cols: 100, rows: 30 };
    act(() => {
      resizeObservers[0]!.fire();
    });
    await waitFor(() =>
      expect(sockets[0]!.sent).toContain('{"cmd":"terminal.resize","cols":100,"rows":30}'),
    );

    cleanup();
    sockets.length = 0;
    terminalInstances.length = 0;
    resizeObservers.length = 0;
    render(<LiveTerminal paneId="w1:p1" session="work" readOnly onFallback={vi.fn()} />);
    await waitFor(() => expect(sockets).toHaveLength(1));

    proposed = { cols: 120, rows: 40 };
    act(() => {
      resizeObservers[0]!.fire();
    });
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]!.url).toBe(`${socketBase}/ws/terminal/w1%3Ap1?mode=observe&cols=120&rows=40&session=work`);
    expect(sockets[0]!.sent).toEqual([]);
  });

  it("falls back to observe on initial control websocket rejection", async () => {
    const fallback = await renderLive();

    act(() => sockets[0]!.close(1008, "unauthorized"));

    expect(fallback).not.toHaveBeenCalled();
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]!.url).toContain("mode=observe");
    expect(screen.getByText(/control ended/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry input" })).toBeInTheDocument();
  });

  it("falls back if the initial control websocket constructor throws and leaves input disabled", async () => {
    class MaybeThrowSocket extends MockSocket {
      constructor(url: string) {
        if (url.includes("mode=control")) throw new Error("websocket unsupported");
        super(url);
      }
    }
    vi.stubGlobal("WebSocket", Object.assign(MaybeThrowSocket, { CONNECTING: MockSocket.CONNECTING, OPEN: MockSocket.OPEN }));
    const fallback = vi.fn();
    render(<LiveTerminal paneId="w1:p1" session="work" onFallback={fallback} />);

    await waitFor(() => expect(fallback).toHaveBeenCalledOnce());
    expect(screen.getByText("fallback")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry input" })).toBeInTheDocument();
    expect(sockets).toHaveLength(0);
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    terminalInstances[0]!.dataHandler?.("ignored");
  });

  it("retries transient control drops and falls back to observe after exhaustion", async () => {
    await renderLive();
    await waitForControl();
    vi.useFakeTimers();

    for (let i = 1; i <= 4; i += 1) {
      act(() => sockets.at(-1)!.close(1006, ""));
      expect(screen.getByRole("button", { name: "Connecting" })).toBeDisabled();
      act(() => vi.advanceTimersByTime(1200));
      expect(sockets).toHaveLength(i + 1);
      expect(sockets.at(-1)!.url).toContain("mode=control");
    }

    act(() => sockets.at(-1)!.close(1006, ""));

    expect(sockets.at(-1)!.url).toContain("mode=observe");
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    expect(screen.getByText(/control ended/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("keeps input disabled until the control websocket opens", async () => {
    autoOpenSockets = false;
    const user = userEvent.setup();
    await renderLive();
    const input = terminalInputElement();

    expect(sockets).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Connecting" })).toBeDisabled();
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    expect(input).toBeDisabled();
    fireEvent.change(input, { target: { value: "too soon", selectionStart: 8 } });
    expect(sockets[0]!.sent).toEqual([]);

    act(() => sockets[0]!.open());

    await waitForControl();
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    expect(input).not.toBeDisabled();
    await user.type(input, "ready");
    expect(sentTexts(sockets[0]!).join("")).toBe("ready");
  });

  it("reconnects capped observe network drops and falls back after exhaustion", async () => {
    const fallback = await renderLive(true);
    vi.useFakeTimers();

    for (let i = 1; i <= 4; i += 1) {
      act(() => sockets.at(-1)!.close(1006, ""));
      expect(fallback).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1200));
      expect(sockets).toHaveLength(i + 1);
      expect(sockets.at(-1)!.url).toContain("mode=observe");
    }

    act(() => sockets.at(-1)!.close(1006, ""));
    expect(fallback).toHaveBeenCalledOnce();
    expect(screen.getByText("fallback")).toBeInTheDocument();
  });

  it("cancels a pending observe reconnect when remounting into automatic control", async () => {
    await renderLive(true);
    vi.useFakeTimers();

    act(() => sockets[0]!.close(1006, ""));
    cleanup();

    act(() => vi.advanceTimersByTime(1200));
    expect(sockets).toHaveLength(1);
    vi.useRealTimers();

    sockets.length = 0;
    terminalInstances.length = 0;
    render(<LiveTerminal paneId="w1:p1" session="work" readOnly={false} onFallback={vi.fn()} />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.url).toContain("mode=control");
  });

  it("releases an active controller when the device becomes read-only", async () => {
    const { rerender } = render(
      <LiveTerminal paneId="w1:p1" session="work" readOnly={false} onFallback={vi.fn()} />,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));

    await waitForControl();
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);

    rerender(<LiveTerminal paneId="w1:p1" session="work" readOnly onFallback={vi.fn()} />);

    expect(sockets[0]!.sent.at(-1)).toBe('{"cmd":"terminal.release"}');
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    await waitFor(() => expect(sockets.at(-1)!.url).toContain("mode=observe"));
  });

  it("keeps the xterm instance stable when onFallback prop identity changes", async () => {
    const firstFallback = vi.fn();
    const { rerender } = render(
      <LiveTerminal paneId="w1:p1" session="work" readOnly onFallback={firstFallback} />,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));

    const latestFallback = vi.fn();
    rerender(<LiveTerminal paneId="w1:p1" session="work" readOnly onFallback={latestFallback} />);

    expect(terminalInstances).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    act(() => sockets[0]!.close(1008, "unauthorized"));
    expect(firstFallback).not.toHaveBeenCalled();
    expect(latestFallback).toHaveBeenCalledOnce();
  });

  it("opens only explicit http links from the web-links addon", async () => {
    await renderLive();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    webLinksInstances[0]!.handler(new MouseEvent("click"), "javascript:alert(1)");
    webLinksInstances[0]!.handler(new MouseEvent("click"), "https://example.com/path");

    expect(open).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/path",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("cleans up sockets and xterm on unmount without stale frame writes", async () => {
    const { unmount } = render(
      <LiveTerminal paneId="w1:p1" session="work" onFallback={vi.fn()} />,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    const term = terminalInstances[0]!;
    const dockedTextarea = term.textarea;
    const originalParent = dockedTextarea.parentElement;

    unmount();
    act(() =>
      socket.emit(JSON.stringify({ type: "terminal.frame", encoding: "ansi", bytes: btoa("late") })),
    );

    expect(socket.closed).toBe(true);
    expect(term.disposed).toBe(true);
    expect(term.writes).toEqual([]);
    expect(dockedTextarea.parentElement).toBe(originalParent);
    expect(originalParent).not.toBeInTheDocument();
  });

  it("keeps controls disabled for read-only devices", async () => {
    await renderLive(true);

    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText("Read-only terminal")).toBeInTheDocument();
    expect(screen.getByLabelText("Terminal input")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Focus terminal input" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    terminalInstances[0]!.dataHandler?.("x");
    expect(sockets[0]!.sent).toEqual([]);
  });
});
