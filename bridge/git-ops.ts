// Git operations scoped to a workspace's working directory — the safe substrate for the mobile
// source-control view (plan todo 6). Three invariants:
//
//   1. Allowlist, twice. The route layer only ever issues the five read/write shapes below, and the
//      runner itself refuses any subcommand outside {status, diff, add, reset, commit} before it
//      spawns — so a bug elsewhere fails closed rather than executing `git push`. log/branch stay
//      501 scaffolds (planned, not built).
//   2. No shell, ever. Every invocation is Bun.spawn with a fixed argv array; user input (file
//      paths, commit message) lands in arguments, never in a command string.
//   3. Paths are workspace-relative and inert: `..`, absolute forms, NULs and git pathspec magic
//      (leading `:`) are refused, and `--` separates options from pathspecs so a leading-dash file
//      can never be read back as a flag.

import { parseRelativePath } from "./file-ops.ts";/** Subcommands the runner will ever execute. Anything else is refused before spawn. */
export const GIT_ALLOWLIST = ["status", "diff", "add", "reset", "commit"] as const;
export type GitSubcommand = (typeof GIT_ALLOWLIST)[number];

// ── Wire shapes ────────────────────────────────────────────────────────────────

export type GitChange = {
  readonly path: string;
  /** Porcelain status letter: M / A / D / R / C / U / ? (one entry per staged+unstaged pair). */
  readonly status: string;
  readonly staged: boolean;
};

/** GET /api/git/status — branch/upstream summary plus the working-tree change list. */
export type GitStatusResult = {
  readonly workspaceId: string;
  readonly branch: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly detached: boolean;
  readonly truncated: boolean;
  readonly changed: readonly GitChange[];
};

/** GET /api/git/diff — one file's (or the whole workspace's) unified diff text. */
export type GitDiffResult = {
  readonly workspaceId: string;
  readonly file: string;
  readonly staged: boolean;
  readonly truncated: boolean;
  readonly diff: string;
};

/** POST /api/git/stage | /api/git/unstage — the file list the operation applied to. */
export type GitFilesResult = {
  readonly workspaceId: string;
  readonly files: readonly string[];
};

/** POST /api/git/commit — git's own summary output, for display. */
export type GitCommitResult = {
  readonly workspaceId: string;
  readonly message: string;
  readonly output: string;
};

export type GitRouteResult =
  | {
      readonly ok: true;
      readonly data: GitStatusResult | GitDiffResult | GitFilesResult | GitCommitResult;
    }
  | { readonly ok: false; readonly status: 400 | 403 | 500; readonly error: string };

// ── Injectable runner ──────────────────────────────────────────────────────────

export type GitRunResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type GitRunner = (
  cwd: string,
  argv: readonly string[],
) => Promise<GitRunResult>;

