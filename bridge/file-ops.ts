// Read-only file access scoped to a workspace's working directory — the safe substrate for the
// mobile file tree (plan todo 5). Everything here is governed by three invariants:
//
//   1. A request names a workspace; the workspace's cwd (from the polled snapshot's panes) is the
//      only root. There is no way to name a path outside it.
//   2. Symlinks are NEVER followed — not for directories (walk), not for content (read). A symlink
//      may appear in a listing (type:"symlink", no children, never descended) but resolving one is
//      a 403. Combined with per-component lstat checks this closes both `..` and symlink escape.
//   3. Reads are bounded: the tree caps depth and total entries, content caps at 1 MiB, and binary
//      (non-image) files are refused rather than garbled.
//
// Listing walks the filesystem in-process (readdir with withFileTypes) instead of spawning `find`:
// same result, zero argument-injection surface, no PATH dependence, one less subprocess per poll.

import { lstat as fsLstat, readdir as fsReaddir, readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
import { join } from "node:path";

import type { AgentView, WorkspaceView } from "./types.ts";

// ── Wire shapes ────────────────────────────────────────────────────────────────

export type FileEntry = {
  readonly name: string;
  readonly type: "dir" | "file" | "symlink";
  /** Path relative to the workspace root, using `/` separators. */
  readonly path: string;
  /** File size in bytes. Present for `file` entries only. */
  readonly size?: number;
  /** Children, present for `dir` entries when the depth budget allowed descending. */
  readonly children?: readonly FileEntry[];
};

/** GET /api/files — a bounded subtree of the workspace root (or a `path` within it). */
export type FileTreeResponse = {
  readonly workspaceId: string;
  /** Absolute (realpath'd) root the listing is confined to — informational, for display. */
  readonly root: string;
  /** The requested relative path ("" for the root). */
  readonly path: string;
  readonly depth: number;
  /** True when the entry cap cut the listing short — the client should offer a deeper/narrower fetch. */
  readonly truncated: boolean;
  readonly entries: readonly FileEntry[];
};

/** GET /api/file — one file's content. Text is utf-8; images are base64 in their image/* mime. */
export type FileContentResponse = {
  readonly workspaceId: string;
  readonly path: string;
  readonly kind: "text" | "image";
  readonly mime: string;
  readonly encoding: "utf-8" | "base64";
  readonly size: number;
  readonly content: string;
};

export type FileRouteResult =
  | { readonly ok: true; readonly data: FileTreeResponse | FileContentResponse }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 413 | 415 | 502; readonly error: string };

// ── Injectable filesystem seam ─────────────────────────────────────────────────

