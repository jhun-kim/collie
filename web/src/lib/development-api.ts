import { trackBusy } from "./busy";
import { ApiError, req as jsonReq, withSession } from "./api";

export type FileEntry = {
  readonly name: string;
  readonly type: "dir" | "file" | "symlink";
  readonly path: string;
  readonly size?: number;
  readonly children?: readonly FileEntry[];
};

export type FileTreeResponse = {
  readonly workspaceId: string;
  readonly root: string;
  readonly path: string;
  readonly depth: number;
  readonly truncated: boolean;
  readonly entries: readonly FileEntry[];
};

export type FileContentResponse = {
  readonly workspaceId: string;
  readonly path: string;
  readonly kind: "text" | "image";
  readonly mime: string;
  readonly encoding: "utf-8" | "base64";
  readonly size: number;
  readonly content: string;
};

export type GitChange = {
  readonly path: string;
  readonly status: string;
  readonly staged: boolean;
};

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

export type GitDiffResult = {
  readonly workspaceId: string;
  readonly file: string;
  readonly staged: boolean;
  readonly truncated: boolean;
  readonly diff: string;
};

export type GitFilesResult = {
  readonly workspaceId: string;
  readonly files: readonly string[];
};

export type GitCommitResult = {
  readonly workspaceId: string;
  readonly message: string;
  readonly output: string;
};

export function fetchFiles(
  workspaceId: string,
  path = "",
  session?: string,
  signal?: AbortSignal,
): Promise<FileTreeResponse> {
  const q = new URLSearchParams({ workspaceId, path, depth: "1" });
  if (path) q.set("path", path);
  return jsonReq<FileTreeResponse>(withSession(`/api/files?${q}`, session), { signal });
}

export function fetchFile(
  workspaceId: string,
  path: string,
  session?: string,
  signal?: AbortSignal,
): Promise<FileContentResponse> {
  const q = new URLSearchParams({ workspaceId, path });
  return jsonReq<FileContentResponse>(withSession(`/api/file?${q}`, session), { signal });
}

export function fetchGitStatus(
  workspaceId: string,
  session?: string,
  signal?: AbortSignal,
): Promise<GitStatusResult> {
  const q = new URLSearchParams({ workspaceId });
  return jsonReq<GitStatusResult>(withSession(`/api/git/status?${q}`, session), { signal });
}

export function fetchGitDiff(
  workspaceId: string,
  file: string,
  staged: boolean,
  session?: string,
  signal?: AbortSignal,
): Promise<GitDiffResult> {
  const q = new URLSearchParams({ workspaceId, file, staged: String(staged) });
  return jsonReq<GitDiffResult>(withSession(`/api/git/diff?${q}`, session), { signal });
}

export function stageFiles(
  workspaceId: string,
  files: readonly string[],
  session?: string,
): Promise<GitFilesResult> {
  return jsonReq<GitFilesResult>(withSession("/api/git/stage", session), {
      method: "POST",
      body: JSON.stringify({ workspaceId, files }),
    });
}

export function unstageFiles(
  workspaceId: string,
  files: readonly string[],
  session?: string,
): Promise<GitFilesResult> {
  return jsonReq<GitFilesResult>(withSession("/api/git/unstage", session), {
      method: "POST",
      body: JSON.stringify({ workspaceId, files }),
    });
}

export function commitChanges(
  workspaceId: string,
  message: string,
  session?: string,
): Promise<GitCommitResult> {
  return jsonReq<GitCommitResult>(withSession("/api/git/commit", session), {
      method: "POST",
      body: JSON.stringify({ workspaceId, message }),
    });
}

export interface WorktreeInfo {
  path: string;
  branch?: string | null;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  is_linked_worktree: boolean;
  label: string;
  open_workspace_id?: string | null;
}
export interface WorktreeListResult {
  type: "worktree_list";
  source: {
    repo_key: string;
    repo_name: string;
    repo_root: string;
    source_checkout_path: string;
    source_workspace_id?: string | null;
  };
  worktrees: WorktreeInfo[];
}
export interface WorktreeResult {
  type: "worktree_created" | "worktree_opened";
  workspace: { workspace_id: string; label: string };
  tab: { tab_id: string };
  root_pane: { pane_id: string; tab_id: string; cwd: string };
  worktree: WorktreeInfo;
  already_open?: boolean;
}
export interface WorktreeCreateOptions {
  workspaceId: string;
  branch: string;
  base?: string;
  label?: string;
}
export interface FileUploadResult { path: string; name: string; size: number; mime: string }

export function fetchWorktrees(workspaceId: string, session?: string, signal?: AbortSignal) {
  return jsonReq<WorktreeListResult>(withSession(`/api/worktrees?${new URLSearchParams({ workspaceId })}`, session), { signal });
}
export function createWorktree(options: WorktreeCreateOptions, session?: string) {
  return jsonReq<WorktreeResult>(withSession("/api/worktrees", session), {
    method: "POST", body: JSON.stringify(options),
  });
}
export function openWorktree(
  options: { workspaceId: string; path: string; label?: string } |
    { workspaceId: string; branch: string; label?: string },
  session?: string,
) {
  return jsonReq<WorktreeResult>(withSession("/api/worktrees/open", session), {
    method: "POST", body: JSON.stringify(options),
  });
}

/** XHR exposes upload progress while the browser supplies the multipart boundary. */
export function uploadFile(
  file: File,
  session?: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<FileUploadResult> {
  return trackBusy(new Promise<FileUploadResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = () => signal?.removeEventListener("abort", abort);
    xhr.open("POST", withSession("/api/upload", session));
    xhr.responseType = "json";
    xhr.timeout = 60_000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => {
      finish();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(xhr.response?.error ?? `Upload failed (${xhr.status})`, xhr.status));
      } else if (!xhr.response || typeof xhr.response.path !== "string") {
        reject(new Error("Invalid upload response"));
      } else {
        onProgress?.(100);
        resolve(xhr.response as FileUploadResult);
      }
    };
    xhr.onerror = () => { finish(); reject(new Error("Upload failed — check your connection")); };
    xhr.ontimeout = () => { finish(); reject(new Error("Upload timed out")); };
    xhr.onabort = () => { finish(); reject(new DOMException("Upload cancelled", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  }));
}
