import { describe, expect, test } from "vitest";
import {
  readTerminalPrompt,
  type TerminalPromptBuffer,
} from "./terminal-prompt";

type TestCell = { chars: string; width: number; dim?: boolean };

function cellsFor(
  text: string,
  dimFrom = Number.POSITIVE_INFINITY,
): TestCell[] {
  const cells: TestCell[] = [];
  let offset = 0;
  for (const char of text) {
    const width = /[가-힣❯›]/u.test(char) ? 2 : 1;
    cells.push({ chars: char, width, dim: offset >= dimFrom });
    if (width === 2)
      cells.push({ chars: "", width: 0, dim: offset >= dimFrom });
    offset += char.length;
  }
  return cells;
}

function line(
  text: string,
  options?:
    | boolean
    | {
        isWrapped?: boolean;
        padTo?: number;
        emptyPad?: boolean;
        dimFrom?: number;
      },
) {
  const lineOptions = typeof options === "object" ? options : undefined;
  const isWrapped =
    typeof options === "boolean" ? options : (lineOptions?.isWrapped ?? false);
  const cells = cellsFor(text, lineOptions?.dimFrom);
  const padTo = lineOptions?.padTo;
  while (padTo !== undefined && cells.length < padTo) {
    cells.push({
      chars: lineOptions?.emptyPad ? "" : " ",
      width: 1,
      dim:
        lineOptions?.dimFrom !== undefined &&
        text.length >= lineOptions.dimFrom,
    });
  }
  return {
    isWrapped,
    length: cells.length,
    getCell: (x: number) => {
      const cell = cells[x];
      if (!cell) return undefined;
      return {
        getChars: () => cell.chars,
        getWidth: () => cell.width,
        isDim: () => cell.dim === true,
      };
    },
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = cells.length,
    ) => {
      let value = "";
      for (let x = startColumn; x < endColumn && x < cells.length; x += 1) {
        if (cells[x]?.width !== 0) value += cells[x]?.chars ?? "";
      }
      if (endColumn > cells.length)
        value += " ".repeat(endColumn - cells.length);
      return value;
    },
  };
}

function cellCursor(text: string): number {
  return cellsFor(text).length;
}

function buffer(
  lines: ReturnType<typeof line>[],
  cursorY: number,
  cursorX: number,
  type: "normal" | "alternate" = "normal",
): TerminalPromptBuffer {
  return {
    type,
    cursorY,
    cursorX,
    baseY: 0,
    length: lines.length,
    getLine: (y) => lines[y],
  };
}

describe("readTerminalPrompt", () => {
  test("reads an existing plain shell draft", () => {
    const row = "$ npm test";
    expect(readTerminalPrompt(buffer([line(row)], 0, cellCursor(row)))).toEqual(
      { text: "npm test", cursor: 8 },
    );
  });

  test("reads an empty shell prompt", () => {
    const row = "$ ";
    expect(readTerminalPrompt(buffer([line(row)], 0, cellCursor(row)))).toEqual(
      { text: "", cursor: 0 },
    );
  });

  test("reads an actual zsh user host cwd prompt", () => {
    const row = "chai@chaiui-Macmini repo % npm test";
    expect(readTerminalPrompt(buffer([line(row)], 0, cellCursor(row)))).toEqual(
      { text: "npm test", cursor: 8 },
    );
  });

  test("trims padded space cells after the cursor", () => {
    const row = "$ npm";
    expect(
      readTerminalPrompt(
        buffer([line(row, { padTo: 20 })], 0, cellCursor(row)),
      ),
    ).toEqual({ text: "npm", cursor: 3 });
  });

  test("preserves padded space cells up to the cursor", () => {
    const row = "$ ";
    expect(
      readTerminalPrompt(
        buffer([line(row, { padTo: 8 })], 0, cellCursor("$   ")),
      ),
    ).toEqual({ text: "  ", cursor: 2 });
  });

  test("counts empty width-one cells as spaces for cursor offsets", () => {
    const row = "$ ";
    expect(
      readTerminalPrompt(
        buffer(
          [line(row, { padTo: 8, emptyPad: true })],
          0,
          cellCursor("$   "),
        ),
      ),
    ).toEqual({ text: "  ", cursor: 2 });
  });

  test("treats known dim placeholder at draft start as an empty draft", () => {
    const row = "❯ Press up to edit queued messages";
    expect(
      readTerminalPrompt(
        buffer([line(row, { dimFrom: "❯ ".length })], 0, cellCursor("❯ ")),
      ),
    ).toEqual({ text: "", cursor: 0 });
  });

  test("keeps a matching placeholder string when it is not dim", () => {
    const row = "❯ Press up to edit queued messages";
    expect(readTerminalPrompt(buffer([line(row)], 0, cellCursor(row)))).toEqual(
      { text: "Press up to edit queued messages", cursor: 32 },
    );
  });

  test.each(["normal", "alternate"] as const)("omits the Codex hint in a %s buffer without requiring dim styling", (type) => {
    const row = "› Ask Codex to do anything";
    expect(readTerminalPrompt(buffer([line(row)], 0, cellCursor("› "), type)))
      .toEqual({ text: "", cursor: 0 });
  });

  test("keeps the Codex hint words when entered as actual text", () => {
    const text = "Ask Codex to do anything";
    const row = `› ${text}`;
    expect(readTerminalPrompt(buffer([line(row)], 0, cellCursor(row))))
      .toEqual({ text, cursor: text.length });
  });

  test("does not remove the Codex hint words from a shell command", () => {
    const text = "Ask Codex to do anything";
    expect(readTerminalPrompt(buffer([line(`$ ${text}`)], 0, cellCursor("$ "))))
      .toEqual({ text, cursor: 0 });
  });

  test("reports a cursor in the middle of the draft", () => {
    expect(
      readTerminalPrompt(
        buffer([line("chai% hello")], 0, cellCursor("chai% he")),
      ),
    ).toEqual({
      text: "hello",
      cursor: 2,
    });
  });

  test("maps wide unicode cells to UTF-16 cursor offsets", () => {
    const row = "❯ 한글x";
    expect(
      readTerminalPrompt(buffer([line(row)], 0, cellCursor("❯ 한글"))),
    ).toEqual({
      text: "한글x",
      cursor: 2,
    });
  });

  test("reads a Codex prompt and preserves trailing whitespace at the cursor", () => {
    const row = "› edit  ";
    expect(readTerminalPrompt(buffer([line(row)], 0, cellCursor(row)))).toEqual(
      { text: "edit  ", cursor: 6 },
    );
  });

  test("joins conservative soft-wrapped prompt rows", () => {
    const first = "user@host:~/repo$ long ";
    const second = "command";
    expect(
      readTerminalPrompt(
        buffer([line(first), line(second, true)], 1, cellCursor(second)),
      ),
    ).toEqual({ text: "long command", cursor: 12 });
  });

  test("returns null for unknown output lines", () => {
    expect(
      readTerminalPrompt(
        buffer(
          [line("build # 42 completed")],
          0,
          cellCursor("build # 42 completed"),
        ),
      ),
    ).toBeNull();
  });

  test("reads known agent prompts in alternate-screen buffers", () => {
    expect(
      readTerminalPrompt(
        buffer([line("❯ /rename")], 0, cellCursor("❯ /rename"), "alternate"),
      ),
    ).toEqual({ text: "/rename", cursor: 7 });
  });

  test("returns null for unknown alternate-screen prompts", () => {
    expect(
      readTerminalPrompt(
        buffer([line("$ draft")], 0, cellCursor("$ draft"), "alternate"),
      ),
    ).toBeNull();
  });
});