export type DirentLike = {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

export type FileOpsFs = {
  readdir(dir: string): Promise<readonly DirentLike[]>;
  lstat(path: string): Promise<DirentLike & { size: number }>;
  readFile(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
};

export const nodeFs: FileOpsFs = {
  readdir: (dir) => fsReaddir(dir, { withFileTypes: true }),
  lstat: async (path) => {
    const st = await fsLstat(path);
    return {
      name: path.split("/").pop() ?? "",
      isDirectory: () => st.isDirectory(),
      isFile: () => st.isFile(),
      isSymbolicLink: () => st.isSymbolicLink(),
      size: st.size,
    };
  },
  readFile: (path) => fsReadFile(path),
  realpath: (path) => fsRealpath(path),
};

// ── Limits ─────────────────────────────────────────────────────────────────────

export const MAX_FILE_TREE_DEPTH = 16;
export const DEFAULT_FILE_TREE_DEPTH = 2;
/** Total entries across the whole response — a node_modules-sized directory cannot flood a phone. */
export const MAX_FILE_TREE_ENTRIES = 2_000;
export const MAX_FILE_CONTENT_BYTES = 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

// ── Workspace → cwd resolution ─────────────────────────────────────────────────

/**
 * The cwd a file listing is rooted at: the workspace's first pane's cwd (agents first, then bare
 * shells, in snapshot order). Panes are where herdr reports a directory at all — `workspace.list`
 * carries none — and every pane in a workspace starts in the workspace cwd. Returns null when the
 * workspace is unknown to the snapshot or has no pane to inherit a cwd from.
 */
export function workspaceCwd(
  workspaceId: string,
  snapshot: {
    readonly workspaces: readonly WorkspaceView[];
    readonly agents: readonly AgentView[];
    readonly shellPanes: readonly AgentView[];
  },
): string | null {
  const known = snapshot.workspaces.some((workspace) => workspace.workspaceId === workspaceId);
  if (!known) return null;
  const panes = [...snapshot.agents, ...snapshot.shellPanes];
  return panes.find((pane) => pane.workspaceId === workspaceId)?.cwd ?? null;
}

// ── Parameter parsing ──────────────────────────────────────────────────────────

type RelPath =
  | { readonly ok: true; readonly rel: string }
  | { readonly ok: false; readonly status: 400 | 403; readonly error: string };

/** Parse the `path` query param into a `/`-separated relative path. `..`, absolute forms and NULs are rejected outright. */
export function parseRelativePath(raw: string | null): RelPath {
  if (raw === null || raw === "" || raw === ".") return { ok: true, rel: "" };
  if (raw.includes("\0")) return { ok: false, status: 400, error: "bad path" };
  if (raw.startsWith("/") || raw.startsWith("\\")) {
    return { ok: false, status: 403, error: "path must be relative to the workspace" };
  }
  const segments = raw.split(/[\\/]/).filter((s) => s.length > 0 && s !== ".");
  if (segments.includes("..")) {
    return { ok: false, status: 403, error: "path traversal is not allowed" };
  }
  return { ok: true, rel: segments.join("/") };
}

type Depth = { readonly ok: true; readonly depth: number } | { readonly ok: false; readonly error: string };

export function parseDepth(raw: string | null): Depth {
  if (raw === null) return { ok: true, depth: DEFAULT_FILE_TREE_DEPTH };
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > MAX_FILE_TREE_DEPTH) {
    return { ok: false, error: `depth must be an integer from 1 to ${MAX_FILE_TREE_DEPTH}` };
  }
  return { ok: true, depth: Number(raw) };
}

// ── Path containment ───────────────────────────────────────────────────────────

type Containment =
  | { readonly ok: true; readonly abs: string }
  | { readonly ok: false; readonly status: 403 | 404; readonly error: string };

/**
 * Walk the requested relative path segment-by-segment from the (already realpath'd) root, lstat'ing
 * every component. This is the escape check: `..` never reaches here (rejected at parse), and a
 * symlinked component — directory or leaf — refuses the whole request instead of being followed.
 */
async function resolveInside(root: string, rel: string, fs: FileOpsFs): Promise<Containment> {
  let current = root;
  for (const segment of rel === "" ? [] : rel.split("/")) {
    const next = join(current, segment);
    let st: DirentLike;
    try {
      st = await fs.lstat(next);
    } catch {
      return { ok: false, status: 404, error: "path not found" };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, status: 403, error: "symlink paths are not followed" };
    }
    current = next;
  }
  // Belt-and-braces: the parser already rejects `..`, so this never trips today — but if a parse
  // slip ever let one through, `join` would normalize it out of the root and this converts the
  // would-be escape into a refusal instead of a leak.
  if (current !== root && !current.startsWith(`${root}/`)) {
    return { ok: false, status: 403, error: "path escapes the workspace" };
  }
  return { ok: true, abs: current };
}

// ── Tree walker ────────────────────────────────────────────────────────────────

type WalkBudget = { count: number };

type WalkResult = { readonly entries: FileEntry[]; readonly truncated: boolean };

function direntSort(a: DirentLike, b: DirentLike): number {
  const dirDelta = Number(b.isDirectory()) - Number(a.isDirectory());
  return dirDelta !== 0 ? dirDelta : a.name.localeCompare(b.name);
}

async function walkDir(
  fs: FileOpsFs,
  absDir: string,
  rel: string,
  depthLeft: number,
  budget: WalkBudget,
): Promise<WalkResult> {
  let dirents: readonly DirentLike[];
  try {
    dirents = await fs.readdir(absDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "EACCES") return { entries: [], truncated: false };
    throw error;
  }
  const entries: FileEntry[] = [];
  let truncated = false;
  for (const dirent of [...dirents].sort(direntSort)) {
    if (budget.count >= MAX_FILE_TREE_ENTRIES) {
      truncated = true;
      break;
    }
    budget.count += 1;
    const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
    if (dirent.isSymbolicLink()) {
      entries.push({ name: dirent.name, type: "symlink", path: childRel });
      continue;
    }
    if (dirent.isDirectory()) {
      const entry: FileEntry = { name: dirent.name, type: "dir", path: childRel };
      if (depthLeft > 1) {
        const nested = await walkDir(fs, join(absDir, dirent.name), childRel, depthLeft - 1, budget);
        entries.push({ ...entry, children: nested.entries });
        truncated = truncated || nested.truncated;
      } else {
        entries.push(entry);
      }
      continue;
    }
    let size: number | undefined;
    try {
      size = (await fs.lstat(join(absDir, dirent.name))).size;
    } catch {
      size = undefined;
    }
    entries.push({ name: dirent.name, type: "file", path: childRel, ...(size !== undefined ? { size } : {}) });
  }
  return { entries, truncated };
}

