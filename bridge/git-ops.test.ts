import { describe, expect, test } from "bun:test";

import {
  gitCommit,
  gitDiff,
  GIT_ALLOWLIST,
  gitStage,
  gitStatus,
  gitUnstage,
  makeNodeGitRunner,
  MAX_GIT_DIFF_BYTES,
  parseGitPath,
  parseStatus,
  type GitRunResult,
  type GitRunner,
} from "./git-ops.ts";

// ── Fake runner ────────────────────────────────────────────────────────────────

function stream(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream() as ReadableStream<Uint8Array>;
}

/** Runner that records every invocation and replays scripted stdout per subcommand. */
function fakeRunner(script: Partial<Record<string, string | { code: number; stdout?: string; stderr?: string }>> = {}) {
  const calls: Array<{ cwd: string; argv: readonly string[] }> = [];
  const run: GitRunner = async (cwd, argv) => {
    calls.push({ cwd, argv });
    const entry = script[argv[0]!];
    if (entry === undefined) return { code: 0, stdout: "", stderr: "" };
    const normalized = typeof entry === "string" ? { code: 0, stdout: entry } : entry;
    return { code: normalized.code, stdout: normalized.stdout ?? "", stderr: normalized.stderr ?? "" };
  };
  return { run, calls };
}

// ── Allowlist ──────────────────────────────────────────────────────────────────

