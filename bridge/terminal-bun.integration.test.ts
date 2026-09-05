import { describe, expect, test } from "bun:test";

import type { AuditEntry } from "./audit.ts";
import type { Config } from "./config.ts";
import { terminalOriginAllowed } from "./extension-routes.ts";
import type { TerminalSocketData } from "./terminal-connection.ts";
import { terminalWebSocketHandler } from "./terminal-bun.ts";
import type { TerminalChild, TerminalSpawner } from "./terminal-process.ts";
import { TerminalProxy } from "./terminal-proxy.ts";
import { terminalRouteResponse } from "./terminal-route.ts";
import { deviceAuth, guard } from "./server.ts";

class FakeChild implements TerminalChild {
  readonly input: string[] = [];
  readonly stdoutPipe = new TransformStream<Uint8Array, Uint8Array>();
  readonly stderrPipe = new TransformStream<Uint8Array, Uint8Array>();
  readonly stdout = this.stdoutPipe.readable;
  readonly stderr = this.stderrPipe.readable;
  readonly exited: Promise<number>;
  private resolveExit: (code: number) => void = () => undefined;
  private inputListener: (() => void) | null = null;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  readonly stdin = {
    write: (data: string): number => {
      this.input.push(data);
      this.inputListener?.();
      return data.length;
    },
    end: (): void => undefined,
  };

  kill(_signal?: "SIGTERM" | "SIGKILL"): void {
    this.resolveExit(0);
    void this.stdoutPipe.writable.close();
    void this.stderrPipe.writable.close();
  }

  async emit(line: string): Promise<void> {
    const writer = this.stdoutPipe.writable.getWriter();
    await writer.write(new TextEncoder().encode(`${line}\n`));
    writer.releaseLock();
  }

  nextInput(): Promise<void> {
    return new Promise((resolve) => {
      this.inputListener = resolve;
    });
  }
}

function config(port: number): Config {
  return {
    socketPath: "/cfg/herdr.sock",
    port,
    host: "127.0.0.1",
    pollMs: 1500,
    pollIdleMs: 12_000,
    notifyDelayMs: 30_000,
    readLines: 200,
    transcript: false,
    transcriptRoot: "/tmp/transcripts",
    submitKeys: ["Enter"],
    trustedUser: "",
    deviceHeader: "x-device-id",
    deviceAllowlist: ["phone"],
    allowedOrigins: [],
    publicHosts: [],
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:test@example.com",
    stateDir: "/tmp/collie-terminal-test",
    multiSession: true,
    skipServe: true,
  };
}

function frame(bytes: string): string {
  return JSON.stringify({
    type: "terminal.frame",
    seq: 1,
    encoding: "ansi",
    width: 120,
    height: 40,
    full: true,
    bytes,
  });
}

function openSocket(url: string, headers: Readonly<Record<string, string>>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const candidate: unknown = Reflect.construct(WebSocket, [url, { headers: { ...headers } }]);
    if (!(candidate instanceof WebSocket)) throw new Error("WebSocket construction failed");
    const socket = candidate;
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket rejected")), { once: true });
  });
}

function rejectedSocket(url: string, headers: Readonly<Record<string, string>>): Promise<void> {
  return new Promise((resolve) => {
    const candidate: unknown = Reflect.construct(WebSocket, [url, { headers: { ...headers } }]);
    if (!(candidate instanceof WebSocket)) throw new Error("WebSocket construction failed");
    const socket = candidate;
    socket.addEventListener("error", () => resolve(), { once: true });
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
  });
}

function closedSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
}

async function debugStage(stage: string, work: Promise<void>): Promise<void> {
  await Promise.race([
    work,
    Bun.sleep(500).then(() => {
      throw new Error(`debug timeout: ${stage}`);
    }),
  ]);
}

async function forceStopAndRebind(server: Bun.Server<TerminalSocketData>): Promise<void> {
  const port = server.port;
  void server.stop(true);
  server.unref();
  const replacement = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response("replacement"),
  });
  await replacement.stop(true);
}

