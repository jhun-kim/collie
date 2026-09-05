import type { TerminalSocketData } from "./terminal-connection.ts";
import {
  MAX_TERMINAL_WEBSOCKET_PAYLOAD,
  type TerminalProxy,
} from "./terminal-proxy.ts";

export function terminalWebSocketHandler(
  proxy: TerminalProxy,
): Bun.WebSocketHandler<TerminalSocketData> {
  return {
    open: (socket) => proxy.open(socket.data, socket),
    message: (socket, message) => proxy.message(socket.data, socket, message),
    drain: (socket) => proxy.drain(socket.data),
    close: (socket) => proxy.close(socket.data),
    maxPayloadLength: MAX_TERMINAL_WEBSOCKET_PAYLOAD,
    backpressureLimit: MAX_TERMINAL_WEBSOCKET_PAYLOAD,
    closeOnBackpressureLimit: false,
    idleTimeout: 120,
  };
}
