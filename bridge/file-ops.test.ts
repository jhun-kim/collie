import { describe, expect, test } from "bun:test";

import {
  handleFileRoute,
  MAX_FILE_CONTENT_BYTES,
  MAX_FILE_TREE_ENTRIES,
  type DirentLike,
  type FileOpsFs,
  parseDepth,
  parseRelativePath,
  workspaceCwd,
} from "./file-ops.ts";
import type { AgentView, WorkspaceView } from "./types.ts";

// ── In-memory filesystem ───────────────────────────────────────────────────────

type MemNode =
  | { type: "dir"; children: Map<string, MemNode> }
  | { type: "file"; content: Uint8Array }
  | { type: "symlink"; target: string };

const dir = (children: Record<string, MemNode> = {}): MemNode => ({
  type: "dir",
  children: new Map(Object.entries(children)),
});
const file = (content: string | Uint8Array): MemNode => ({
  type: "file",
  content: typeof content === "string" ? new TextEncoder().encode(content) : content,
});
const symlink = (target: string): MemNode => ({ type: "symlink", target });

/**
 * Minimal FileOpsFs over an in-memory tree. `lookup` resolves every path component against the
 * node graph; `realpath` is identity (roots in tests are already canonical). Symlinks are stored
 * as nodes and deliberately never resolved — the production code must refuse them before it would
 * ever need their target.
 */
