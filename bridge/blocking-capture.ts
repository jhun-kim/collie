import type { HerdrClient } from "./herdr-client.ts";

// Blocking-message capture (plan todo 8) — the missing half of "needs you": when an agent flips to
// "blocked", read its recent pane text, lift out the question it is actually asking, and carry that
// into the push notification body and the snapshot. ARCHITECTURE.md §4 called this gap out: the
// notification said *where* to look, not *what* was asked.
//
// The extraction is a deliberately simple, bridge-side heuristic — NOT the full web block pipeline
// (ANSI parse + per-agent dialog grammars, web/src/lib/blocks.ts + harness/claude). The plan allows
// the simplification: the question only has to survive a 100-char push body, so borders, menu
// cursors and option lines are stripped and the last question-shaped line wins. A miss is fine —
// every consumer falls back to the existing `<workspace> · <cwd>` body.

/** How many recent lines a capture reads (plan: 30). */
export const CAPTURE_LINES = 30;
/** Hard bound on a stored question (store hygiene; the notification body truncates further). */
export const MAX_QUESTION_CHARS = 200;
/** Notification-body cap (plan: 100 chars) applied at render time. */
export const MAX_QUESTION_BODY_CHARS = 100;

/**
 * Strip terminal chrome from one line (box-drawing and dingbat decorations incl. the `❯` menu
 * cursor), collapse whitespace, and report whether what remains is an option entry ("1. Yes",
 * "2) No") — options are never the question, even when phrased with a trailing "?".
 */
function cleanLine(raw: string): string {
  return raw
    .replace(/[\u2500-\u27BF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isOptionLine(line: string): boolean {
  return /^\d+[.)]\s/.test(line);
}

/**
 * The last question-shaped line in `text`, or null. Two passes so a bare "(y/n)" below the real
 * question never wins: first a bottom-up scan for a line containing "?", then (only if none) a
 * scan for a "(y/n)"-style marker line.
 */
export function extractQuestion(text: string): string | null {
  const cleaned = text.split("\n").map(cleanLine).filter((l) => l.length > 0 && !isOptionLine(l));
  const fromBottom = [...cleaned].reverse();
  for (const line of fromBottom) {
    if (line.includes("?")) return line.slice(0, MAX_QUESTION_CHARS);
  }
  for (const line of fromBottom) {
    if (/\((?:y\/n|Y\/n|yes\/no)\)/i.test(line)) return line.slice(0, MAX_QUESTION_CHARS);
  }
  return null;
}

/** A captured question: what the agent asked, and when the blocked transition happened. */
export interface BlockingMessage {
  readonly text: string;
  readonly capturedAt: number;
}

export interface BlockingCaptureToken {
  readonly paneId: string;
  readonly generation: number;
}

/** Per-session store of the most recent blocking question per pane (plan: `blockingMessages`). */
export class BlockingMessageStore {
  private readonly messages = new Map<string, BlockingMessage>();
  private readonly generations = new Map<string, number>();
  private readonly active = new Set<string>();

  beginCapture(paneId: string): BlockingCaptureToken {
    const generation = (this.generations.get(paneId) ?? 0) + 1;
    this.generations.set(paneId, generation);
    this.active.add(paneId);
    this.messages.delete(paneId);
    return { paneId, generation };
  }

  capture(paneId: string, text: string, now: number = Date.now()): void {
    this.messages.set(paneId, { text, capturedAt: now });
  }

  captureCurrent(token: BlockingCaptureToken, text: string, now: number = Date.now()): boolean {
    if (!this.isCurrent(token)) return false;
    this.capture(token.paneId, text, now);
    return true;
  }

  get(paneId: string): BlockingMessage | undefined {
    return this.messages.get(paneId);
  }

  isCurrent(token: BlockingCaptureToken): boolean {
    return this.active.has(token.paneId) && this.generations.get(token.paneId) === token.generation;
  }

  remove(paneId: string): void {
    this.messages.delete(paneId);
    this.active.delete(paneId);
    this.generations.set(paneId, (this.generations.get(paneId) ?? 0) + 1);
  }

  clearAll(): void {
    for (const paneId of new Set([...this.messages.keys(), ...this.active])) this.remove(paneId);
  }
}

/**
 * Read a pane's recent text and store its question. Never throws: a failed or empty read (socket
 * blip, alt-screen quirk, no question-shaped line) simply stores nothing, and every consumer falls
 * back to the pre-existing body. Returns whether a question was captured.
 */
export async function captureBlockingMessage(
  herdr: Pick<HerdrClient, "readPane">,
  paneId: string,
  store: BlockingMessageStore,
  now: () => number = Date.now,
  token: BlockingCaptureToken = store.beginCapture(paneId),
): Promise<boolean> {
  let text: string;
  try {
    const read = await herdr.readPane(paneId, "recent", CAPTURE_LINES, "text");
    text = read.text;
  } catch {
    return false;
  }
  const question = extractQuestion(text);
  if (question === null) return false;
  return store.captureCurrent(token, question, now());
}

/** The notification body for a captured question, truncated to the push-body cap — or null. */
export function questionBodyFor(
  store: BlockingMessageStore,
  paneId: string,
): string | null {
  const message = store.get(paneId);
  if (message === undefined) return null;
  const text = message.text;
  return text.length > MAX_QUESTION_BODY_CHARS ? `${text.slice(0, MAX_QUESTION_BODY_CHARS - 1)}…` : text;
}
