export type TerminalMode = "observe" | "control";

export type TerminalRequest = {
  readonly paneId: string;
  readonly mode: TerminalMode;
  readonly cols: number;
  readonly rows: number;
};

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const MAX_U16 = 65_535;
const MAX_U32 = 4_294_967_295;
export const MAX_TERMINAL_INPUT_BYTES = 1024 * 1024;
const TERMINAL_ROUTE = /^\/ws\/terminal\/([^/]+)$/;

function integer(value: unknown, maximum: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= maximum
    ? value
    : null;
}

function queryDimension(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) return null;
  return integer(Number(value), MAX_U16);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

export function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) return false;
  const shaped =
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
  return shaped && Buffer.from(value, "base64").toString("base64") === value;
}

export function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function line(value: Record<string, unknown>, release = false) {
  return { ok: true, value: { line: `${JSON.stringify(value)}\n`, release } } as const;
}

export function parseTerminalRequest(request: Request): ParseResult<TerminalRequest> {
  const url = new URL(request.url);
  const match = url.pathname.match(TERMINAL_ROUTE);
  if (match === null) return { ok: false, error: "not a terminal route" };
  const encodedPaneId = match[1];
  if (encodedPaneId === undefined) return { ok: false, error: "pane id required" };
  let paneId: string;
  try {
    paneId = decodeURIComponent(encodedPaneId);
  } catch {
    return { ok: false, error: "invalid pane id" };
  }
  if (paneId.length === 0) return { ok: false, error: "pane id required" };
  for (const parameter of ["mode", "cols", "rows"]) {
    if (url.searchParams.getAll(parameter).length > 1) {
      return { ok: false, error: `duplicate ${parameter}` };
    }
  }
  const mode = url.searchParams.get("mode") ?? "observe";
  if (mode !== "observe" && mode !== "control") {
    return { ok: false, error: "mode must be observe or control" };
  }
  const cols = queryDimension(url.searchParams.get("cols"), DEFAULT_COLS);
  const rows = queryDimension(url.searchParams.get("rows"), DEFAULT_ROWS);
  if (cols === null || rows === null) {
    return { ok: false, error: "cols and rows must be integers from 1 to 65535" };
  }
  return { ok: true, value: { paneId, mode, cols, rows } };
}

export function terminalArgv(request: TerminalRequest): readonly string[] {
  const prefix = ["herdr", "terminal", "session", request.mode, request.paneId];
  return request.mode === "control"
    ? [
        ...prefix,
        "--takeover",
        "--cols",
        String(request.cols),
        "--rows",
        String(request.rows),
      ]
    : [...prefix, "--cols", String(request.cols), "--rows", String(request.rows)];
}

export function parseTerminalClientMessage(
  raw: string,
  mode: TerminalMode,
): ParseResult<{ readonly line: string; readonly release: boolean }> {
  if (mode === "observe") return { ok: false, error: "observe mode is read-only" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const message = record(decoded);
  if (message === null || typeof message["cmd"] !== "string") {
    return { ok: false, error: "command required" };
  }
  switch (message["cmd"]) {
    case "terminal.input": {
      const text = message["text"];
      const base64 = message["base64"];
      if ((typeof text === "string") === (typeof base64 === "string")) {
        return { ok: false, error: "terminal.input requires exactly one of text or base64" };
      }
      if (typeof text === "string") {
        if (text.length === 0) return { ok: false, error: "terminal.input text is empty" };
        if (new TextEncoder().encode(text).byteLength > MAX_TERMINAL_INPUT_BYTES) {
          return { ok: false, error: "terminal.input exceeds one MiB" };
        }
        return line({ type: "terminal.input", text });
      }
      if (typeof base64 !== "string" || !isCanonicalBase64(base64)) {
        return { ok: false, error: "terminal.input base64 is invalid" };
      }
      if (decodedBase64Bytes(base64) > MAX_TERMINAL_INPUT_BYTES) {
        return { ok: false, error: "terminal.input exceeds one MiB" };
      }
      return line({ type: "terminal.input", bytes: base64 });
    }
    case "terminal.resize": {
      const cols = integer(message["cols"], MAX_U16);
      const rows = integer(message["rows"], MAX_U16);
      if (cols === null || rows === null) {
        return { ok: false, error: "terminal.resize dimensions are invalid" };
      }
      const output: Record<string, unknown> = { type: "terminal.resize", cols, rows };
      if (message["cellWidthPx"] !== undefined) {
        const width = integer(message["cellWidthPx"], MAX_U32);
        if (width === null) return { ok: false, error: "cellWidthPx is invalid" };
        output["cell_width_px"] = width;
      }
      if (message["cellHeightPx"] !== undefined) {
        const height = integer(message["cellHeightPx"], MAX_U32);
        if (height === null) return { ok: false, error: "cellHeightPx is invalid" };
        output["cell_height_px"] = height;
      }
      return line(output);
    }
    case "terminal.scroll": {
      const direction = message["direction"];
      const lines = integer(message["lines"], MAX_U16);
      const source = message["source"];
      if (direction !== "up" && direction !== "down") {
        return { ok: false, error: "terminal.scroll direction is invalid" };
      }
      if (lines === null) return { ok: false, error: "terminal.scroll lines are invalid" };
      if (source !== undefined && source !== "wheel" && source !== "page_key") {
        return { ok: false, error: "terminal.scroll source is invalid" };
      }
      return line({
        type: "terminal.scroll",
        direction,
        lines,
        ...(source === undefined ? {} : { source }),
      });
    }
    case "terminal.release":
      return line({ type: "terminal.release" }, true);
    default:
      return { ok: false, error: "unknown terminal command" };
  }
}