function memFs(root: string, rootNode: MemNode): FileOpsFs {
  function lookup(path: string): MemNode | null {
    const rel = path === root ? "" : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
    if (rel === null) return null;
    let node: MemNode = rootNode;
    if (rel !== "") {
      for (const part of rel.split("/")) {
        if (node.type !== "dir") return null;
        const next = node.children.get(part);
        if (next === undefined) return null;
        node = next;
      }
    }
    return node;
  }
  const dirent = (name: string, node: MemNode): DirentLike => ({
    name,
    isDirectory: () => node.type === "dir",
    isFile: () => node.type === "file",
    isSymbolicLink: () => node.type === "symlink",
  });
  return {
    async readdir(dirPath) {
      const node = lookup(dirPath);
      if (node?.type !== "dir") throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      return [...node.children.entries()].map(([name, child]) => dirent(name, child));
    },
    async lstat(path) {
      const node = lookup(path);
      if (node === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const base = dirent(path.split("/").pop() ?? "", node);
      return {
        ...base,
        size: node.type === "file" ? node.content.byteLength : 0,
      };
    },
    async readFile(path) {
      const node = lookup(path);
      if (node?.type !== "file") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return node.content;
    },
    async realpath(path) {
      return path;
    },
  };
}

const OVER_ONE_MIB = MAX_FILE_CONTENT_BYTES + 1;

const TREE = dir({
  "README.md": file("hello collie"),
  ".hidden": file("dot"),
  src: dir({
    "index.ts": file("export {};"),
    deep: dir({ "nested.txt": file("nested") }),
  }),
  "logo.png": file(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
  "blob.bin": file(new Uint8Array([0x00, 0x01, 0x02, 0x00])),
  "big.txt": file("a".repeat(OVER_ONE_MIB)),
  "link-out": symlink("/outside/secret.txt"),
  "link-dir": symlink("/outside"),
});

function ctx(path = "", url: URL, fs: FileOpsFs = memFs("/ws", TREE)) {
  return handleFileRoute(
    { kind: path === "content" ? "content" : "tree", url },
    { workspaceId: "w1", cwd: "/ws", fs },
  );
}

const treeUrl = (query: string) => new URL(`http://bridge.local/api/files?${query}`);
const fileUrl = (query: string) => new URL(`http://bridge.local/api/file?${query}`);

// ── Parameter parsing ──────────────────────────────────────────────────────────

describe("parseRelativePath", () => {
  test("accepts empty, dot, and normal relative paths", () => {
    expect(parseRelativePath(null)).toEqual({ ok: true, rel: "" });
    expect(parseRelativePath("")).toEqual({ ok: true, rel: "" });
    expect(parseRelativePath(".")).toEqual({ ok: true, rel: "" });
    expect(parseRelativePath("src/deep")).toEqual({ ok: true, rel: "src/deep" });
    expect(parseRelativePath("src/./deep")).toEqual({ ok: true, rel: "src/deep" });
    expect(parseRelativePath("src//deep")).toEqual({ ok: true, rel: "src/deep" });
  });

  test.each(["../../etc", "src/../../etc", "..", "a/..", "a\\..\\b"])(
    "rejects traversal %s with 403 semantics",
    (raw) => {
      expect(parseRelativePath(raw)).toEqual({
        ok: false,
        status: 403,
        error: "path traversal is not allowed",
      });
    },
  );

  test.each(["/etc/passwd", "\\Windows"])("rejects absolute path %s", (raw) => {
    expect(parseRelativePath(raw)).toEqual({
      ok: false,
      status: 403,
      error: "path must be relative to the workspace",
    });
  });

  test("rejects NUL bytes", () => {
    expect(parseRelativePath("a\0b")).toEqual({ ok: false, status: 400, error: "bad path" });
  });
});

describe("parseDepth", () => {
  test("defaults to 2", () => {
    expect(parseDepth(null)).toEqual({ ok: true, depth: 2 });
  });
  test.each([
    ["1", 1],
    ["16", 16],
  ])("accepts %s", (raw, depth) => {
    expect(parseDepth(raw)).toEqual({ ok: true, depth });
  });
  test.each(["0", "17", "abc", "-1", "1.5", ""])("rejects %s", (raw) => {
    expect(parseDepth(raw).ok).toBe(false);
  });
});

// ── Tree listing ───────────────────────────────────────────────────────────────

describe("handleFileRoute — tree", () => {
  test("lists the workspace root with default depth, dirs first and sizes on files", async () => {
    const result = await ctx("", treeUrl("workspaceId=w1"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data;
    if (!("entries" in data)) throw new Error("expected a tree response");
    expect(data.root).toBe("/ws");
    expect(data.path).toBe("");
    expect(data.depth).toBe(2);
    const byPath = new Map(data.entries.map((e) => [e.path, e]));
    expect(byPath.get("src")?.type).toBe("dir");
    expect(byPath.get("README.md")).toMatchObject({ type: "file", size: 12 });
    expect(byPath.get(".hidden")?.type).toBe("file");
    // Dirs sort before files.
    expect(data.entries[0]?.type).toBe("dir");
    // Symlinks are listed but never descended.
    expect(byPath.get("link-out")).toEqual({ name: "link-out", type: "symlink", path: "link-out" });
    // Depth 2 expanded one level under src.
    expect(byPath.get("src")?.children?.map((e) => e.path)).toEqual(["src/deep", "src/index.ts"]);
  });

  test("depth=1 returns unexpanded directories", async () => {
    const result = await ctx("", treeUrl("workspaceId=w1&depth=1"));
    if (!result.ok || !("entries" in result.data)) throw new Error("expected tree");
    const src = result.data.entries.find((e) => e.path === "src");
    expect(src?.type).toBe("dir");
    expect(src?.children).toBeUndefined();
  });

  test("path= focuses the listing on a subdirectory", async () => {
    const result = await ctx("", treeUrl("workspaceId=w1&path=src/deep&depth=1"));
    if (!result.ok || !("entries" in result.data)) throw new Error("expected tree");
    expect(result.data.path).toBe("src/deep");
    expect(result.data.entries.map((e) => e.name)).toEqual(["nested.txt"]);
  });

  test.each([
    ["path=../../etc", 403],
    ["path=src/../../etc", 403],
    ["path=/etc/passwd", 403],
    ["path=link-dir", 403],
    ["path=link-dir/nested.txt", 403],
    ["path=missing-dir", 404],
    ["depth=0", 400],
    ["depth=17", 400],
    ["depth=abc", 400],
  ] as const)("%s → %i", async (query, status) => {
    const result = await ctx("", treeUrl(`workspaceId=w1&${query}`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(status);
  });
});

// ── Content reading ────────────────────────────────────────────────────────────

describe("handleFileRoute — content", () => {
  test("reads a text file as utf-8", async () => {
    const result = await ctx("content", fileUrl("workspaceId=w1&path=README.md"));
    expect(result.ok).toBe(true);
    if (!result.ok || !("content" in result.data)) return;
    expect(result.data).toMatchObject({
      workspaceId: "w1",
      path: "README.md",
      kind: "text",
      mime: "text/plain",
      encoding: "utf-8",
      size: 12,
      content: "hello collie",
    });
  });

  test("reads an image file as base64 with its image mime", async () => {
    const result = await ctx("content", fileUrl("workspaceId=w1&path=logo.png"));
    expect(result.ok).toBe(true);
    if (!result.ok || !("content" in result.data)) return;
    expect(result.data.kind).toBe("image");
    expect(result.data.mime).toBe("image/png");
    expect(result.data.encoding).toBe("base64");
    expect(result.data.content).toBe(
      Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).toString("base64"),
    );
  });

  test("refuses a binary (NUL-bearing) non-image file with 415", async () => {
    const result = await ctx("content", fileUrl("workspaceId=w1&path=blob.bin"));
    expect(result).toEqual({ ok: false, status: 415, error: "binary file is not previewable" });
  });

  test("refuses an oversized file with 413", async () => {
    const result = await ctx("content", fileUrl("workspaceId=w1&path=big.txt"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(413);
  });

  test("refuses to read through a symlink with 403", async () => {
    const result = await ctx("content", fileUrl("workspaceId=w1&path=link-out"));
    expect(result).toEqual({ ok: false, status: 403, error: "symlink paths are not followed" });
  });

  test.each([
    ["path=missing.txt", 404],
    ["path=src", 400],
  ] as const)("%s → %i", async (query, status) => {
    const result = await ctx("content", fileUrl(`workspaceId=w1&${query}`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(status);
  });
});

// ── Entry cap ──────────────────────────────────────────────────────────────────

describe("handleFileRoute — entry cap", () => {
  test("stops at MAX_FILE_TREE_ENTRIES and reports truncated", async () => {
    const children: Record<string, MemNode> = {};
    for (let i = 0; i < MAX_FILE_TREE_ENTRIES + 50; i += 1) {
      children[`f${String(i).padStart(5, "0")}.txt`] = file("x");
    }
    const fs = memFs("/ws", dir(children));
    const result = await ctx("", treeUrl("workspaceId=w1&depth=1"), fs);
    if (!result.ok || !("entries" in result.data)) throw new Error("expected tree");
    expect(result.data.entries.length).toBe(MAX_FILE_TREE_ENTRIES);
    expect(result.data.truncated).toBe(true);
  });
});

// ── Workspace → cwd resolution ─────────────────────────────────────────────────

describe("workspaceCwd", () => {
  const workspaces: readonly WorkspaceView[] = [
    { workspaceId: "w1", number: 1, label: "one", focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 2 },
    { workspaceId: "w2", number: 2, label: "two", focused: false, activeTabId: "w2:t1", tabCount: 1, paneCount: 1 },
    { workspaceId: "w3", number: 3, label: "empty", focused: false, activeTabId: "w3:t1", tabCount: 1, paneCount: 1 },
  ];
  const pane = (workspaceId: string, cwd: string): AgentView => ({
    paneId: `${workspaceId}:p1`,
    workspaceId,
    workspaceLabel: "x",
    workspaceNumber: 1,
    tabId: `${workspaceId}:t1`,
    agent: "shell",
    status: "unknown",
    cwd,
    focused: false,
  });
  const snapshot = (agents: AgentView[], shellPanes: AgentView[]) => ({ workspaces, agents, shellPanes });

  test("prefers the agent pane's cwd for the workspace", () => {
    const snap = snapshot([pane("w1", "/agents-first")], [pane("w1", "/shell-second")]);
    expect(workspaceCwd("w1", snap)).toBe("/agents-first");
  });

  test("falls back to a shell pane when the workspace has no agent pane", () => {
    const snap = snapshot([], [pane("w2", "/shell-only")]);
    expect(workspaceCwd("w2", snap)).toBe("/shell-only");
  });

  test("returns null for an unknown workspace or one without panes", () => {
    expect(workspaceCwd("wX", snapshot([], []))).toBeNull();
    expect(workspaceCwd("w3", snapshot([], []))).toBeNull();
  });
});
