import type { AuditEntry } from "./audit.ts";
import {
  type ActiveTerminal,
  MAX_CHILD_LINE_BYTES,
  MAX_STDERR_BYTES,
  type TerminalSocket,
  type TerminalSocketData,
} from "./terminal-connection.ts";
import {
  MAX_TERMINAL_INPUT_BYTES,
  parseTerminalClientMessage,
  terminalArgv,
  type TerminalRequest,
} from "./terminal-protocol.ts";
import {
  terminateTerminalChild,
  type TerminalChild,
  type TerminalSpawner,
} from "./terminal-process.ts";
import { parseTerminalRecord } from "./terminal-record.ts";

type TerminalProxyOptions = {
  readonly spawn: TerminalSpawner;
  readonly audit: { record(entry: AuditEntry): void };
};

type ReserveResult =
  | { readonly ok: true; readonly data: TerminalSocketData }
  | { readonly ok: false; readonly status: number; readonly error: string };

export const MAX_TERMINAL_WEBSOCKET_PAYLOAD =
  Math.ceil((MAX_TERMINAL_INPUT_BYTES * 4) / 3) + 1024;

export class TerminalProxy {
  private readonly pending = new Map<string, TerminalSocketData>();
  private readonly active = new Map<string, ActiveTerminal>();
  private readonly leases = new Set<string>();
  private readonly cleanups = new Set<Promise<void>>();

  constructor(private readonly options: TerminalProxyOptions) {}

  reserve(
    request: TerminalRequest,
    identity: {
      readonly socketPath: string;
      readonly session: string;
      readonly device: string | null;
    },
  ): ReserveResult {
    const lease = this.leaseKey(request, identity.socketPath);
    if (request.mode === "control" && this.leases.has(lease)) {
      return { ok: false, status: 409, error: "terminal already has a controller" };
    }
    if (request.mode === "control") this.leases.add(lease);
    const data = { id: crypto.randomUUID(), ...request, ...identity };
    this.pending.set(data.id, data);
    return { ok: true, data };
  }

  cancel(id: string): void {
    const data = this.pending.get(id);
    if (data === undefined) return;
    this.pending.delete(id);
    this.releaseLease(data);
  }

  open(data: TerminalSocketData, socket: TerminalSocket): void {
    if (!this.pending.delete(data.id)) return;
    let child: TerminalChild;
    try {
      child = this.options.spawn(terminalArgv(data), {
        ...process.env,
        HERDR_SOCKET_PATH: data.socketPath,
      });
    } catch (error) {
      this.releaseLease(data);
      socket.close(1011, error instanceof Error ? error.message : "terminal spawn failed");
      return;
    }
    const active: ActiveTerminal = {
      data,
      socket,
      child,
      stderr: "",
      drainPromise: null,
      drainResolve: null,
      audited: false,
    };
    this.active.set(data.id, active);
    void this.readStderr(active);
    void this.relay(active);
    void child.exited.then(
      (code) => this.childExited(active, code),
      (error) =>
        this.childFailed(
          active,
          error instanceof Error ? error.message : "Herdr terminal process failed",
        ),
    );
  }

  async message(
    data: TerminalSocketData,
    socket: TerminalSocket,
    message: string | Uint8Array,
  ): Promise<void> {
    const active = this.active.get(data.id);
    if (active === undefined || active.socket !== socket) return;
    if (typeof message !== "string") {
      socket.close(1003, "binary terminal messages are not supported");
      void this.cleanup(active);
      return;
    }
    if (new TextEncoder().encode(message).byteLength > MAX_TERMINAL_WEBSOCKET_PAYLOAD) {
      socket.close(1009, "terminal message too large");
      void this.cleanup(active);
      return;
    }
    const parsed = parseTerminalClientMessage(message, data.mode);
    if (!parsed.ok) {
      socket.close(1008, parsed.error);
      void this.cleanup(active);
      return;
    }
    try {
      await active.child.stdin.write(parsed.value.line);
    } catch (error) {
      this.fail(
        active,
        1011,
        error instanceof Error ? error.message : "terminal input write failed",
      );
      return;
    }
    if (parsed.value.release) await this.cleanup(active);
  }

  drain(data: TerminalSocketData): void {
    const active = this.active.get(data.id);
    active?.drainResolve?.();
    if (active !== undefined) {
      active.drainPromise = null;
      active.drainResolve = null;
    }
  }

  async close(data: TerminalSocketData): Promise<void> {
    const active = this.active.get(data.id);
    if (active !== undefined) await this.cleanup(active);
    else this.cancel(data.id);
  }

