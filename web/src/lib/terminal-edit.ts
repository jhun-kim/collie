export interface TerminalDraft {
  text: string;
  /** UTF-16 offset. Values inside a grapheme snap back to the previous grapheme boundary. */
  cursor: number;
}

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

interface GraphemeText {
  text: string;
  parts: string[];
  boundaries: number[];
}

function segmentText(text: string): GraphemeText {
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  const parts = segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
  const boundaries = [0];
  let cursor = 0;
  for (const part of parts) {
    cursor += part.length;
    boundaries.push(cursor);
  }
  return { text, parts, boundaries };
}

function snapCursor(segmented: GraphemeText, cursor: number): number {
  const clamped = Math.max(0, Math.min(segmented.text.length, cursor));
  let snapped = 0;
  for (const boundary of segmented.boundaries) {
    if (boundary > clamped) break;
    snapped = boundary;
  }
  return snapped;
}

function indexForBoundary(segmented: GraphemeText, offset: number): number {
  const index = segmented.boundaries.indexOf(offset);
  if (index >= 0) return index;
  return segmented.boundaries.indexOf(snapCursor(segmented, offset));
}

function move(from: number, to: number): string {
  if (from === to) return "";
  const key = from > to ? LEFT : RIGHT;
  return key.repeat(Math.abs(from - to));
}

function terminalInsert(text: string): string {
  return /[\r\n]/.test(text) ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  const end = Math.min(a.length, b.length);
  let i = 0;
  while (i < end && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffix(a: readonly string[], b: readonly string[], prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

export function previousTextOffset(text: string, cursor: number): number {
  const segmented = segmentText(text);
  const current = indexForBoundary(segmented, snapCursor(segmented, cursor));
  return segmented.boundaries[Math.max(0, current - 1)] ?? 0;
}

export function nextTextOffset(text: string, cursor: number): number {
  const segmented = segmentText(text);
  const current = indexForBoundary(segmented, snapCursor(segmented, cursor));
  return segmented.boundaries[Math.min(segmented.parts.length, current + 1)] ?? text.length;
}

export function editTerminalDraft(before: TerminalDraft, next: TerminalDraft): string {
  const beforeText = segmentText(before.text);
  const nextText = segmentText(next.text);
  const beforeCursor = snapCursor(beforeText, before.cursor);
  const nextCursor = snapCursor(nextText, next.cursor);
  const beforeCursorIndex = indexForBoundary(beforeText, beforeCursor);
  const nextCursorIndex = indexForBoundary(nextText, nextCursor);
  if (before.text === next.text) return move(beforeCursorIndex, nextCursorIndex);

  const prefix = commonPrefix(beforeText.parts, nextText.parts);
  const suffix = commonSuffix(beforeText.parts, nextText.parts, prefix);

  const beforeReplaceStart = prefix;
  const beforeReplaceEnd = beforeText.parts.length - suffix;
  const nextReplaceStart = prefix;
  const nextReplaceEnd = nextText.parts.length - suffix;

  const insertedText = next.text.slice(
    nextText.boundaries[nextReplaceStart] ?? 0,
    nextText.boundaries[nextReplaceEnd] ?? next.text.length,
  );

  const deletedCount = beforeReplaceEnd - beforeReplaceStart;
  let output = move(beforeCursorIndex, beforeReplaceEnd);
  output += BACKSPACE.repeat(deletedCount);
  output += terminalInsert(insertedText);
  output += move(nextReplaceEnd, nextCursorIndex);
  return output;
}
