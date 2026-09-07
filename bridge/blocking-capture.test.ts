import { describe, expect, test } from "bun:test";

import {
  BlockingMessageStore,
  captureBlockingMessage,
  extractQuestion,
  MAX_QUESTION_BODY_CHARS,
  questionBodyFor,
} from "./blocking-capture.ts";
import { NotificationCoordinator, type NotifyClock, type NotifySink, type HerdSummary } from "./notifications.ts";
import type { AgentStatus, AgentView } from "./types.ts";

// ── Question extraction ────────────────────────────────────────────────────────

describe("extractQuestion", () => {
  test("lifts the question out of a Claude box dialog, ignoring borders and options", () => {
    const text = [
      "╭──────────────────────────────────╮",
      "│ Do you want to proceed?          │",
      "│ ❯ 1. Yes                         │",
      "│   2. Yes, and don't ask again    │",
      "│   3. No, and tell Claude what to │",
      "╰──────────────────────────────────╯",
    ].join("\n");
    expect(extractQuestion(text)).toBe("Do you want to proceed?");
  });

  test("prefers the last question-shaped line", () => {
    const text = "Fix the failing test?\n…some output…\nShould I also update the README?";
    expect(extractQuestion(text)).toBe("Should I also update the README?");
  });

  test("finds plain (y/n) prompts without a question mark", () => {
    expect(extractQuestion("Ready to deploy (y/n)?")).toBe("Ready to deploy (y/n)?");
    expect(extractQuestion("Proceed? (y/n)")).toBe("Proceed? (y/n)");
  });

  test("collapses runs of internal whitespace left by borders", () => {
    expect(extractQuestion("│ Continue with the plan?   │")).toBe("Continue with the plan?");
  });

  test("returns null when nothing question-shaped survives", () => {
    expect(extractQuestion("")).toBeNull();
    expect(extractQuestion("───\n❯ 1. Yes\n2. No\n───")).toBeNull();
    expect(extractQuestion("no question here\njust output")).toBeNull();
  });
});

// ── Store + body formatting ────────────────────────────────────────────────────

describe("BlockingMessageStore / questionBodyFor", () => {
  test("stores, replaces, and removes captures", () => {
    const store = new BlockingMessageStore();
    expect(store.get("w1:p1")).toBeUndefined();
    store.capture("w1:p1", "first?");
    store.capture("w1:p1", "second?");
    expect(store.get("w1:p1")?.text).toBe("second?");
    expect(store.get("w1:p1")?.capturedAt).toBeGreaterThan(0);
    store.remove("w1:p1");
    expect(store.get("w1:p1")).toBeUndefined();
  });

  test("questionBodyFor returns null when nothing was captured", () => {
    expect(questionBodyFor(new BlockingMessageStore(), "w1:p1")).toBeNull();
  });

  test(`questionBodyFor truncates the body to ${MAX_QUESTION_BODY_CHARS} characters with an ellipsis`, () => {
    const store = new BlockingMessageStore();
    const long =
      "Should I rewrite the whole module including its tests and the documentation pages that reference its public behaviour?";
    store.capture("w1:p1", long);
    const body = questionBodyFor(store, "w1:p1");
    expect(body).not.toBeNull();
    expect(body!.length).toBeLessThanOrEqual(MAX_QUESTION_BODY_CHARS);
    expect(body!.endsWith("…")).toBe(true);
    expect(body!.startsWith("Should I rewrite")).toBe(true);
  });
});

// ── Capture wiring ─────────────────────────────────────────────────────────────