  async closeSocket(socketPath: string): Promise<void> {
    for (const data of [...this.pending.values()]) {
      if (data.socketPath === socketPath) this.cancel(data.id);
    }
    const closing: Promise<void>[] = [];
    for (const active of [...this.active.values()]) {
      if (active.data.socketPath !== socketPath) continue;
      active.socket.close(1012, "Herdr session stopped");
      closing.push(this.cleanup(active));
    }
    await Promise.all(closing);
  }

  async shutdown(): Promise<void> {
    for (const data of [...this.pending.values()]) this.cancel(data.id);
    const closing: Promise<void>[] = [];
    for (const active of [...this.active.values()]) {
      active.socket.close(1012, "bridge shutting down");
      closing.push(this.cleanup(active));
    }
    await Promise.all([...closing, ...this.cleanups]);
  }

  private leaseKey(request: TerminalRequest, socketPath: string): string {
    return `${socketPath}\u0000${request.paneId}`;
  }

  private releaseLease(data: TerminalSocketData): void {
    if (data.mode === "control") this.leases.delete(this.leaseKey(data, data.socketPath));
  }

  private cleanup(active: ActiveTerminal): Promise<void> {
    if (!this.active.delete(active.data.id)) return Promise.resolve();
    active.drainResolve?.();
    this.releaseLease(active.data);
    const cleanup = terminateTerminalChild(active.child)
      .catch((error) => {
        if (!(error instanceof Error)) throw error;
      })
      .then(() => {
        this.cleanups.delete(cleanup);
      });
    this.cleanups.add(cleanup);
    return cleanup;
  }

  private async readStderr(active: ActiveTerminal): Promise<void> {
    const reader = active.child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (this.active.has(active.data.id)) {
        const chunk = await reader.read();
        if (chunk.done) return;
        active.stderr = `${active.stderr}${decoder.decode(chunk.value, { stream: true })}`.slice(
          -MAX_STDERR_BYTES,
        );
      }
      await reader.cancel();
    } catch (error) {
      if (this.active.has(active.data.id)) {
        this.childFailed(
          active,
          error instanceof Error ? error.message : "terminal stderr failed",
        );
      }
    }
  }

  private async relay(active: ActiveTerminal): Promise<void> {
    const reader = active.child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (this.active.has(active.data.id)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const raw of lines) {
          if (raw.length === 0) continue;
          if (new TextEncoder().encode(raw).byteLength > MAX_CHILD_LINE_BYTES) {
            this.fail(active, 1009, "terminal frame too large");
            return;
          }
          if (!(await this.relayLine(active, raw))) return;
        }
        if (new TextEncoder().encode(buffered).byteLength > MAX_CHILD_LINE_BYTES) {
          this.fail(active, 1009, "terminal frame too large");
          return;
        }
      }
      if (this.active.has(active.data.id)) this.fail(active, 1011, "terminal stream ended");
    } catch (error) {
      if (this.active.has(active.data.id)) {
        this.fail(active, 1011, error instanceof Error ? error.message : "terminal relay failed");
      }
    }
  }

  private async relayLine(active: ActiveTerminal, raw: string): Promise<boolean> {
    const record = parseTerminalRecord(raw);
    if (!record.ok) {
      this.fail(active, 1011, record.error);
      return false;
    }
    const sent = active.socket.send(raw);
    if (sent === 0) {
      this.fail(active, 1013, "terminal relay overloaded");
      return false;
    }
    if (record.value === "frame") this.auditReadyControl(active);
    if (sent === -1) await this.waitForDrain(active);
    if (record.value === "closed" && this.active.has(active.data.id)) {
      active.socket.close(1000, "terminal closed");
      await this.cleanup(active);
      return false;
    }
    return this.active.has(active.data.id);
  }

  private waitForDrain(active: ActiveTerminal): Promise<void> {
    if (active.drainPromise !== null) return active.drainPromise;
    active.drainPromise = new Promise((resolve) => {
      active.drainResolve = resolve;
    });
    return active.drainPromise;
  }

  private childExited(active: ActiveTerminal, code: number): void {
    if (!this.active.has(active.data.id)) return;
    const reason = active.stderr.trim() || `Herdr terminal exited with code ${code}`;
    this.fail(active, 1011, reason.slice(0, 120));
  }

  private childFailed(active: ActiveTerminal, reason: string): void {
    if (this.active.has(active.data.id)) this.fail(active, 1011, reason.slice(0, 120));
  }

  private auditReadyControl(active: ActiveTerminal): void {
    if (active.audited || active.data.mode !== "control") return;
    active.audited = true;
    this.options.audit.record({
      action: "terminal.control",
      paneId: active.data.paneId,
      session: active.data.session,
      device: active.data.device,
      detail: { cols: active.data.cols, rows: active.data.rows },
    });
  }

  private fail(active: ActiveTerminal, code: number, reason: string): void {
    active.socket.close(code, reason);
    void this.cleanup(active);
  }
}