/** The single place git is ever spawned: argv array (no shell), cwd-pinned, allowlist-checked. */
export function makeNodeGitRunner(spawn: typeof Bun.spawn): GitRunner {
  return async (cwd, argv) => {
    const subcommand = argv[0];
    if (subcommand === undefined || !GIT_ALLOWLIST.includes(subcommand as GitSubcommand)) {
      throw new Error(`git subcommand not allowed: ${String(subcommand)}`);
    }
    const proc = spawn(["git", ...argv], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };
}

// ── Shared failure helper ──────────────────────────────────────────────────────

function gitFailure(result: GitRunResult): GitRouteResult {
  const detail = (result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.code}`)
    .split("\n")
    .slice(0, 4)
    .join(" ")
    .slice(0, 400);
  return { ok: false, status: 500, error: detail };
}

// ── Parameter validation ───────────────────────────────────────────────────────

/**
 * A git pathspec for add/reset/diff: workspace-relative, inert. `parseRelativePath` already refuses
 * `..`, absolute forms and NULs; the extra rule here is git's own pathspec magic (`:(top)…` would
 * resolve against the repository top, escaping the workspace scope).
 */
export function parseGitPath(raw: string): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly status: 400 | 403; readonly error: string } {
  if (raw.length === 0) return { ok: false, status: 400, error: "empty file path" };
  if (raw.startsWith(":")) return { ok: false, status: 403, error: "git pathspec magic is not allowed" };
  const parsed = parseRelativePath(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, path: parsed.rel };
}

// ── Operations ─────────────────────────────────────────────────────────────────

export const MAX_GIT_CHANGES = 2_000;
export const MAX_GIT_DIFF_BYTES = 1024 * 1024;

export async function gitStatus(
  workspaceId: string,
  cwd: string,
  run: GitRunner,
): Promise<GitRouteResult> {
  const result = await run(cwd, ["status", "--porcelain=v1", "-b", "-z"]);
  if (result.code !== 0) return gitFailure(result);
  return { ok: true, data: parseStatus(workspaceId, result.stdout) };
}

export function parseStatus(workspaceId: string, raw: string): GitStatusResult {
  // porcelain v1 -z: a `## <header>` field first, then `XY <path>` fields (renames append the
  // original path as a second NUL-terminated field).
  const fields = raw.split("\0");
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const changed: GitChange[] = [];
  let truncated = false;

  let index = 0;
  if (fields[0]?.startsWith("## ")) {
    const header = fields[0].slice(3);
    index = 1;
    const dot = header.indexOf("...");
    const bracket = header.indexOf("[");
    const head = (bracket === -1 ? header : header.slice(0, bracket)).trim();
    if (head === "HEAD (no branch)" || head.startsWith("HEAD (no branch)")) {
      detached = true;
      branch = null;
    } else if (head.startsWith("No commits yet on ")) {
      branch = head.slice("No commits yet on ".length);
    } else if (dot === -1) {
      branch = head;
    } else {
      branch = header.slice(0, dot);
      const rest = header.slice(dot + 3);
      const bracket = rest.indexOf("[");
      const upstreamPart = (bracket === -1 ? rest : rest.slice(0, bracket)).trim();
      if (upstreamPart.length > 0) upstream = upstreamPart;
      const summary = bracket === -1 ? "" : rest.slice(bracket);
      const aheadMatch = summary.match(/ahead (\d+)/);
      const behindMatch = summary.match(/behind (\d+)/);
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      behind = behindMatch ? Number(behindMatch[1]) : 0;
    }
  }

  for (; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field === "") continue;
    if (field.length < 4) continue;
    const x = field[0]!;
    const y = field[1]!;
    const path = field.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      // In -z form a rename/copy entry is followed by the original path as its own field.
      index += 1;
    }
    if (x === "?" && y === "?") {
      changed.push({ path, status: "?", staged: false });
      continue;
    }
    if (x !== "." && x !== "?" && x !== "!" && x !== " ") {
      changed.push({ path, status: x, staged: true });
    }
    if (y !== "." && y !== "?" && y !== "!" && y !== " ") {
      changed.push({ path, status: y, staged: false });
    }
    if (changed.length >= MAX_GIT_CHANGES) {
      truncated = true;
      break;
    }
  }
  return { workspaceId, branch, upstream, ahead, behind, detached, truncated, changed };
}

export async function gitDiff(
  workspaceId: string,
  cwd: string,
  run: GitRunner,
  file: string,
  staged: boolean,
): Promise<GitRouteResult> {
  const argv = ["diff", "--no-color", ...(staged ? ["--staged"] : []), "--"];
  if (file !== "") argv.push(file);
  const result = await run(cwd, argv);
  if (result.code !== 0) return gitFailure(result);
  const truncated = result.stdout.length > MAX_GIT_DIFF_BYTES;
  const diff = truncated ? `${result.stdout.slice(0, MAX_GIT_DIFF_BYTES)}\n… (truncated)` : result.stdout;
  return { ok: true, data: { workspaceId, file, staged, truncated, diff } };
}

export async function gitStage(
  workspaceId: string,
  cwd: string,
  run: GitRunner,
  files: readonly string[],
): Promise<GitRouteResult> {
  const result = await run(cwd, ["add", "--", ...files]);
  if (result.code !== 0) return gitFailure(result);
  return { ok: true, data: { workspaceId, files } };
}

export async function gitUnstage(
  workspaceId: string,
  cwd: string,
  run: GitRunner,
  files: readonly string[],
): Promise<GitRouteResult> {
  // Plain `git reset HEAD -- <paths>` touches the index only; `--hard` never appears here and the
  // runner's allowlist means no other reset form can be reached through this bridge.
  const result = await run(cwd, ["reset", "HEAD", "--", ...files]);
  if (result.code !== 0) return gitFailure(result);
  return { ok: true, data: { workspaceId, files } };
}

export async function gitCommit(
  workspaceId: string,
  cwd: string,
  run: GitRunner,
  message: string,
): Promise<GitRouteResult> {
  const result = await run(cwd, ["commit", "-m", message]);
  if (result.code !== 0) return gitFailure(result);
  return { ok: true, data: { workspaceId, message, output: result.stdout.trim() } };
}