type FakeHerdr = {
  readPane(paneId: string, source: string, lines: number, format?: string): Promise<{ text: string }>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("captureBlockingMessage", () => {
  test("reads the recent pane text and stores the extracted question", async () => {
    const store = new BlockingMessageStore();
    const reads: Array<[string, string, number, string]> = [];
    const herdr: FakeHerdr = {
      async readPane(paneId, source, lines, format = "text") {
        reads.push([paneId, source, lines, format]);
        return { text: "╭──╮\n│ Ship it now? │\n╰──╯" };
      },
    };
    const ok = await captureBlockingMessage(
      herdr as never,
      "w1:p1",
      store,
      () => 1234,
    );
    expect(ok).toBe(true);
    expect(reads).toEqual([["w1:p1", "recent", 30, "text"]]);
    expect(store.get("w1:p1")).toEqual({ text: "Ship it now?", capturedAt: 1234 });
  });

  test("a failed read leaves the store untouched (notification falls back)", async () => {
    const store = new BlockingMessageStore();
    const herdr: FakeHerdr = {
      async readPane() {
        throw new Error("socket gone");
      },
    };
    const ok = await captureBlockingMessage(herdr as never, "w1:p1", store, () => 1);
    expect(ok).toBe(false);
    expect(store.get("w1:p1")).toBeUndefined();
  });

  test("a read with no question-shaped line stores nothing", async () => {
    const store = new BlockingMessageStore();
    const herdr: FakeHerdr = {
      async readPane() {
        return { text: "just output, no question" };
      },
    };
    await captureBlockingMessage(herdr as never, "w1:p1", store, () => 1);
    expect(store.get("w1:p1")).toBeUndefined();
  });

  test("a late read after unblock cannot restore a stale question", async () => {
    const store = new BlockingMessageStore();
    const read = deferred<{ text: string }>();
    const herdr: FakeHerdr = {
      readPane: () => read.promise,
    };
    const token = store.beginCapture("w1:p1");
    const capture = captureBlockingMessage(herdr as never, "w1:p1", store, () => 1, token);

    store.remove("w1:p1");
    read.resolve({ text: "Proceed with the old change?" });

    await expect(capture).resolves.toBe(false);
    expect(store.get("w1:p1")).toBeUndefined();
    expect(store.isCurrent(token)).toBe(false);
  });

  test("a stale first read cannot overwrite a newer blocked generation", async () => {
    const store = new BlockingMessageStore();
    const first = deferred<{ text: string }>();
    const second = deferred<{ text: string }>();
    const reads = [first, second];
    const herdr: FakeHerdr = {
      readPane: () => reads.shift()!.promise,
    };

    const firstToken = store.beginCapture("w1:p1");
    const firstCapture = captureBlockingMessage(herdr as never, "w1:p1", store, () => 10, firstToken);
    store.remove("w1:p1");
    const secondToken = store.beginCapture("w1:p1");
    const secondCapture = captureBlockingMessage(herdr as never, "w1:p1", store, () => 20, secondToken);

    second.resolve({ text: "Use the new answer?" });
    await expect(secondCapture).resolves.toBe(true);
    expect(store.get("w1:p1")).toEqual({ text: "Use the new answer?", capturedAt: 20 });

    first.resolve({ text: "Use the stale answer?" });
    await expect(firstCapture).resolves.toBe(false);
    expect(store.get("w1:p1")).toEqual({ text: "Use the new answer?", capturedAt: 20 });
  });
});

// ── Notification body integration ──────────────────────────────────────────────

class FakeClock implements NotifyClock<number> {
  private readonly timers = new Map<number, () => void>();
  private next = 1;
  schedule(fn: () => void, _delayMs: number): number {
    const id = this.next++;
    this.timers.set(id, fn);
    return id;
  }
  cancel(handle: number): void {
    this.timers.delete(handle);
  }
  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    for (const fn of fns) fn();
  }
}

class RecordingSink implements NotifySink {
  readonly summaries: HerdSummary[] = [];
  render(summary: HerdSummary): void {
    this.summaries.push(summary);
  }
  clear(): void {}
}

const agent = (paneId: string, agentName: string): AgentView => ({
  paneId,
  workspaceId: "w1",
  workspaceLabel: "demo",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: agentName,
  status: "blocked" satisfies AgentStatus,
  cwd: "/repo",
  focused: false,
});

