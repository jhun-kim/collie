import type { TerminalChild } from "./terminal-process.ts";
import type { TerminalRequest } from "./terminal-protocol.ts";

export type TerminalSocketData = TerminalRequest & {
  readonly id: string;
  readonly socketPath: string;
  readonly session: string;
  readonly device: string | null;
};

export interface TerminalSocket {
  send(data: string): number;
  close(code: number, reason: string): void;
}

export type ActiveTerminal = {
  readonly data: TerminalSocketData;
  readonly socket: TerminalSocket;
  readonly child: TerminalChild;
  stderr: string;
  drainPromise: Promise<void> | null;
  drainResolve: (() => void) | null;
  audited: boolean;
};

export const MAX_CHILD_LINE_BYTES = 2 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
