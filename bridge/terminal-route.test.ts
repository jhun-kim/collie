import { describe, expect, test } from "bun:test";

import type { TerminalSocketData } from "./terminal-connection.ts";
import { terminalRouteResponse } from "./terminal-route.ts";

const agent = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "work",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "shell",
  status: "idle",
  cwd: "/repo",
  focused: false,
  kind: "shell",
} as const;

function request(path = "/ws/terminal/w1%3Ap1?mode=control&session=work"): Request {
  return new Request(`https://collie.ts.net${path}`, {
    headers: { host: "collie.ts.net", origin: "https://collie.ts.net" },
  });
}

function context(overrides: {
  readonly pane?: boolean;
  readonly session?: boolean;
  readonly deny?: Response | null;
  readonly upgrade?: boolean;
  readonly upgradeThrows?: boolean;
} = {}) {
  const cancelled: string[] = [];
  const upgrades: TerminalSocketData[] = [];
  let sequence = 0;
  return {
    cancelled,
    upgrades,
    value: {
      registry: {
        get: (name?: string) =>
          overrides.session === false || name !== "work"
            ? undefined
            : {
                name: "work",
                socketPath: "/cfg/herdr/sessions/work/herdr.sock",
                engine: {
                  current: () => ({
                    agents: [],
                    shellPanes: overrides.pane === false ? [] : [agent],
                  }),
                },
              },
      },
      proxy: {
        reserve: (
          terminal: {
            readonly paneId: string;
            readonly mode: "observe" | "control";
            readonly cols: number;
            readonly rows: number;
          },
          identity: {
            readonly socketPath: string;
            readonly session: string;
            readonly device: string | null;
          },
        ) => ({
          ok: true as const,
          data: { id: `id-${sequence++}`, ...terminal, ...identity },
        }),
        cancel: (id: string) => void cancelled.push(id),
      },
      deny: () => overrides.deny ?? null,
      device: () => "phone",
      upgrade: (_request: Request, data: TerminalSocketData) => {
        upgrades.push(data);
        if (overrides.upgradeThrows) throw new Error("upgrade crashed");
        return overrides.upgrade ?? true;
      },
      response: (body: string, status: number) => new Response(body, { status }),
    },
  };
}

describe("terminalRouteResponse", () => {
  test("upgrades a selected-session pane with socket and device identity", () => {
    // Given
    const h = context();

    // When
    const response = terminalRouteResponse(request(), h.value);

    // Then
    expect(response).toBeUndefined();
    expect(h.upgrades).toEqual([
      {
        id: "id-0",
        paneId: "w1:p1",
        mode: "control",
        cols: 120,
        rows: 40,
        socketPath: "/cfg/herdr/sessions/work/herdr.sock",
        session: "work",
        device: "phone",
      },
    ]);
  });

  test.each([
    [context({ session: false }), 404],
    [context({ pane: false }), 404],
    [context({ deny: new Response("denied", { status: 403 }) }), 403],
  ] as const)("rejects before upgrade when session, pane, or access is invalid", (h, status) => {
    // Given / When
    const response = terminalRouteResponse(request(), h.value);

    // Then
    expect(response?.status).toBe(status);
    expect(h.upgrades).toEqual([]);
  });

  test("cancels a reservation after failed WebSocket upgrade", () => {
    // Given
    const h = context({ upgrade: false });

    // When
    const response = terminalRouteResponse(request(), h.value);

    // Then
    expect(response?.status).toBe(400);
    expect(h.cancelled).toEqual(["id-0"]);
  });

  test("cancels a reservation when WebSocket upgrade throws", () => {
    // Given
    const h = context({ upgradeThrows: true });

    // When
    const response = terminalRouteResponse(request(), h.value);

    // Then
    expect(response?.status).toBe(400);
    expect(h.cancelled).toEqual(["id-0"]);
  });

  test("rejects a non-GET handshake before access or reservation", () => {
    // Given
    const h = context();
    const post = new Request("https://collie.ts.net/ws/terminal/w1%3Ap1?session=work", {
      method: "POST",
    });

    // When
    const response = terminalRouteResponse(post, h.value);

    // Then
    expect(response?.status).toBe(405);
    expect(h.upgrades).toEqual([]);
  });

  test("rejects duplicate session selection", () => {
    // Given
    const h = context();

    // When
    const response = terminalRouteResponse(
      request("/ws/terminal/w1%3Ap1?session=work&session=default"),
      h.value,
    );

    // Then
    expect(response?.status).toBe(400);
    expect(h.upgrades).toEqual([]);
  });
});