describe("NotificationCoordinator question body", () => {
  test("a captured question replaces the workspace · cwd body", () => {
    const store = new BlockingMessageStore();
    store.capture("w1:p1", "Do you want to proceed?");
    const sink = new RecordingSink();
    const clock = new FakeClock();
    const coordinator = new NotificationCoordinator(
      clock,
      sink,
      0,
      () => true,
      (paneId) => questionBodyFor(store, paneId),
    );
    coordinator.onTransition(agent("w1:p1", "claude"), "working", "blocked");
    clock.fireAll();
    expect(sink.summaries.at(-1)).toMatchObject({
      title: "claude needs you",
      body: "Do you want to proceed?",
      paneId: "w1:p1",
    });
  });

  test("without a capture the body falls back to workspace · cwd", () => {
    const sink = new RecordingSink();
    const clock = new FakeClock();
    const coordinator = new NotificationCoordinator(
      clock,
      sink,
      0,
      () => true,
      () => null,
    );
    coordinator.onTransition(agent("w1:p1", "claude"), "working", "blocked");
    clock.fireAll();
    expect(sink.summaries.at(-1)?.body).toBe("demo · /repo");
  });

  test("done notifications never reuse an old blocked question", () => {
    const store = new BlockingMessageStore();
    store.capture("w1:p1", "Old blocked question?");
    const sink = new RecordingSink();
    const clock = new FakeClock();
    const coordinator = new NotificationCoordinator(
      clock,
      sink,
      0,
      () => true,
      (paneId) => questionBodyFor(store, paneId),
    );
    coordinator.onTransition({ ...agent("w1:p1", "claude"), status: "done" }, "working", "done");
    clock.fireAll();
    expect(sink.summaries.at(-1)).toMatchObject({
      title: "claude is done",
      body: "demo · /repo",
      paneId: "w1:p1",
    });
  });

  test("a slow successful capture is reflected even with zero notification debounce", async () => {
    const store = new BlockingMessageStore();
    const read = deferred<{ text: string }>();
    const herdr: FakeHerdr = {
      readPane: () => read.promise,
    };
    const sink = new RecordingSink();
    const clock = new FakeClock();
    const coordinator = new NotificationCoordinator(
      clock,
      sink,
      0,
      () => true,
      (paneId) => questionBodyFor(store, paneId),
    );
    const blocked = agent("w1:p1", "claude");
    const token = store.beginCapture(blocked.paneId);
    const capture = captureBlockingMessage(herdr as never, blocked.paneId, store, () => 123, token).finally(() => {
      if (store.isCurrent(token)) coordinator.onTransition(blocked, "working", "blocked");
    });

    clock.fireAll();
    expect(sink.summaries).toEqual([]);

    read.resolve({ text: "Can I edit the bridge now?" });
    await capture;
    clock.fireAll();

    expect(sink.summaries.at(-1)).toMatchObject({
      title: "claude needs you",
      body: "Can I edit the bridge now?",
      paneId: "w1:p1",
    });
  });

  test("a failed capture still schedules the fallback body when the blocked generation is current", async () => {
    const store = new BlockingMessageStore();
    const read = deferred<{ text: string }>();
    const herdr: FakeHerdr = {
      readPane: () => read.promise,
    };
    const sink = new RecordingSink();
    const clock = new FakeClock();
    const coordinator = new NotificationCoordinator(
      clock,
      sink,
      0,
      () => true,
      (paneId) => questionBodyFor(store, paneId),
    );
    const blocked = agent("w1:p1", "claude");
    const token = store.beginCapture(blocked.paneId);
    const capture = captureBlockingMessage(herdr as never, blocked.paneId, store, () => 123, token).finally(() => {
      if (store.isCurrent(token)) coordinator.onTransition(blocked, "working", "blocked");
    });

    read.reject(new Error("socket gone"));
    await capture;
    clock.fireAll();

    expect(sink.summaries.at(-1)).toMatchObject({
      title: "claude needs you",
      body: "demo · /repo",
      paneId: "w1:p1",
    });
  });
});
