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

function touchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { configurable: true, value: touches });
  return event;
}

describe("LiveTerminal", () => {
  it("starts in observe mode and writes decoded full frames to xterm", async () => {
    await renderLive();

    expect(screen.getByLabelText("Terminal input")).toBeInTheDocument();
    expect(screen.getByText("Take control to type and scroll")).toBeInTheDocument();
    expect(sockets[0]!.url).toBe(`${socketBase}/ws/terminal/w1%3Ap1?mode=observe&cols=80&rows=24&session=work`);
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

  it("does not send input in observe mode, then enables native input and sends only after taking control", async () => {
    const user = userEvent.setup();
    await renderLive();

    terminalInstances[0]!.dataHandler?.("ignored");
    expect(sockets[0]!.sent).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(sockets).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument());
    expect(terminalInstances[0]!.options.disableStdin).toBe(false);
    expect(screen.getByText("Tap the input below to type · Swipe terminal to scroll")).toBeInTheDocument();
    terminalInstances[0]!.dataHandler?.("ls\n");
    expect(sockets[1]!.url).toContain("mode=control");
    expect(sockets[1]!.sent).toEqual(['{"cmd":"terminal.input","text":"ls\\n"}']);

    await user.click(screen.getByRole("button", { name: /release/i }));
    expect(sockets[1]!.sent.at(-1)).toBe('{"cmd":"terminal.release"}');
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    await waitFor(() => expect(sockets.at(-1)!.url).toContain("mode=observe"));
  });

  it("does not auto-focus on control open; Keyboard blur/refocuses the visible native input", async () => {
    const user = userEvent.setup();
    autoOpenSockets = false;
    await renderLive();
    sockets[0]!.open();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    expect(terminalInstances[0]!.focused).toBe(false);
    expect(terminalInstances[0]!.textareaFocus).not.toHaveBeenCalled();
    act(() => sockets[1]!.open());
    await waitFor(() => expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument());
    expect(terminalInstances[0]!.focused).toBe(false);
    expect(terminalInstances[0]!.textareaFocus).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Focus terminal input" }));

    expect(terminalInstances[0]!.textareaBlur).toHaveBeenCalledOnce();
    expect(terminalInstances[0]!.textareaFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(screen.getByLabelText("Terminal input")).toHaveFocus();
  });

  it("docks the same xterm textarea visibly and toggles disabled with control ownership", async () => {
    const user = userEvent.setup();
    await renderLive();
    const textarea = terminalInstances[0]!.textarea;

    expect(screen.getByLabelText("Terminal input")).toBe(textarea);
    expect(inputDock()).toHaveClass("live-terminal-input");
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveAttribute("placeholder", "Take control to type");
    expect(textarea.style.fontSize).toBe("16px");

    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument());
    expect(textarea).not.toBeDisabled();
    expect(textarea).toHaveAttribute("placeholder", "Tap here to type directly");

    await user.click(screen.getByRole("button", { name: /release/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Take control" })).toBeInTheDocument());
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveAttribute("placeholder", "Take control to type");
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

  it("sends enter and backspace through the compact accessory row", async () => {
    const user = userEvent.setup();
    await renderLive();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Enter" }));
    await user.click(screen.getByRole("button", { name: "Backspace" }));

    expect(sockets[1]!.sent.map((raw) => (JSON.parse(raw) as { text: string }).text)).toEqual([
      "\r",
      "\u007f",
    ]);
  });

  it("keeps touch pointerdown clickable, prevents mouse focus theft, and refocuses after click", async () => {
    const user = userEvent.setup();
    await renderLive();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument());
    const enter = screen.getByRole("button", { name: "Enter" });
    terminalInstances[0]!.focused = false;
    terminalInstances[0]!.textareaFocus.mockClear();

    expect(fireEvent.pointerDown(enter, { cancelable: true, pointerType: "touch" })).toBe(true);
    expect(fireEvent.mouseDown(enter, { cancelable: true })).toBe(false);
    await user.click(enter);

    expect(terminalInstances[0]!.focused).toBe(true);
    expect(terminalInstances[0]!.textareaFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(screen.getByLabelText("Terminal input")).toHaveFocus();
  });

  it("sends terminal.scroll for control wheel gestures without terminal.input", async () => {
    const user = userEvent.setup();
    await renderLive();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument());
    const container = terminalContainer();

    fireEvent.wheel(container, { deltaY: 80, deltaMode: 0, cancelable: true });
    fireEvent.wheel(container, { deltaY: -16, deltaMode: 0, cancelable: true });

    expect(sockets[1]!.sent.map((raw) => JSON.parse(raw) as { cmd: string; direction?: string; lines?: number })).toEqual([
      { cmd: "terminal.scroll", direction: "down", lines: 10, source: "wheel" },
      { cmd: "terminal.scroll", direction: "up", lines: 2, source: "wheel" },
    ]);
  });

  it("accumulates small wheel deltas before sending a scroll command", async () => {
    const user = userEvent.setup();
    await renderLive();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument());
    const container = terminalContainer();

    fireEvent.wheel(container, { deltaY: 4, deltaMode: 0, cancelable: true });
    expect(sockets[1]!.sent).toEqual([]);

    fireEvent.wheel(container, { deltaY: 4, deltaMode: 0, cancelable: true });
    expect(sockets[1]!.sent).toEqual(['{"cmd":"terminal.scroll","direction":"down","lines":1,"source":"wheel"}']);
  });

  it("sends terminal.scroll for one-finger control touch swipes and ignores multitouch", async () => {
    const user = userEvent.setup();
    await renderLive();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument());
    const container = terminalContainer();

    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 120 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 80 }]));
    container.dispatchEvent(touchEvent("touchend", []));
    container.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 120 }, { clientX: 40, clientY: 120 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 40 }, { clientX: 40, clientY: 40 }]));

    expect(sockets[1]!.sent).toEqual(['{"cmd":"terminal.scroll","direction":"down","lines":5,"source":"wheel"}']);
  });

  it("does not send scroll or input commands from observe and read-only gestures", async () => {
    await renderLive();
    const observeContainer = terminalContainer();

    fireEvent.wheel(observeContainer, { deltaY: 80, deltaMode: 0, cancelable: true });
    observeContainer.dispatchEvent(touchEvent("touchstart", [{ clientX: 20, clientY: 120 }]));
    observeContainer.dispatchEvent(touchEvent("touchmove", [{ clientX: 20, clientY: 40 }]));

    expect(sockets[0]!.sent).toEqual([]);

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

  it("reconnects observe on resize but sends terminal.resize in control mode", async () => {
    const user = userEvent.setup();
    await renderLive();

    proposed = { cols: 100, rows: 30 };
    act(() => {
      resizeObservers[0]!.fire();
    });
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]!.url).toBe(`${socketBase}/ws/terminal/w1%3Ap1?mode=observe&cols=100&rows=30&session=work`);
    expect(sockets[0]!.sent).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(sockets).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument());
    proposed = { cols: 120, rows: 40 };
    act(() => {
      resizeObservers[0]!.fire();
    });

    await waitFor(() =>
      expect(sockets[2]!.sent).toContain('{"cmd":"terminal.resize","cols":120,"rows":40}'),
    );
  });

  it("falls back on terminal websocket rejection", async () => {
    const fallback = await renderLive();

    act(() => sockets[0]!.close(1008, "unauthorized"));

    expect(fallback).toHaveBeenCalledOnce();
    expect(screen.getByText("fallback")).toBeInTheDocument();
  });

  it("falls back if the control websocket constructor throws and returns to observe-safe input", async () => {
    let throwNextSocket = false;
    class MaybeThrowSocket extends MockSocket {
      constructor(url: string) {
        if (throwNextSocket) throw new Error("websocket unsupported");
        super(url);
      }
    }
    vi.stubGlobal("WebSocket", Object.assign(MaybeThrowSocket, { CONNECTING: MockSocket.CONNECTING, OPEN: MockSocket.OPEN }));
    const fallback = await renderLive();
    const user = userEvent.setup();

    throwNextSocket = true;
    await user.click(screen.getByRole("button", { name: "Take control" }));

    expect(fallback).toHaveBeenCalledOnce();
    expect(screen.getByText("fallback")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take control" })).toBeInTheDocument();
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    terminalInstances[0]!.dataHandler?.("ignored");
    expect(sockets[0]!.sent).toEqual([]);
  });

  it("does not retake control after a dropped control socket", async () => {
    const user = userEvent.setup();
    await renderLive();
    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(sockets).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: /release/i })).toBeInTheDocument());

    act(() => sockets[1]!.close(1011, "terminal failed"));

    await waitFor(() => expect(sockets).toHaveLength(3));
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    expect(sockets[2]!.url).toContain("mode=observe");
    expect(screen.getByText(/control ended/)).toBeInTheDocument();
  });

  it("keeps input disabled until the control websocket opens", async () => {
    autoOpenSockets = false;
    const user = userEvent.setup();
    await renderLive();
    sockets[0]!.open();

    await user.click(screen.getByRole("button", { name: "Take control" }));

    expect(sockets).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Connecting" })).toBeDisabled();
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    expect(screen.getByLabelText("Terminal input")).toBeDisabled();
    terminalInstances[0]!.dataHandler?.("too soon");
    expect(sockets[1]!.sent).toEqual([]);

    act(() => sockets[1]!.open());

    expect(await screen.findByRole("button", { name: /release/i })).toBeInTheDocument();
    expect(terminalInstances[0]!.options.disableStdin).toBe(false);
    expect(screen.getByLabelText("Terminal input")).not.toBeDisabled();
    terminalInstances[0]!.dataHandler?.("ready");
    expect(sockets[1]!.sent).toEqual(['{"cmd":"terminal.input","text":"ready"}']);
  });

  it("reconnects capped observe network drops and falls back after exhaustion", async () => {
    const fallback = await renderLive();
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

  it("cancels a pending observe reconnect when taking control", async () => {
    await renderLive();
    vi.useFakeTimers();

    act(() => sockets[0]!.close(1006, ""));
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain("mode=control");

    act(() => vi.advanceTimersByTime(1200));

    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain("mode=control");
    vi.useRealTimers();
  });

  it("releases an active controller when the device becomes read-only", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <LiveTerminal paneId="w1:p1" session="work" readOnly={false} onFallback={vi.fn()} />,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(terminalInstances[0]!.options.disableStdin).toBe(false);

    rerender(<LiveTerminal paneId="w1:p1" session="work" readOnly onFallback={vi.fn()} />);

    expect(sockets[1]!.sent.at(-1)).toBe('{"cmd":"terminal.release"}');
    expect(terminalInstances[0]!.options.disableStdin).toBe(true);
    await waitFor(() => expect(sockets.at(-1)!.url).toContain("mode=observe"));
  });

  it("keeps the xterm instance stable when onFallback prop identity changes", async () => {
    const firstFallback = vi.fn();
    const { rerender } = render(
      <LiveTerminal paneId="w1:p1" session="work" onFallback={firstFallback} />,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));

    const latestFallback = vi.fn();
    rerender(<LiveTerminal paneId="w1:p1" session="work" onFallback={latestFallback} />);

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
    expect(dockedTextarea.parentElement).not.toBe(originalParent);
    expect(originalParent).not.toContainElement(dockedTextarea);
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
