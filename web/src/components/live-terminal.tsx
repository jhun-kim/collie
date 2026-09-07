import "@xterm/xterm/css/xterm.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, Keyboard, Loader2, Minus, Plus, ShieldAlert, Unplug } from "lucide-react";
import type { IDisposable, ITerminalAddon, ITerminalOptions, Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";

import { Button } from "@/components/ui/button";
import {
  decodeTerminalFrame,
  liveTerminalUrl,
  parseTerminalServerMessage,
  specialKeyInput,
  terminalDimensions,
  terminalInput,
  terminalRelease,
  terminalResize,
  type LiveTerminalMode,
  type TerminalDimensions,
} from "@/lib/live-terminal";
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
const SPECIAL_KEYS = [
  { label: "Esc", key: "Escape" },
  { label: "Ctrl C", key: "Ctrl+C" },
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
  const containerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const modeRef = useRef<LiveTerminalMode>("observe");
  const dimensionsRef = useRef<TerminalDimensions>({ cols: 120, rows: 40 });
  const reconnectsRef = useRef(0);
  const resizeTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const staleRef = useRef(0);
  const fontReadyRef = useRef(false);
  const fallbackRef = useRef(onFallback);
  const [terminal, setTerminal] = useState<XtermTerminal | null>(null);
  const [fitAddon, setFitAddon] = useState<XtermFitAddon | null>(null);
  const [state, setState] = useState<ConnectionState>("loading");
  const [controlDropped, setControlDropped] = useState(false);
  const [fontScale, setFontScale] = useState(100);
  const [mobileInput, setMobileInput] = useState("");

  useEffect(() => {
    fallbackRef.current = onFallback;
  }, [onFallback]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current === null) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const closeSocket = useCallback((releaseControl: boolean) => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (releaseControl && socket?.readyState === WebSocket.OPEN) {
      socket.send(terminalRelease());
    }
    socket?.close();
  }, []);

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
      const socket = new WebSocket(
        liveTerminalUrl({ paneId, session, mode: nextMode, dimensions: dimensionsRef.current }),
      );
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (staleRef.current !== generation) return;
        if (nextMode === "control") {
          term.options.disableStdin = false;
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
          reconnectsRef.current = 0;
          if (message.full) term.clear();
          term.write(decodeTerminalFrame(message));
        } catch {
          socket.close(1002, "invalid terminal frame");
        }
      });

      socket.addEventListener("close", (event) => {
        if (staleRef.current !== generation) return;
        socketRef.current = null;
        if (nextMode === "control") {
          term.options.disableStdin = true;
          setControlDropped(true);
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
    [clearReconnectTimer, closeSocket, paneId, session, terminal],
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
          allowProposedApi: false,
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
    connect("observe");
  }, [connect, terminal]);

  useEffect(() => {
    if (terminal === null) return;
    const disposable = terminal.onData((data) => {
      const socket = socketRef.current;
      if (modeRef.current !== "control" || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(terminalInput(data));
    });
    return () => disposable.dispose();
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

  function takeControl() {
    if (readOnly || modeRef.current === "control") return;
    clearReconnectTimer();
    reconnectsRef.current = 0;
    setControlDropped(false);
    terminal?.focus();
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

  useEffect(() => {
    if (!readOnly || modeRef.current !== "control") return;
    releaseControl();
  });

  function sendText(text: string) {
    const socket = socketRef.current;
    if (modeRef.current !== "control" || socket?.readyState !== WebSocket.OPEN || text.length === 0) return;
    socket.send(terminalInput(text));
  }

  async function copySelection() {
    const selected = terminal?.getSelection?.() ?? "";
    if (selected.length > 0) await navigator.clipboard?.writeText(selected);
  }

  const controlling = modeRef.current === "control" && state === "controlling";
  const takingControl = modeRef.current === "control" && state === "connecting-control";

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Live terminal">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
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
        {readOnly ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldAlert className="size-3" />
            Read-only
          </span>
        ) : controlling ? (
          <Button type="button" size="sm" variant="outline" onClick={releaseControl}>
            <Unplug className="size-4" />
            Release
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={takingControl} onClick={takeControl}>
            {takingControl ? "Connecting" : "Take control"}
          </Button>
        )}
      </div>

      <div
        ref={containerRef}
        className={cn(
          "min-h-[260px] flex-1 overflow-hidden bg-black p-2 text-white",
          state === "fallback" && "opacity-60",
        )}
      />

      <div className="space-y-2 border-t border-border bg-muted/30 px-3 py-2">
        <div className="grid grid-cols-8 gap-1.5">
          {SPECIAL_KEYS.map((item) => (
            <Button
              key={item.key}
              type="button"
              variant="outline"
              size="sm"
              disabled={!controlling}
              onClick={() => sendText(specialKeyInput(item.key))}
              aria-label={item.aria}
              className="h-9 px-0 text-xs font-medium"
            >
              {item.label}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-2">
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
            onClick={() => void copySelection()}
            aria-label="Copy selection"
          >
            <Copy className="size-4" />
          </Button>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            sendText(mobileInput);
            setMobileInput("");
          }}
        >
          <textarea
            value={mobileInput}
            onChange={(event) => setMobileInput(event.currentTarget.value)}
            disabled={!controlling}
            rows={1}
            className="min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
            aria-label="Mobile terminal input"
          />
          <Button type="submit" size="sm" disabled={!controlling || mobileInput.length === 0}>
            Send
          </Button>
        </form>
      </div>
    </section>
  );
}
