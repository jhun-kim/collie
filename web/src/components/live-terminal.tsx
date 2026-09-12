import "@xterm/xterm/css/xterm.css";
import "./live-terminal.css";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, Keyboard, Loader2, Minus, Plus, ShieldAlert, Unplug } from "lucide-react";
import type { IDisposable, ITerminalAddon, ITerminalOptions, Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";

import { Button } from "@/components/ui/button";
import { SideSheet } from "@/components/ui/sheet";
import { keyboardLikelyOpen } from "@/hooks/use-keyboard";
import {
  decodeTerminalFrame,
  liveTerminalUrl,
  parseTerminalServerMessage,
  terminalDimensions,
  terminalInput,
  terminalRelease,
  terminalResize,
  terminalScroll,
  type LiveTerminalMode,
  type TerminalDimensions,
} from "@/lib/live-terminal";
import { TerminalInput, type TerminalInputHandle } from "@/components/terminal-input";
import { readTerminalPrompt } from "@/lib/terminal-prompt";
import type { TerminalDraft } from "@/lib/terminal-edit";
import { cn } from "@/lib/utils";

type LiveTerminalProps = {
  paneId: string;
  session?: string;
  readOnly?: boolean;
  onFallback: () => void;
};

type ConnectionState = "loading" | "observing" | "controlling" | "connecting-control" | "reconnecting" | "closed" | "fallback";

const MIN_FONT_SCALE = 50;
const MAX_FONT_SCALE = 200;
const BASE_FONT_SIZE = 12;
const OBSERVE_RECONNECT_LIMIT = 4;
const RESIZE_DEBOUNCE_MS = 160;
const CONNECTION_TIMEOUT_MS = 8_000;
const SPECIAL_KEYS = [
  { label: "Esc", key: "Escape" },
  { label: "Ctrl C", key: "Ctrl+C" },
  { label: "Enter", key: "Enter" },
  { label: "⌫", key: "Backspace", aria: "Backspace" },
  { label: "Tab", key: "Tab" },
  { label: "⇧ Tab", key: "Shift+Tab" },
  { label: <ArrowUp className="mx-auto size-4" />, key: "ArrowUp", aria: "Arrow up" },
  { label: <ArrowLeft className="mx-auto size-4" />, key: "ArrowLeft", aria: "Arrow left" },
  { label: <ArrowDown className="mx-auto size-4" />, key: "ArrowDown", aria: "Arrow down" },
  { label: <ArrowRight className="mx-auto size-4" />, key: "ArrowRight", aria: "Arrow right" },
];

function fallbackReason(event: CloseEvent): boolean {
  return event.code === 1002 ||
    event.code === 1003 ||
    event.code === 1008 ||
    event.code === 1011 ||
    event.code === 1013 ||
    /not supported|unauthori[sz]ed|forbidden|controller|collision/i.test(event.reason);
}

function openHttpLink(_: MouseEvent, uri: string): void {
  if (!/^https?:\/\//i.test(uri)) return;
  window.open(uri, "_blank", "noopener,noreferrer");
}

export function LiveTerminal({
  paneId,
  session,
  readOnly = false,
  onFallback,
}: LiveTerminalProps) {
  const [copyText, setCopyText] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const sectionRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<TerminalInputHandle>(null);
  const [remoteFrame, setRemoteFrame] = useState<{ draft: TerminalDraft | null; revision: number }>({ draft: null, revision: 0 });
  const socketRef = useRef<WebSocket | null>(null);
  const modeRef = useRef<LiveTerminalMode>("observe");
  const dimensionsRef = useRef<TerminalDimensions>({ cols: 120, rows: 40 });
  const reconnectsRef = useRef(0);
  const resizeTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const connectionTimerRef = useRef<number | null>(null);
  const staleRef = useRef(0);
  const fontReadyRef = useRef(false);
  const fallbackRef = useRef(onFallback);
  const [terminal, setTerminal] = useState<XtermTerminal | null>(null);
  const [fitAddon, setFitAddon] = useState<XtermFitAddon | null>(null);
  const [state, setState] = useState<ConnectionState>("loading");
  const [controlDropped, setControlDropped] = useState(false);
  const [fontScale, setFontScale] = useState(100);
  const [viewportMaxHeight, setViewportMaxHeight] = useState<number | null>(null);

  useEffect(() => {
    fallbackRef.current = onFallback;
  }, [onFallback]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current === null) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const clearConnectionTimer = useCallback(() => {
    if (connectionTimerRef.current === null) return;
    window.clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = null;
  }, []);

  const closeSocket = useCallback((releaseControl: boolean) => {
    clearConnectionTimer();
    const socket = socketRef.current;
    socketRef.current = null;
    if (releaseControl && socket?.readyState === WebSocket.OPEN) {
      socket.send(terminalRelease());
    }
    socket?.close();
  }, [clearConnectionTimer]);

  const connect = useCallback(
    (nextMode: LiveTerminalMode) => {
      const term = terminal;
      if (term === null) return;
      modeRef.current = nextMode;
      const generation = staleRef.current + 1;
      staleRef.current = generation;
      clearReconnectTimer();
      closeSocket(false);
      setState(nextMode === "control" ? "connecting-control" : reconnectsRef.current > 0 ? "reconnecting" : "loading");
      let socket: WebSocket;
      try {
        socket = new WebSocket(
          liveTerminalUrl({ paneId, session, mode: nextMode, dimensions: dimensionsRef.current }),
        );
      } catch {
        socketRef.current = null;
        modeRef.current = "observe";
        term.options.disableStdin = true;
        reconnectsRef.current = 0;
        setState("fallback");
        fallbackRef.current();
        return;
      }
      socketRef.current = socket;
      // Mobile transports may never deliver open/close. Bound the wait through the first frame,
      // invalidate the old socket first, and recover without depending on its close event.
      connectionTimerRef.current = window.setTimeout(() => {
        if (staleRef.current !== generation) return;
        staleRef.current += 1;
        closeSocket(false);
        term.options.disableStdin = true;
        if (nextMode === "control") {
          setControlDropped(true);
          reconnectsRef.current = 0;
          connect("observe");
        } else {
          setState("fallback");
          fallbackRef.current();
        }
      }, CONNECTION_TIMEOUT_MS);

      socket.addEventListener("open", () => {
        if (staleRef.current !== generation) return;
        if (nextMode === "control") {
          term.options.disableStdin = true;
          setControlDropped(false);
          setState("controlling");
          return;
        }
        setState("observing");
      });

      socket.addEventListener("message", (event) => {
        if (staleRef.current !== generation || typeof event.data !== "string") return;
        try {
          const message = parseTerminalServerMessage(event.data);
          if (message.type === "terminal.closed") {
            socket.close(1000, "terminal closed");
            return;
          }
          clearConnectionTimer();
          reconnectsRef.current = 0;
          if (message.full) term.clear();
          term.write(decodeTerminalFrame(message), () => {
            if (staleRef.current !== generation) return;
            const draft = readTerminalPrompt(term.buffer.active);
            setRemoteFrame((previous) => ({ draft, revision: previous.revision + 1 }));
          });
        } catch {
          socket.close(1002, "invalid terminal frame");
        }
      });

      socket.addEventListener("close", (event) => {
        if (staleRef.current !== generation) return;
        clearConnectionTimer();
        socketRef.current = null;
        if (nextMode === "control") {
          term.options.disableStdin = true;
          setControlDropped(true);
          // Retry transient transport loss, but never fight another controller or a policy denial.
          if ((event.code === 1006 || event.code === 1001) && reconnectsRef.current < OBSERVE_RECONNECT_LIMIT) {
            reconnectsRef.current += 1;
            setState("connecting-control");
            reconnectTimerRef.current = window.setTimeout(() => {
              reconnectTimerRef.current = null;
              connect("control");
            }, Math.min(250 * reconnectsRef.current, 1200));
            return;
          }
          reconnectsRef.current = 0;
          connect("observe");
          return;
        }
        if (fallbackReason(event)) {
          setState("fallback");
          fallbackRef.current();
          return;
        }
        if (reconnectsRef.current >= OBSERVE_RECONNECT_LIMIT) {
          setState("fallback");
          fallbackRef.current();
          return;
        }
        reconnectsRef.current += 1;
        setState("reconnecting");
        reconnectTimerRef.current = window.setTimeout(
          () => {
            reconnectTimerRef.current = null;
            connect("observe");
          },
          Math.min(250 * reconnectsRef.current, 1200),
        );
      });
    },
    [clearConnectionTimer, clearReconnectTimer, closeSocket, paneId, session, terminal],
  );

  const measure = useCallback((): TerminalDimensions => {
    const proposed = fitAddon?.proposeDimensions();
    const next = terminalDimensions(proposed);
    dimensionsRef.current = next;
    return next;
  }, [fitAddon]);

  const resize = useCallback(() => {
    fitAddon?.fit();
    const next = measure();
    const socket = socketRef.current;
    if (modeRef.current === "control") {
      if (socket?.readyState === WebSocket.OPEN) socket.send(terminalResize(next));
      return;
    }
    reconnectsRef.current = 0;
    connect("observe");
  }, [connect, fitAddon, measure]);

  useEffect(() => {
    let disposed = false;
    let localTerminal: XtermTerminal | null = null;
    let localFit: XtermFitAddon | null = null;
    const disposables: Array<ITerminalAddon | IDisposable> = [];

    async function start() {
      try {
        const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
        ]);
        if (disposed || containerRef.current === null) return;
        const options: ITerminalOptions = {
          allowProposedApi: true,
          convertEol: true,
          cursorBlink: true,
          disableStdin: true,
          fontFamily: getComputedStyle(containerRef.current).getPropertyValue("--font-mono").trim() || "monospace",
          fontSize: BASE_FONT_SIZE,
          scrollback: 8_000,
          theme: { background: "#0a0a0a", foreground: "#f4f4f5" },
        };
        localTerminal = new Terminal(options);
        localFit = new FitAddon();
        localTerminal.loadAddon(localFit);
        localTerminal.loadAddon(new WebLinksAddon(openHttpLink));
        disposables.push(localTerminal.parser.registerOscHandler(52, () => true));
        localTerminal.open(containerRef.current);
        // The xterm helper is an IME capture buffer, not an editable prompt model.
        // Keep it private and disabled; the controlled native editor owns all user input.
        if (localTerminal.textarea) {
          localTerminal.textarea.disabled = true;
          localTerminal.textarea.setAttribute("aria-hidden", "true");
        }
        localFit.fit();
        dimensionsRef.current = terminalDimensions(localFit.proposeDimensions());
        setFitAddon(localFit);
        setTerminal(localTerminal);
      } catch {
        setState("fallback");
        fallbackRef.current();
      }
    }

    void start();
    return () => {
      disposed = true;
      staleRef.current += 1;
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
      clearReconnectTimer();
      closeSocket(modeRef.current === "control");
      disposables.forEach((disposable) => disposable.dispose());
      localFit?.dispose();
      localTerminal?.dispose();
    };
  }, [clearReconnectTimer, closeSocket]);

  useEffect(() => {
    if (terminal === null) return;
    reconnectsRef.current = 0;
    setControlDropped(false);
    if (readOnly && modeRef.current === "control") closeSocket(true);
    connect(readOnly ? "observe" : "control");
  }, [closeSocket, connect, terminal, readOnly]);

  // Herdr sends screen snapshots, not a PTY byte stream with local scrollback. Route gestures
  // to its scroll command; xterm's wheel fallback would otherwise send arrow keys to the prompt.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || !terminal) return;
    let touch: { x: number; y: number; lastY: number; moved: boolean } | null = null;
    let remainder = 0;
    const cellHeight = () => Math.max(8, element.clientHeight / (terminal.rows || 40));
    const scroll = (pixels: number) => {
      const socket = socketRef.current;
      if (modeRef.current !== "control" || socket?.readyState !== WebSocket.OPEN) return;
      remainder += pixels / cellHeight();
      const lines = Math.trunc(remainder);
      if (!lines) return;
      remainder -= lines;
      socket.send(terminalScroll(lines));
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      scroll(event.deltaY * (event.deltaMode === 1 ? cellHeight() : event.deltaMode === 2 ? element.clientHeight : 1));
    };
    const start = (event: TouchEvent) => {
      remainder = 0;
      const point = event.touches[0];
      touch = event.touches.length === 1 && point
        ? { x: point.clientX, y: point.clientY, lastY: point.clientY, moved: false }
        : null;
    };
    const move = (event: TouchEvent) => {
      const point = event.touches[0];
      if (!touch || event.touches.length !== 1 || !point) { touch = null; return; }
      const dy = point.clientY - touch.y;
      if (!touch.moved && (Math.abs(dy) < 8 || Math.abs(dy) < Math.abs(point.clientX - touch.x))) return;
      touch.moved = true;
      event.preventDefault();
      event.stopPropagation();
      scroll(touch.lastY - point.clientY);
      touch.lastY = point.clientY;
    };
    const end = (event: TouchEvent) => {
      if (touch?.moved) {
        event.preventDefault();
        event.stopPropagation();
      } else if (touch && modeRef.current === "control" && socketRef.current?.readyState === WebSocket.OPEN) {
        inputRef.current?.focus();
      }
      touch = null;
    };
    const cancel = () => { touch = null; remainder = 0; };
    element.addEventListener("wheel", wheel, { capture: true, passive: false });
    element.addEventListener("touchstart", start, { capture: true, passive: true });
    element.addEventListener("touchmove", move, { capture: true, passive: false });
    element.addEventListener("touchend", end, { capture: true, passive: false });
    element.addEventListener("touchcancel", cancel, true);
    return () => {
      element.removeEventListener("wheel", wheel, true);
      element.removeEventListener("touchstart", start, true);
      element.removeEventListener("touchmove", move, true);
      element.removeEventListener("touchend", end, true);
      element.removeEventListener("touchcancel", cancel, true);
    };
  }, [terminal]);

  useEffect(() => {
    if (fitAddon === null || containerRef.current === null) return;
    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(resize, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [fitAddon, resize]);

  useEffect(() => {
    if (terminal === null) return;
    terminal.options.fontSize = Math.round((BASE_FONT_SIZE * fontScale) / 100);
    if (!fontReadyRef.current) {
      fontReadyRef.current = true;
      fitAddon?.fit();
      dimensionsRef.current = terminalDimensions(fitAddon?.proposeDimensions());
      return;
    }
    if (socketRef.current !== null) {
      resize();
      return;
    }
    fitAddon?.fit();
    dimensionsRef.current = terminalDimensions(fitAddon?.proposeDimensions());
  }, [fontScale, resize, terminal]);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;

    let baselineHeight = visualViewport.height;
    let baselineWidth = visualViewport.width;

    const updateViewportHeight = () => {
      if (visualViewport.scale !== 1) {
        setViewportMaxHeight(null);
        return;
      }
      if (visualViewport.width !== baselineWidth) {
        baselineWidth = visualViewport.width;
        baselineHeight = visualViewport.height;
        setViewportMaxHeight(null);
        return;
      }
      baselineHeight = Math.max(baselineHeight, visualViewport.height);
      if (!keyboardLikelyOpen(baselineHeight, visualViewport.height)) {
        setViewportMaxHeight(null);
        return;
      }
      const sectionTop = sectionRef.current?.getBoundingClientRect().top ?? 0;
      const visibleBottom = visualViewport.offsetTop + visualViewport.height;
      setViewportMaxHeight(Math.max(0, Math.floor(visibleBottom - sectionTop)));
    };

    updateViewportHeight();
    visualViewport.addEventListener("resize", updateViewportHeight);
    visualViewport.addEventListener("scroll", updateViewportHeight);
    return () => {
      visualViewport.removeEventListener("resize", updateViewportHeight);
      visualViewport.removeEventListener("scroll", updateViewportHeight);
    };
  }, []);

  function takeControl() {
    if (readOnly || modeRef.current === "control") return;
    clearReconnectTimer();
    reconnectsRef.current = 0;
    setControlDropped(false);
    connect("control");
  }

  function releaseControl() {
    if (modeRef.current !== "control") return;
    clearReconnectTimer();
    if (terminal !== null) terminal.options.disableStdin = true;
    closeSocket(true);
    reconnectsRef.current = 0;
    setControlDropped(false);
    connect("observe");
  }

  function sendText(text: string) {
    const socket = socketRef.current;
    if (readOnly || modeRef.current !== "control" || socket?.readyState !== WebSocket.OPEN || text.length === 0) return;
    socket.send(terminalInput(text));
  }

  function openCopyText() {
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    const start = buffer.viewportY ?? buffer.baseY;
    const end = Math.min(buffer.length, start + (terminal.rows || buffer.length));
    let text = "";
    for (let row = start; row < end; row += 1) {
      const line = buffer.getLine(row);
      if (!line) continue;
      if (row > start && !line.isWrapped) text += "\n";
      text += line.translateToString(true);
    }
    setCopyText(text.trimEnd());
    setCopyStatus("");
  }

  async function copySelection(text: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Select the text and use your device’s Copy menu.");
    }
  }

  const controlling = modeRef.current === "control" && state === "controlling";
  const takingControl = modeRef.current === "control" && state === "connecting-control";
  function openKeyboard() {
    if (controlling && !readOnly) inputRef.current?.focus(true);
  }

  const inputHint = readOnly ? "Read-only terminal" : controlling ? "Tap the input below to type · Swipe terminal to scroll" : takingControl ? "Connecting input…" : "Live view · Input unavailable";
  const viewportStyle: CSSProperties | undefined = viewportMaxHeight === null ? undefined : { maxHeight: `${viewportMaxHeight}px` };

  return (
    <section
      ref={sectionRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
      style={viewportStyle}
      aria-label="Live terminal"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Keyboard className="size-4" />
            <span>Live terminal</span>
            {state === "loading" || state === "reconnecting" || state === "connecting-control" ? <Loader2 className="size-3 animate-spin" /> : null}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {state === "controlling" ? "control" : state === "connecting-control" ? "connecting" : state === "fallback" ? "fallback" : "observe"}
            {controlDropped ? " · control ended" : ""}
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={!terminal} onClick={openCopyText}>
          <Copy className="size-4" />
          Copy text
        </Button>
        {readOnly ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldAlert className="size-3" />
            Read-only
          </span>
        ) : !controlling ? (
          <Button type="button" size="sm" disabled={takingControl || state === "loading"} onClick={takeControl}>
            {takingControl ? "Connecting" : "Retry input"}
          </Button>
        ) : null}
      </div>

      <div
        ref={containerRef}
        style={{ touchAction: "pan-x pinch-zoom" }}
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-hidden bg-black p-2 text-white",
          state === "fallback" && "opacity-60",
        )}
      />

      <div className="max-h-full shrink-0 space-y-2 overflow-y-auto border-t border-border bg-muted/30 px-3 py-2">
        <div className="text-xs text-muted-foreground">{inputHint}</div>
        <div className="live-terminal-input rounded-lg border border-border bg-background">
          <TerminalInput ref={inputRef} enabled={controlling && !readOnly} remoteFrame={remoteFrame} onSend={sendText} />
        </div>
        <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-1">
          <Button
            type="button"
            size="sm"
            disabled={terminal === null || !controlling}
            onClick={openKeyboard}
            className="h-9 shrink-0"
            aria-label="Focus terminal input"
          >
            <Keyboard className="size-4" />
            Keyboard
          </Button>
          {SPECIAL_KEYS.map((item) => (
            <Button
              key={item.key}
              type="button"
              variant="outline"
              size="sm"
              disabled={!controlling}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => inputRef.current?.sendKey(item.key)}
              aria-label={item.aria}
              className="h-9 shrink-0 px-3 text-xs font-medium"
            >
              {item.label}
            </Button>
          ))}
        </div>

        <details className="rounded-md border border-border bg-background/70 px-2 py-1.5">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Terminal options
          </summary>
          {controlling && !readOnly ? (
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={releaseControl}>
              <Unplug className="size-4" />
              Release
            </Button>
          ) : null}
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => setFontScale((value) => Math.max(MIN_FONT_SCALE, value - 10))}
              aria-label="Decrease terminal font"
            >
              <Minus className="size-4" />
            </Button>
            <input
              type="range"
              min={MIN_FONT_SCALE}
              max={MAX_FONT_SCALE}
              step={10}
              value={fontScale}
              onChange={(event) => setFontScale(Number(event.currentTarget.value))}
              aria-label="Terminal font scale"
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => setFontScale((value) => Math.min(MAX_FONT_SCALE, value + 10))}
              aria-label="Increase terminal font"
            >
              <Plus className="size-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => {
                const selected = terminal?.getSelection() ?? "";
                if (selected) {
                  setCopyText(selected);
                  setCopyStatus("");
                  void copySelection(selected);
                } else openCopyText();
              }}
              aria-label="Copy selection"
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </details>
      </div>
      <SideSheet
        open={copyText !== null}
        onClose={() => setCopyText(null)}
        title="Copy terminal text"
        className="w-full max-w-2xl"
        headerAction={
          <Button type="button" size="sm" disabled={!copyText} onClick={() => void copySelection(copyText ?? "")}>
            Copy all
          </Button>
        }
        footer={<p role="status" className="text-xs text-muted-foreground">{copyStatus || "Long-press or drag to select text. This snapshot stays still while the terminal updates."}</p>}
      >
        <pre className="select-text whitespace-pre-wrap break-words p-4 font-mono text-sm [-webkit-touch-callout:default]">
          {copyText || "No text on this screen."}
        </pre>
      </SideSheet>
    </section>
  );
}