describe("git allowlist", () => {
  test("exposes exactly the five runnable subcommands", () => {
    expect([...GIT_ALLOWLIST]).toEqual(["status", "diff", "add", "reset", "commit"]);
  });

  test("the runner refuses a non-allowlisted subcommand before spawning", async () => {
    let spawned = 0;
    const spawn = ((..._args: unknown[]) => {
      spawned += 1;
      throw new Error("must not spawn");
    }) as unknown as typeof Bun.spawn;
    const runner = makeNodeGitRunner(spawn);
    for (const argv of [["push", "origin", "main"], ["rm", "-rf", "."], ["clean", "-fd"], ["checkout", "--", "."]]) {
      expect(runner("/repo", argv)).rejects.toThrow("git subcommand not allowed");
    }
    expect(spawned).toBe(0);
    // `reset --hard` is excluded differently: the subcommand itself is allowed (unstage uses a
    // plain index reset), so the only reset shape that exists is gitUnstage's fixed argv,
    // ["reset", "HEAD", "--", <paths>] — asserted in the operations tests below.
  });

  test("the runner spawns an argv array (no shell) and reads both pipes", async () => {
    const holder: { seen: { cmd: string[]; cwd?: string; shell?: unknown } | null } = { seen: null };
    const spawn = ((cmd: string[], opts: { cwd?: string }) => {
      holder.seen = { cmd, cwd: opts.cwd, shell: (opts as { shell?: unknown }).shell };
      return {
        stdout: stream("on main\n"),
        stderr: stream(""),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;
    const out = await makeNodeGitRunner(spawn)("/repo", ["status", "--porcelain=v1", "-b", "-z"]);
    expect(out).toEqual({ code: 0, stdout: "on main\n", stderr: "" });
    expect(holder.seen?.cmd[0]).toBe("git");
    expect(holder.seen?.cmd.slice(1)).toEqual(["status", "--porcelain=v1", "-b", "-z"]);
    expect(holder.seen?.cwd).toBe("/repo");
    expect(holder.seen?.shell).toBeUndefined();
  });

  test("a nonzero git exit surfaces as a 500 with the bounded stderr", async () => {
    const { run } = fakeRunner({
      commit: { code: 128, stderr: "fatal: not a git repository\n" },
    });
    const result = await gitCommit("w1", "/repo", run, "msg");
    expect(result).toEqual({ ok: false, status: 500, error: "fatal: not a git repository" });
  });
});

// ── Status parsing ─────────────────────────────────────────────────────────────

describe("parseStatus", () => {
  test("parses branch, upstream, and ahead/behind", () => {
    const s = parseStatus("w1", "## main...origin/main [ahead 1, behind 2]\0");
    expect(s).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 1, behind: 2, detached: false });
  });

  test("parses a branch without upstream and a detached head", () => {
    expect(parseStatus("w1", "## main\0")).toMatchObject({ branch: "main", upstream: null, detached: false });
    expect(parseStatus("w1", "## HEAD (no branch)\0")).toMatchObject({ branch: null, detached: true });
  });

  test("parses a fresh repository header", () => {
    expect(parseStatus("w1", "## No commits yet on main\0")).toMatchObject({ branch: "main", upstream: null });
  });

  test("splits a worktree-modified, a staged, and an untracked entry", () => {
    const s = parseStatus("w1", "## main\0 M a.txt\0M  b.txt\0?? c.txt\0");
    expect(s.changed).toEqual([
      { path: "a.txt", status: "M", staged: false },
      { path: "b.txt", status: "M", staged: true },
      { path: "c.txt", status: "?", staged: false },
    ]);
  });

  test("a both-modified file yields one staged and one unstaged entry", () => {
    const s = parseStatus("w1", "## main\0MM d.txt\0");
    expect(s.changed).toEqual([
      { path: "d.txt", status: "M", staged: true },
      { path: "d.txt", status: "M", staged: false },
    ]);
  });

  test("a rename consumes its second NUL field and keeps the new path", () => {
    const s = parseStatus("w1", "## main\0R  new-name.txt\0old-name.txt\0 M e.txt\0");
    expect(s.changed).toEqual([
      { path: "new-name.txt", status: "R", staged: true },
      { path: "e.txt", status: "M", staged: false },
    ]);
  });
});

// ── Operations and argv shapes ─────────────────────────────────────────────────

describe("git operations", () => {
  test("status runs the -z porcelain and passes the cwd through", async () => {
    const { run, calls } = fakeRunner({ status: "## main\0?? x\0" });
    const result = await gitStatus("w1", "/repo", run);
    expect(calls[0]).toEqual({ cwd: "/repo", argv: ["status", "--porcelain=v1", "-b", "-z"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ branch: "main", changed: [{ path: "x", status: "?" }] });
  });

  test.each([
    { staged: false, file: "a.txt", expected: ["diff", "--no-color", "--", "a.txt"] },
    { staged: true, file: "a.txt", expected: ["diff", "--no-color", "--staged", "--", "a.txt"] },
    { staged: false, file: "", expected: ["diff", "--no-color", "--"] },
  ] as const)("diff argv for staged=$staged file=$file", async ({ staged, file, expected }) => {
    const { run, calls } = fakeRunner({ diff: "diff --git a/a.txt b/a.txt\n" });
    const result = await gitDiff("w1", "/repo", run, file, staged);
    expect(calls[0]?.argv).toEqual(expected);
    expect(result.ok).toBe(true);
  });

  test("diff output over the cap is truncated with a marker", async () => {
    const { run } = fakeRunner({ diff: "x".repeat(MAX_GIT_DIFF_BYTES + 10) });
    const result = await gitDiff("w1", "/repo", run, "", false);
    if (!result.ok || !("diff" in result.data)) throw new Error("expected diff result");
    expect(result.data.truncated).toBe(true);
    expect(result.data.diff.endsWith("… (truncated)")).toBe(true);
  });

  test("stage and unstage pin files after -- with their fixed shapes", async () => {
    const staged = fakeRunner({});
    await gitStage("w1", "/repo", staged.run, ["a.txt", "src/b.txt"]);
    expect(staged.calls[0]?.argv).toEqual(["add", "--", "a.txt", "src/b.txt"]);
    const unstaged = fakeRunner({});
    await gitUnstage("w1", "/repo", unstaged.run, ["a.txt"]);
    expect(unstaged.calls[0]?.argv).toEqual(["reset", "HEAD", "--", "a.txt"]);
  });

  test("commit passes the message as a single argument", async () => {
    const { run, calls } = fakeRunner({ commit: "[main abc] msg\n" });
    const result = await gitCommit("w1", "/repo", run, "add feature");
    expect(calls[0]?.argv).toEqual(["commit", "-m", "add feature"]);
    if (!result.ok || !("output" in result.data)) throw new Error("expected commit result");
    expect(result.data.output).toBe("[main abc] msg");
  });
});

// ── Path validation ────────────────────────────────────────────────────────────

describe("parseGitPath", () => {
  test("accepts plain relative paths", () => {
    expect(parseGitPath("src/a.ts")).toEqual({ ok: true, path: "src/a.ts" });
  });
  test.each(["..", "a/../b", "/etc/passwd", ":!(top)escape", ":", ""])("rejects %s", (raw) => {
    expect(parseGitPath(raw).ok).toBe(false);
  });
});

// ── GitRunResult shape sanity ──────────────────────────────────────────────────

test("GitRunResult carries code/stdout/stderr", () => {
  const r: GitRunResult = { code: 0, stdout: "", stderr: "" };
  expect(r.code).toBe(0);
});