function harness() {
  const children: FakeChild[] = [];
  const spawns: Array<{
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
  }> = [];
  const audits: AuditEntry[] = [];
  const spawn: TerminalSpawner = (argv, env) => {
    spawns.push({ argv, env });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const proxy = new TerminalProxy({
    spawn,
    audit: { record: (entry) => void audits.push(entry) },
  });
  const cfg = config(0);
  const registry = {
    get: (name?: string) =>
      name === undefined || name === "default"
        ? {
            name: "default",
            socketPath: "/cfg/herdr.sock",
            engine: {
              current: () => ({
                agents: [],
                shellPanes: [
                  {
                    paneId: "w1:p1",
                    workspaceId: "w1",
                    workspaceLabel: "w1",
                    workspaceNumber: 1,
                    tabId: "w1:t1",
                    agent: "shell",
                    status: "idle" as const,
                    cwd: "/repo",
                    focused: false,
                    kind: "shell" as const,
                  },
                ],
              }),
            },
          }
        : undefined,
  };
  const server = Bun.serve<TerminalSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      return terminalRouteResponse(request, {
        registry,
        proxy,
        deny: (candidate, mode) => {
          const denied = guard(candidate, cfg, mode === "control" ? "write" : "read");
          if (denied !== null) return denied;
          return terminalOriginAllowed(candidate, cfg)
            ? null
            : new Response("cross-origin rejected", { status: 403 });
        },
        device: (candidate) => deviceAuth(candidate, cfg).device,
        upgrade: (candidate, data) => bunServer.upgrade(candidate, { data }),
        response: (body, status) => new Response(body, { status }),
      });
    },
    websocket: terminalWebSocketHandler(proxy),
  });
  return { server, proxy, children, spawns, audits };
}

describe("Bun terminal WebSocket integration", () => {
  test("upgrades, relays a frame, translates control input, and audits readiness", async () => {
    // Given
    const h = harness();
    const origin = `http://127.0.0.1:${h.server.port}`;
    const socket = await openSocket(
      `${origin}/ws/terminal/w1%3Ap1?mode=control`,
      { origin, "x-device-id": "phone" },
    );
    const child = h.children[0];
    if (child === undefined) throw new Error("child missing");
    const message = nextMessage(socket);

    // When
    await child.emit(frame("G1sySg=="));
    const received = await message;
    const input = child.nextInput();
    socket.send('{"cmd":"terminal.input","text":"ls\\n"}');
    await input;

    // Then
    expect(received).toBe(frame("G1sySg=="));
    expect(child.input).toEqual(['{"type":"terminal.input","text":"ls\\n"}\n']);
    expect(h.spawns[0]).toEqual({
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
      env: expect.objectContaining({ HERDR_SOCKET_PATH: "/cfg/herdr.sock" }),
    });
    expect(h.audits).toHaveLength(1);
    const closed = closedSocket(socket);
    await debugStage("proxy shutdown", h.proxy.shutdown());
    await closed;
    await forceStopAndRebind(h.server);
  });

  test("allows two observers and only one local controller lease", async () => {
    // Given
    const h = harness();
    const origin = `http://127.0.0.1:${h.server.port}`;
    const headers = { origin, "x-device-id": "phone" };

    // When
    const observerOne = await openSocket(
      `${origin}/ws/terminal/w1%3Ap1?mode=observe`,
      headers,
    );
    const observerTwo = await openSocket(
      `${origin}/ws/terminal/w1%3Ap1?mode=observe`,
      headers,
    );
    const controller = await openSocket(
      `${origin}/ws/terminal/w1%3Ap1?mode=control`,
      headers,
    );
    await rejectedSocket(`${origin}/ws/terminal/w1%3Ap1?mode=control`, headers);

    // Then
    expect(h.children).toHaveLength(3);
    const closed = [observerOne, observerTwo, controller].map(closedSocket);
    await debugStage("proxy shutdown", h.proxy.shutdown());
    await Promise.all(closed);
    await forceStopAndRebind(h.server);
  });

  test("rejects wrong origin, unknown session, missing pane, and read-only control", async () => {
    // Given
    const h = harness();
    const origin = `http://127.0.0.1:${h.server.port}`;

    // When
    await Promise.all([
      rejectedSocket(`${origin}/ws/terminal/w1%3Ap1`, { origin: "https://evil.example" }),
      rejectedSocket(`${origin}/ws/terminal/w1%3Ap1?session=missing`, { origin }),
      rejectedSocket(`${origin}/ws/terminal/missing`, { origin }),
      rejectedSocket(`${origin}/ws/terminal/w1%3Ap1?mode=control`, { origin }),
    ]);

    // Then
    expect(h.children).toHaveLength(0);
    expect(h.audits).toEqual([]);
    await h.proxy.shutdown();
    await h.server.stop(true);
  });
});
