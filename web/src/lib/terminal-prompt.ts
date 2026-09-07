export type TerminalPrompt = { text: string; cursor: number };

type BufferCell = {
  getWidth(): number;
  getChars(): string;
  isDim?(): boolean | number;
};

type BufferLine = {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): BufferCell | undefined;
  translateToString(
    trimRight?: boolean,
    startColumn?: number,
    endColumn?: number,
  ): string;
};

export type TerminalPromptBuffer = {
  readonly type?: "normal" | "alternate";
  readonly cursorY: number;
  readonly cursorX: number;
  readonly baseY: number;
  readonly length: number;
  getLine(y: number): BufferLine | undefined;
};

type Row = { line: BufferLine; y: number; text: string };
type PromptMatch = { length: number; kind: "agent" | "shell" };

const AGENT_PROMPT = /^\s*(?:❯|›)\s?/;
const SHELL_PROMPT_PATTERNS: RegExp[] = [
  /^(?:[$#%]) /, // plain shell prompt
  /^[\w.-]+@[\w.-]+(?::[^$#%\s]+)?(?:\s+[^$#%\s]+)*\s?[$#%] /, // user@host:path $ or user@host cwd %
  /^[\w.-]+[$#%] /, // zsh-style user% prompt
];

const PLACEHOLDER_DRAFTS = new Set(["Press up to edit queued messages"]);

export function readTerminalPrompt(
  buffer: TerminalPromptBuffer,
): TerminalPrompt | null {
  const cursorRowY = buffer.baseY + buffer.cursorY;
  if (
    !Number.isInteger(cursorRowY) ||
    cursorRowY < 0 ||
    cursorRowY >= buffer.length
  )
    return null;

  const cursorLine = buffer.getLine(cursorRowY);
  if (!cursorLine) return null;

  let startY = cursorRowY;
  while (startY > 0) {
    const line = buffer.getLine(startY);
    if (!line?.isWrapped) break;
    startY -= 1;
  }

  const startLine = buffer.getLine(startY);
  if (!startLine || startLine.isWrapped) return null;

  let endY = cursorRowY;
  while (endY + 1 < buffer.length) {
    const next = buffer.getLine(endY + 1);
    if (!next?.isWrapped) break;
    endY += 1;
  }

  const rows: Row[] = [];
  for (let y = startY; y <= endY; y += 1) {
    const line = buffer.getLine(y);
    if (!line) return null;
    rows.push({
      line,
      y,
      text: rowText(line, {
        cursorX: y === cursorRowY ? buffer.cursorX : undefined,
        preserveTrailing: y < cursorRowY && buffer.getLine(y + 1)?.isWrapped,
      }),
    });
  }

  const logicalLine = rows.map((row) => row.text).join("");
  const prompt = promptPrefix(logicalLine);
  if (!prompt) return null;
  if (buffer.type === "alternate" && prompt.kind !== "agent") return null;

  const cursorInLogicalLine = rows.reduce((offset, row) => {
    if (row.y < cursorRowY) return offset + row.text.length;
    if (row.y > cursorRowY) return offset;
    return offset + cursorUtf16Offset(row.line, buffer.cursorX);
  }, 0);

  if (cursorInLogicalLine < prompt.length) return null;

  const text = logicalLine.slice(prompt.length);
  const cursor = cursorInLogicalLine - prompt.length;
  // Codex renders this empty-input hint with a foreground color, not always ANSI dim.
  // The cursor remains at the start; a typed command with the same words keeps its text.
  const codexPlaceholder = prompt.kind === "agent" && cursor === 0 &&
    text.trim() === "Ask Codex to do anything";
  if (codexPlaceholder || isDimPlaceholder(rows, prompt.length, text, cursor)) {
    return { text: "", cursor: 0 };
  }

  return { text, cursor };
}

function promptPrefix(line: string): PromptMatch | null {
  const agent = AGENT_PROMPT.exec(line);
  if (agent) return { length: agent[0].length, kind: "agent" };

  for (const pattern of SHELL_PROMPT_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return { length: match[0].length, kind: "shell" };
  }
  return null;
}

function rowText(
  line: BufferLine,
  options: { cursorX?: number; preserveTrailing?: boolean },
): string {
  const raw = cellsToString(line, line.length);
  if (options.preserveTrailing) return raw;

  const trimmedLength = raw.replace(/[ \t]+$/u, "").length;
  if (options.cursorX === undefined) return raw.slice(0, trimmedLength);

  const cursorLength = cursorUtf16Offset(line, options.cursorX);
  return raw.slice(0, Math.max(trimmedLength, cursorLength));
}

function cellsToString(line: BufferLine, endColumn: number): string {
  let value = "";
  for (let x = 0; x < endColumn && x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (!cell) continue;
    const width = cell.getWidth();
    if (width <= 0) continue;
    value += cell.getChars() || " ";
  }
  return value;
}

function cursorUtf16Offset(line: BufferLine, cursorX: number): number {
  let offset = 0;
  for (let x = 0; x < cursorX && x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (!cell) continue;
    if (cell.getWidth() > 0) offset += (cell.getChars() || " ").length;
  }
  return offset;
}

function isDimPlaceholder(
  rows: Row[],
  promptLength: number,
  text: string,
  cursor: number,
): boolean {
  if (cursor !== 0 || !PLACEHOLDER_DRAFTS.has(text.trim())) return false;
  return cellsInRange(rows, promptLength, promptLength + text.length).some(
    (cell) => Boolean(cell.isDim?.()),
  );
}

function cellsInRange(rows: Row[], startOffset: number, endOffset: number) {
  const cells: BufferCell[] = [];
  let offset = 0;
  for (const row of rows) {
    for (let x = 0; x < row.line.length; x += 1) {
      const cell = row.line.getCell(x);
      if (!cell || cell.getWidth() <= 0) continue;
      const charsLength = (cell.getChars() || " ").length;
      const cellStart = offset;
      const cellEnd = offset + charsLength;
      if (cellEnd > startOffset && cellStart < endOffset) cells.push(cell);
      offset = cellEnd;
    }
  }
  return cells;
}