function isNodeError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

// ── Content reading ────────────────────────────────────────────────────────────

function isBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, 8_192);
  for (const byte of probe) if (byte === 0) return true;
  return false;
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export type FileOpsContext = {
  readonly workspaceId: string;
  /** The workspace cwd (already resolved by the caller from the snapshot). */
  readonly cwd: string;
  readonly fs?: FileOpsFs;
};

export type FileRouteRequest =
  | { readonly kind: "tree"; readonly url: URL }
  | { readonly kind: "content"; readonly url: URL };

/** GET /api/files → bounded tree; GET /api/file → one file's content. Both read-only, cwd-confined. */
export async function handleFileRoute(
  request: FileRouteRequest,
  context: FileOpsContext,
): Promise<FileRouteResult> {
  const fs = context.fs ?? nodeFs;
  let root: string;
  try {
    root = await fs.realpath(context.cwd);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { ok: false, status: 404, error: "workspace cwd not found on disk" };
    }
    return { ok: false, status: 502, error: "workspace cwd is not readable" };
  }

  const parsedPath = parseRelativePath(request.url.searchParams.get("path"));
  if (!parsedPath.ok) return parsedPath;
  const inside = await resolveInside(root, parsedPath.rel, fs);
  if (!inside.ok) return inside;

  if (request.kind === "tree") {
    const depth = parseDepth(request.url.searchParams.get("depth"));
    if (!depth.ok) return { ok: false, status: 400, error: depth.error };
    try {
      const walked = await walkDir(fs, inside.abs, parsedPath.rel, depth.depth, { count: 0 });
      const tree: FileTreeResponse = {
        workspaceId: context.workspaceId,
        root,
        path: parsedPath.rel,
        depth: depth.depth,
        truncated: walked.truncated,
        entries: walked.entries,
      };
      return { ok: true, data: tree };
    } catch (error) {
      if (isNodeError(error) && error.code === "EACCES") {
        return { ok: false, status: 403, error: "directory is not readable" };
      }
      return { ok: false, status: 502, error: "file listing failed" };
    }
  }

  let st: DirentLike & { size: number };
  try {
    st = await fs.lstat(inside.abs);
  } catch {
    return { ok: false, status: 404, error: "path not found" };
  }
  if (st.isDirectory()) return { ok: false, status: 400, error: "path is a directory" };
  if (st.size > MAX_FILE_CONTENT_BYTES) {
    return { ok: false, status: 413, error: "file exceeds the 1 MiB preview limit" };
  }
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(inside.abs);
  } catch (error) {
    if (isNodeError(error) && error.code === "EACCES") {
      return { ok: false, status: 403, error: "file is not readable" };
    }
    return { ok: false, status: 502, error: "file read failed" };
  }
  if (bytes.byteLength > MAX_FILE_CONTENT_BYTES) {
    return { ok: false, status: 413, error: "file exceeds the 1 MiB preview limit" };
  }
  const name = parsedPath.rel.split("/").pop() ?? "";
  const mime = IMAGE_MIME[name.split(".").pop()?.toLowerCase() ?? ""];
  if (mime !== undefined) {
    return {
      ok: true,
      data: {
        workspaceId: context.workspaceId,
        path: parsedPath.rel,
        kind: "image",
        mime,
        encoding: "base64",
        size: bytes.byteLength,
        content: Buffer.from(bytes).toString("base64"),
      },
    };
  }
  if (isBinary(bytes)) {
    return { ok: false, status: 415, error: "binary file is not previewable" };
  }
  return {
    ok: true,
    data: {
      workspaceId: context.workspaceId,
      path: parsedPath.rel,
      kind: "text",
      mime: "text/plain",
      encoding: "utf-8",
      size: bytes.byteLength,
      content: new TextDecoder().decode(bytes),
    },
  };
}
