import type { AgentView } from "./types.ts";
import type { TerminalSocketData } from "./terminal-connection.ts";
import type { TerminalProxy } from "./terminal-proxy.ts";
import { parseTerminalRequest, type TerminalMode } from "./terminal-protocol.ts";

type TerminalRuntime = {
  readonly name: string;
  readonly socketPath: string;
  readonly engine: {
    current(): {
      readonly agents: readonly AgentView[];
      readonly shellPanes: readonly AgentView[];
    };
  };
};

type TerminalRouteContext = {
  readonly registry: { get(name?: string): TerminalRuntime | undefined };
  readonly proxy: Pick<TerminalProxy, "reserve" | "cancel">;
  readonly deny: (request: Request, mode: TerminalMode) => Response | null;
  readonly device: (request: Request) => string | null;
  readonly upgrade: (request: Request, data: TerminalSocketData) => boolean;
  readonly response: (body: string, status: number) => Response;
};

function runtimeHasPane(runtime: TerminalRuntime, paneId: string): boolean {
  const snapshot = runtime.engine.current();
  return [...snapshot.agents, ...snapshot.shellPanes].some((pane) => pane.paneId === paneId);
}

export function terminalRouteResponse(
  request: Request,
  context: TerminalRouteContext,
): Response | undefined {
  if (request.method !== "GET") return context.response("method not allowed", 405);
  const parsed = parseTerminalRequest(request);
  if (!parsed.ok) return context.response(parsed.error, 400);
  const denied = context.deny(request, parsed.value.mode);
  if (denied !== null) return denied;
  const url = new URL(request.url);
  if (url.searchParams.getAll("session").length > 1) {
    return context.response("duplicate session", 400);
  }
  const session = url.searchParams.get("session") ?? undefined;
  const runtime = context.registry.get(session);
  if (runtime === undefined) return context.response(`unknown session: ${session ?? ""}`, 404);
  if (!runtimeHasPane(runtime, parsed.value.paneId)) {
    return context.response("pane not found in selected session", 404);
  }
  const reserved = context.proxy.reserve(parsed.value, {
    socketPath: runtime.socketPath,
    session: runtime.name,
    device: context.device(request),
  });
  if (!reserved.ok) return context.response(reserved.error, reserved.status);
  let upgraded = false;
  try {
    upgraded = context.upgrade(request, reserved.data);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  if (upgraded) return undefined;
  context.proxy.cancel(reserved.data.id);
  return context.response("WebSocket upgrade failed", 400);
}
