import { describe, expect, it } from "vitest";

import { editTerminalDraft, nextTextOffset, previousTextOffset } from "./terminal-edit";
import type { TerminalDraft } from "./terminal-edit";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function graphemes(text: string): string[] {
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
}

function boundaries(text: string): number[] {
  const out = [0];
  let cursor = 0;
  for (const part of graphemes(text)) {
    cursor += part.length;
    out.push(cursor);
  }
  return out;
}

function snap(text: string, cursor: number): number {
  const clamped = Math.max(0, Math.min(text.length, cursor));
  let snapped = 0;
  for (const boundary of boundaries(text)) {
    if (boundary > clamped) break;
    snapped = boundary;
  }
  return snapped;
}

function indexForCursor(text: string, cursor: number): number {
  return boundaries(text).indexOf(snap(text, cursor));
}

function cursorForIndex(text: string, index: number): number {
  return boundaries(text)[index] ?? text.length;
}

function applyEdit(before: TerminalDraft, edit: string): TerminalDraft {
  let parts = graphemes(before.text);
  let cursor = indexForCursor(before.text, before.cursor);
  let i = 0;
  while (i < edit.length) {
    if (edit.startsWith(LEFT, i)) {
      cursor = Math.max(0, cursor - 1);
      i += LEFT.length;
    } else if (edit.startsWith(RIGHT, i)) {
      cursor = Math.min(parts.length, cursor + 1);
      i += RIGHT.length;
    } else if (edit[i] === BACKSPACE) {
      if (cursor > 0) {
        parts.splice(cursor - 1, 1);
        cursor -= 1;
      }
      i += 1;
    } else if (edit.startsWith(PASTE_START, i)) {
      const end = edit.indexOf(PASTE_END, i + PASTE_START.length);
      expect(end).toBeGreaterThanOrEqual(0);
      const inserted = graphemes(edit.slice(i + PASTE_START.length, end));
      parts.splice(cursor, 0, ...inserted);
      cursor += inserted.length;
      i = end + PASTE_END.length;
    } else {
      let j = i;
      while (
        j < edit.length &&
        !edit.startsWith(LEFT, j) &&
        !edit.startsWith(RIGHT, j) &&
        !edit.startsWith(PASTE_START, j) &&
        edit[j] !== BACKSPACE
      ) {
        j += 1;
      }
      const inserted = graphemes(edit.slice(i, j));
      parts.splice(cursor, 0, ...inserted);
      cursor += inserted.length;
      i = j;
    }
  }
  const text = parts.join("");
  return { text, cursor: cursorForIndex(text, cursor) };
}

function expectEdit(before: TerminalDraft, next: TerminalDraft, output: string) {
  const edit = editTerminalDraft(before, next);
  expect(edit).toBe(output);
  expect(applyEdit(before, edit)).toEqual({ text: next.text, cursor: snap(next.text, next.cursor) });
  expect(edit).not.toContain("ctrl+u");
  expect(edit).not.toContain("\r");
}

describe("editTerminalDraft", () => {
  it("appends text at the current cursor", () => {
    expectEdit({ text: "hel", cursor: 3 }, { text: "hello", cursor: 5 }, "lo");
  });

  it("deletes from the end with backspaces", () => {
    expectEdit({ text: "hello", cursor: 5 }, { text: "hel", cursor: 3 }, `${BACKSPACE}${BACKSPACE}`);
  });

  it("inserts in the middle with relative cursor movement", () => {
    expectEdit({ text: "helo", cursor: 4 }, { text: "hello", cursor: 5 }, `${LEFT}l${RIGHT}`);
  });

  it("replaces a selected middle range without clearing the line", () => {
    expectEdit(
      { text: "hello brave world", cursor: 17 },
      { text: "hello new world", cursor: 9 },
      `${LEFT.repeat(6)}${BACKSPACE.repeat(5)}new`,
    );
  });

  it("clears all text with backspaces only", () => {
    expectEdit({ text: "abc", cursor: 3 }, { text: "", cursor: 0 }, BACKSPACE.repeat(3));
  });

  it("keeps Korean edits on grapheme boundaries", () => {
    expectEdit({ text: "가나", cursor: 2 }, { text: "가다나", cursor: 2 }, `${LEFT}다`);
  });

  it("moves over emoji as one grapheme", () => {
    expectEdit({ text: "a👍b", cursor: 4 }, { text: "a👍✨b", cursor: 4 }, `${LEFT}✨`);
  });

  it("snaps cursors inside an emoji to a valid UTF-16 boundary", () => {
    expectEdit({ text: "a👍b", cursor: 2 }, { text: "a👍b", cursor: 4 }, `${RIGHT}${RIGHT}`);
  });

  it("moves the cursor directly when text is unchanged", () => {
    expectEdit({ text: "abcd", cursor: 1 }, { text: "abcd", cursor: 2 }, RIGHT);
  });

  it("keeps a pasted newline literal in the inserted text", () => {
    expectEdit({ text: "ask", cursor: 3 }, { text: "ask\nmore", cursor: 8 }, `${PASTE_START}\nmore${PASTE_END}`);
  });

  it("wraps only the inserted newline portion while movement and deletion stay outside", () => {
    expectEdit(
      { text: "hello world", cursor: 11 },
      { text: "hello a\nb", cursor: 9 },
      `${BACKSPACE.repeat(5)}${PASTE_START}a\nb${PASTE_END}`,
    );
  });

  it("exports previous and next UTF-16 offsets on grapheme boundaries", () => {
    const text = "a👍한b";
    expect(previousTextOffset(text, 3)).toBe(1);
    expect(nextTextOffset(text, 1)).toBe(3);
    expect(previousTextOffset(text, 4)).toBe(3);
    expect(nextTextOffset(text, 4)).toBe(5);
  });
});
