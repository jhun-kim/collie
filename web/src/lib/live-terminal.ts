export type LiveTerminalMode = "observe" | "control";

export type TerminalFrame = {
  readonly type: "terminal.frame";
  readonly encoding: "ansi";
  readonly bytes: string;
  readonly width?: number;
  readonly height?: number;
  readonly full?: boolean;
  readonly seq?: number;
};

export type TerminalClosed = {
  readonly type: "terminal.closed";
};

export type TerminalServerMessage = TerminalFrame | TerminalClosed;

export type TerminalDimensions = {
  readonly cols: number;
  readonly rows: number;
};

const DEFAULT_DIMENSIONS: TerminalDimensions = { cols: 120, rows: 40 };
const MAX_DIMENSION = 65_535;

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_DIMENSION
    ? value
    : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function terminalDimensions(
  dimensions: Partial<TerminalDimensions> | undefined,
): TerminalDimensions {
  const cols = positiveInteger(dimensions?.cols) ?? DEFAULT_DIMENSIONS.cols;
  const rows = positiveInteger(dimensions?.rows) ?? DEFAULT_DIMENSIONS.rows;
  return { cols, rows };
}

export function liveTerminalUrl({
  paneId,
  session,
  mode,
  dimensions,
}: {
  readonly paneId: string;
  readonly session?: string;
  readonly mode: LiveTerminalMode;
  readonly dimensions?: Partial<TerminalDimensions>;
}): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}/ws/terminal/${encodeURIComponent(paneId)}`);
  const sized = terminalDimensions(dimensions);
  url.searchParams.set("mode", mode);
  url.searchParams.set("cols", String(sized.cols));
  url.searchParams.set("rows", String(sized.rows));
  if (session?.trim()) url.searchParams.set("session", session.trim());
  return url.toString();
}

export function parseTerminalServerMessage(raw: string): TerminalServerMessage {
  const parsed = object(JSON.parse(raw));
  if (parsed === null || typeof parsed["type"] !== "string") {
    throw new Error("terminal message requires a type");
  }
  if (parsed["type"] === "terminal.closed") return { type: "terminal.closed" };
  if (parsed["type"] !== "terminal.frame") {
    throw new Error("unknown terminal message type");
  }
  if (parsed["encoding"] !== "ansi" || typeof parsed["bytes"] !== "string") {
    throw new Error("terminal.frame requires ansi bytes");
  }
  const frame: TerminalFrame = {
    type: "terminal.frame",
    encoding: "ansi",
    bytes: parsed["bytes"],
  };
  const width = positiveInteger(parsed["width"]);
  const height = positiveInteger(parsed["height"]);
  const full = typeof parsed["full"] === "boolean" ? parsed["full"] : undefined;
  const seq = positiveInteger(parsed["seq"]);
  return {
    ...frame,
    ...(width === null ? {} : { width }),
    ...(height === null ? {} : { height }),
    ...(full === undefined ? {} : { full }),
    ...(seq === null ? {} : { seq }),
  };
}

export function decodeTerminalFrame(frame: TerminalFrame): Uint8Array {
  const decoded = atob(frame.bytes);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

export function terminalInput(text: string): string {
  return JSON.stringify({ cmd: "terminal.input", text });
}

export function terminalResize(dimensions: TerminalDimensions): string {
  const sized = terminalDimensions(dimensions);
  return JSON.stringify({ cmd: "terminal.resize", cols: sized.cols, rows: sized.rows });
}

export function terminalRelease(): string {
  return JSON.stringify({ cmd: "terminal.release" });
}

export function specialKeyInput(key: string): string {
  switch (key) {
    case "Escape":
      return "\u001b";
    case "Ctrl+C":
      return "\u0003";
    case "Enter":
      return "\r";
    case "Backspace":
      return "\u007f";
    case "Tab":
      return "\t";
    case "Shift+Tab":
      return "\u001b[Z";
    case "ArrowUp":
      return "\u001b[A";
    case "ArrowDown":
      return "\u001b[B";
    case "ArrowRight":
      return "\u001b[C";
    case "ArrowLeft":
      return "\u001b[D";
    default:
      return "";
  }
}
