export interface TerminalChildStdin {
  write(data: string): number | Promise<number>;
  end(): void;
}

export interface TerminalChild {
  readonly stdin: TerminalChildStdin;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export type TerminalSpawner = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) => TerminalChild;

export const spawnTerminal: TerminalSpawner = (argv, env) =>
  Bun.spawn([...argv], {
    env: { ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

export async function terminateTerminalChild(child: TerminalChild): Promise<void> {
  try {
    child.stdin.end();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  try {
    child.kill("SIGTERM");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  const exited = child.exited.then(
    () => true,
    () => true,
  );
  if (await Promise.race([exited, Bun.sleep(1000).then(() => false)])) return;
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  await Promise.race([child.exited.catch(() => undefined), Bun.sleep(1000)]);
}
