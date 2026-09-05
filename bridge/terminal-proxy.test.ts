import { describe, expect, test } from "bun:test";

import type { AuditEntry } from "./audit.ts";
import type { TerminalSocket } from "./terminal-connection.ts";
import type { TerminalChild, TerminalSpawner } from "./terminal-process.ts";
import { TerminalProxy } from "./terminal-proxy.ts";

class FakeSocket implements TerminalSocket {
  readonly sent: string[] = [];
  readonly closes: Array<{ readonly code: number; readonly reason: string }> = [];
  sendResults: number[] = [];
  onSend: (() => void) | null = null;

  send(data: string): number {
    this.sent.push(data);
    this.onSend?.();
    return this.sendResults.shift() ?? data.length;
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

class FakeChild implements TerminalChild {
  readonly input: string[] = [];
  readonly stdoutPipe = new TransformStream<Uint8Array, Uint8Array>();
  readonly stderrPipe = new TransformStream<Uint8Array, Uint8Array>();
  readonly stdout = this.stdoutPipe.readable;
  readonly stderr = this.stderrPipe.readable;
  readonly exited: Promise<number>;
  killed = 0;
  ended = 0;
  private resolveExit: (code: number) => void = () => undefined;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  readonly stdin = {
    write: (data: string): number => {
      this.input.push(data);
      return data.length;
    },
    end: (): void => {
      this.ended += 1;
    },
  };

  kill(): void {
    this.killed += 1;
    this.resolveExit(0);
  }
}

type Harness = {
  readonly proxy: TerminalProxy;
  readonly children: FakeChild[];
  readonly spawns: Array<{
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
  }>;
  readonly audits: AuditEntry[];
};

function harness(): Harness {
  const children: FakeChild[] = [];
  const spawns: Harness["spawns"] = [];
  const audits: AuditEntry[] = [];
  const spawn: TerminalSpawner = (argv, env) => {
    spawns.push({ argv, env });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return {
    proxy: new TerminalProxy({ spawn, audit: { record: (entry) => void audits.push(entry) } }),
    children,
    spawns,
    audits,
  };
}

const request = {
  paneId: "w1:p1",
  mode: "control",
  cols: 120,
  rows: 40,
} as const;
const identity = {
  socketPath: "/cfg/herdr/sessions/work/herdr.sock",
  session: "work",
  device: "phone",
} as const;

function frame(bytes: string, seq = 1): string {
  return JSON.stringify({
    type: "terminal.frame",
    seq,
    encoding: "ansi",
    width: 120,
    height: 40,
    full: true,
    bytes,
  });
}

describe("TerminalProxy reservation and spawn", () => {
  test("allows multiple observers but reserves one controller per socket and pane", () => {
    // Given
    const h = harness();
    const observer = { ...request, mode: "observe" } as const;

    // When
    const reservations = [
      h.proxy.reserve(observer, identity),
      h.proxy.reserve(observer, identity),
      h.proxy.reserve(request, identity),
      h.proxy.reserve(request, identity),
    ];

    // Then
    expect(reservations.map((result) => result.ok)).toEqual([true, true, true, false]);
    expect(h.spawns).toHaveLength(0);
  });

  test("spawns exact argv and audits only after the first accepted valid frame", async () => {
    // Given
    const h = harness();
    const reserved = h.proxy.reserve(request, identity);
    if (!reserved.ok) throw new Error(reserved.error);
    const socket = new FakeSocket();

    // When
    h.proxy.open(reserved.data, socket);
    h.proxy.open(reserved.data, socket);
    expect(h.audits).toEqual([]);
    const sent = new Promise<void>((resolve) => {
      socket.onSend = resolve;
    });
    const writer = h.children[0]?.stdoutPipe.writable.getWriter();
    if (writer === undefined) throw new Error("child missing");
    await writer.write(new TextEncoder().encode(`${frame("YQ==")}\n`));
    await sent;

    // Then
    expect(h.spawns).toEqual([
      {
        argv: [
          "herdr",
          "terminal",
          "session",
          "control",
          "w1:p1",
          "--takeover",
          "--cols",
          "120",
          "--rows",
          "40",
        ],
        env: expect.objectContaining({ HERDR_SOCKET_PATH: identity.socketPath }),
      },
    ]);
    expect(h.audits).toEqual([
      {
        action: "terminal.control",
        paneId: "w1:p1",
        session: "work",
        device: "phone",
        detail: { cols: 120, rows: 40 },
      },
    ]);
  });
});

describe("TerminalProxy relay and control", () => {
  test("relays split and bursty frame lines then closes on terminal.closed", async () => {
    // Given
    const h = harness();
    const reserved = h.proxy.reserve({ ...request, mode: "observe" }, identity);
    if (!reserved.ok) throw new Error(reserved.error);
    const socket = new FakeSocket();
    h.proxy.open(reserved.data, socket);
    const writer = h.children[0]?.stdoutPipe.writable.getWriter();
    if (writer === undefined) throw new Error("child missing");
    const encoder = new TextEncoder();

    // When
    const first = frame("YQ==");
    const second = frame("Yg==", 2);
    await writer.write(encoder.encode(first.slice(0, -4)));
    await writer.write(
      encoder.encode(`${first.slice(-4)}\n${second}\n{"type":"terminal.closed"}\n`),
    );
    await writer.close();
    await h.children[0]?.exited;

    // Then
    expect(socket.sent).toEqual([
      first,
      second,
      '{"type":"terminal.closed"}',
    ]);
    expect(socket.closes).toEqual([{ code: 1000, reason: "terminal closed" }]);
  });

  test("translates control input and releases the child", async () => {
    // Given
    const h = harness();
    const reserved = h.proxy.reserve(request, identity);
    if (!reserved.ok) throw new Error(reserved.error);
    const socket = new FakeSocket();
    h.proxy.open(reserved.data, socket);

    // When
    await h.proxy.message(reserved.data, socket, '{"cmd":"terminal.input","text":"ls\\n"}');
    await h.proxy.message(reserved.data, socket, '{"cmd":"terminal.release"}');

    // Then
    expect(h.children[0]?.input).toEqual([
      '{"type":"terminal.input","text":"ls\\n"}\n',
      '{"type":"terminal.release"}\n',
    ]);
    expect(h.children[0]?.ended).toBe(1);
    expect(h.children[0]?.killed).toBe(1);
  });

  test("rejects commands in observe mode without auditing", async () => {
    // Given
    const h = harness();
    const reserved = h.proxy.reserve({ ...request, mode: "observe" }, identity);
    if (!reserved.ok) throw new Error(reserved.error);
    const socket = new FakeSocket();
    h.proxy.open(reserved.data, socket);

    // When
    await h.proxy.message(reserved.data, socket, '{"cmd":"terminal.input","text":"x"}');

    // Then
    expect(socket.closes[0]?.code).toBe(1008);
    expect(h.children[0]?.input).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  test("pauses after accepted backpressure and never resends that frame", async () => {
    // Given
    const h = harness();
    const reserved = h.proxy.reserve({ ...request, mode: "observe" }, identity);
    if (!reserved.ok) throw new Error(reserved.error);
    const socket = new FakeSocket();
    socket.sendResults = [-1, 10];
    const firstSend = new Promise<void>((resolve) => {
      socket.onSend = resolve;
    });
    h.proxy.open(reserved.data, socket);
    const writer = h.children[0]?.stdoutPipe.writable.getWriter();
    if (writer === undefined) throw new Error("child missing");
    const encoder = new TextEncoder();

    // When
    const write = writer.write(
      encoder.encode(`${frame("YQ==")}\n${frame("Yg==", 2)}\n`),
    );
    await firstSend;
    expect(socket.sent).toEqual([frame("YQ==")]);
    const secondSend = new Promise<void>((resolve) => {
      socket.onSend = resolve;
    });
    h.proxy.drain(reserved.data);
    await Promise.all([write, secondSend]);

    // Then
    expect(socket.sent).toEqual([
      frame("YQ=="),
      frame("Yg==", 2),
    ]);
  });

  test("closes with 1013 when Bun drops a frame", async () => {
    // Given
    const h = harness();
    const reserved = h.proxy.reserve({ ...request, mode: "observe" }, identity);
    if (!reserved.ok) throw new Error(reserved.error);
    const socket = new FakeSocket();
    socket.sendResults = [0];
    h.proxy.open(reserved.data, socket);
    const writer = h.children[0]?.stdoutPipe.writable.getWriter();
    if (writer === undefined) throw new Error("child missing");

    // When
    await writer.write(new TextEncoder().encode(`${frame("YQ==")}\n`));

    // Then
    expect(socket.closes[0]).toEqual({ code: 1013, reason: "terminal relay overloaded" });
    expect(h.children[0]?.killed).toBe(1);
  });

  test("rejects malformed child frames without auditing control", async () => {
    // Given
    const h = harness();
    const reserved = h.proxy.reserve(request, identity);
    if (!reserved.ok) throw new Error(reserved.error);
    const socket = new FakeSocket();
    h.proxy.open(reserved.data, socket);
    const writer = h.children[0]?.stdoutPipe.writable.getWriter();
    if (writer === undefined) throw new Error("child missing");

    // When
    await writer.write(new TextEncoder().encode('{"type":"terminal.frame"}\n'));

    // Then
    expect(socket.closes[0]?.code).toBe(1011);
    expect(socket.sent).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  test("relays a burst whose aggregate exceeds the per-line bound", async () => {
    // Given
    const h = harness();
    const reserved = h.proxy.reserve({ ...request, mode: "observe" }, identity);
    if (!reserved.ok) throw new Error(reserved.error);
    const socket = new FakeSocket();
    const secondSend = new Promise<void>((resolve) => {
      let count = 0;
      socket.onSend = () => {
        count += 1;
        if (count === 2) resolve();
      };
    });
    h.proxy.open(reserved.data, socket);
    const writer = h.children[0]?.stdoutPipe.writable.getWriter();
    if (writer === undefined) throw new Error("child missing");
    const payload = Buffer.alloc(800_000).toString("base64");

    // When
    await writer.write(new TextEncoder().encode(`${frame(payload)}\n${frame(payload, 2)}\n`));
    await secondSend;

    // Then
    expect(socket.sent).toHaveLength(2);
    expect(socket.closes).toEqual([]);
  });

  test("rejects binary client messages explicitly", async () => {
    // Given
    const h = harness();
    const reserved = h.proxy.reserve(request, identity);
    if (!reserved.ok) throw new Error(reserved.error);
    const socket = new FakeSocket();
    h.proxy.open(reserved.data, socket);

    // When
    await h.proxy.message(reserved.data, socket, new Uint8Array([1]));

    // Then
    expect(socket.closes[0]?.code).toBe(1003);
    expect(h.audits).toEqual([]);
  });
});

describe("TerminalProxy cleanup", () => {
  test("socket close releases the lease and permits a reconnect", async () => {
    // Given
    const h = harness();
    const first = h.proxy.reserve(request, identity);
    if (!first.ok) throw new Error(first.error);
    h.proxy.open(first.data, new FakeSocket());

    // When
    await h.proxy.close(first.data);
    const second = h.proxy.reserve(request, identity);

    // Then
    expect(h.children[0]?.ended).toBe(1);
    expect(h.children[0]?.killed).toBe(1);
    expect(second.ok).toBe(true);
  });

  test("session disposal and shutdown close only their selected connections", async () => {
    // Given
    const h = harness();
    const work = h.proxy.reserve(request, identity);
    const otherIdentity = { ...identity, socketPath: "/cfg/herdr/herdr.sock", session: "default" };
    const other = h.proxy.reserve(request, otherIdentity);
    if (!work.ok || !other.ok) throw new Error("reservation failed");
    const workSocket = new FakeSocket();
    const otherSocket = new FakeSocket();
    h.proxy.open(work.data, workSocket);
    h.proxy.open(other.data, otherSocket);

    // When
    await h.proxy.closeSocket(identity.socketPath);

    // Then
    expect(workSocket.closes[0]?.code).toBe(1012);
    expect(otherSocket.closes).toEqual([]);
    await h.proxy.shutdown();
    expect(otherSocket.closes[0]?.code).toBe(1012);
  });
});
