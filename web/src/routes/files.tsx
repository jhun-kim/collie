import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, FolderOpen, Home, Loader2 } from "lucide-react";
import { useNavigate, useParams, useRouteLoaderData } from "react-router";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { FilePreview } from "@/components/file-preview";
import { FileTree } from "@/components/file-tree";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { Button } from "@/components/ui/button";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import {
  fetchFile,
  fetchFiles,
  type FileContentResponse,
  type FileEntry,
  type FileTreeResponse,
} from "@/lib/development-api";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath, spacePath } from "@/lib/nav";
import { useSession } from "@/lib/session";

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function withChildren(
  entries: readonly FileEntry[],
  targetPath: string,
  children: readonly FileEntry[],
): FileEntry[] {
  return entries.map((entry) => {
    if (entry.path === targetPath) return { ...entry, children };
    if (entry.children) return { ...entry, children: withChildren(entry.children, targetPath, children) };
    return entry;
  });
}

function Breadcrumbs({
  path,
  onOpen,
}: {
  path: string;
  onOpen: (path: string) => void;
}) {
  const parts = path.split("/").filter(Boolean);
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground">
      <button type="button" onClick={() => onOpen("")} className="shrink-0 rounded px-1 py-1 hover:bg-accent">
        <Home className="size-3.5" aria-label="Root" />
      </button>
      {parts.map((part, index) => {
        const next = parts.slice(0, index + 1).join("/");
        return (
          <span key={next} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="size-3 shrink-0" />
            <button
              type="button"
              onClick={() => onOpen(next)}
              className="min-w-0 truncate rounded px-1 py-1 hover:bg-accent"
            >
              {part}
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function FilesRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const { spaceId = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const stalled = useLoadingStalled();
  const workspace = data?.workspaces.find((w) => w.workspaceId === spaceId);
  const workspaceId = workspace?.workspaceId;

  const [path, setPath] = useState("");
  const [tree, setTree] = useState<FileTreeResponse | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileContentResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingBranches, setLoadingBranches] = useState<Set<string>>(() => new Set());
  const [refreshToken, setRefreshToken] = useState(0);
  const treeSeq = useRef(0);
  const fileSeq = useRef(0);
  const fileController = useRef<AbortController | null>(null);
  const branchControllers = useRef(new Map<string, AbortController>());
  const activeKey = `${workspaceId ?? ""}\u0000${session ?? ""}`;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  useEffect(() => {
    fileSeq.current += 1;
    treeSeq.current += 1;
    fileController.current?.abort();
    branchControllers.current.forEach((controller) => controller.abort());
    branchControllers.current.clear();
    setPath("");
    setTree(null);
    setTreeError(null);
    setExpanded(new Set());
    setLoadingBranches(new Set());
    setSelectedPath(null);
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
  }, [spaceId, session]);

  useEffect(() => {
    if (!workspaceId) return;
    const seq = ++treeSeq.current;
    const controller = new AbortController();
    setTreeLoading(true);
    setTreeError(null);
    fetchFiles(workspaceId, path, session, controller.signal)
      .then((next) => {
        if (seq !== treeSeq.current) return;
        setTree(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || seq !== treeSeq.current) return;
        setTreeError(errorMessage(error));
      })
      .finally(() => {
        if (seq === treeSeq.current) setTreeLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, path, session, refreshToken]);

  function openPath(nextPath: string) {
    fileSeq.current += 1;
    fileController.current?.abort();
    setPath(nextPath);
    setTree(null);
    setTreeError(null);
    setExpanded(new Set());
    setLoadingBranches(new Set());
    setSelectedPath(null);
    setPreview(null);
    setPreviewLoading(false);
    setPreviewError(null);
  }

  function openFile(nextPath: string) {
    if (!workspaceId) return;
    const seq = ++fileSeq.current;
    const controller = new AbortController();
    fileController.current?.abort();
    fileController.current = controller;
    setSelectedPath(nextPath);
    setPreview(null);
    setPreviewLoading(true);
    setPreviewError(null);
    fetchFile(workspaceId, nextPath, session, controller.signal)
      .then((next) => {
        if (seq !== fileSeq.current) return;
        setPreview(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || seq !== fileSeq.current) return;
        setPreviewError(errorMessage(error));
      })
      .finally(() => {
        if (seq === fileSeq.current) {
          setPreviewLoading(false);
          if (fileController.current === controller) fileController.current = null;
        }
      });
  }

  function toggleDir(entry: FileEntry) {
    if (!workspaceId) return;
    if (expanded.has(entry.path)) {
      branchControllers.current.get(entry.path)?.abort();
      branchControllers.current.delete(entry.path);
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      setLoadingBranches((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }

    setExpanded((current) => new Set(current).add(entry.path));
    if (entry.children) return;

    const requestKey = activeKeyRef.current;
    const controller = new AbortController();
    branchControllers.current.get(entry.path)?.abort();
    branchControllers.current.set(entry.path, controller);
    setLoadingBranches((current) => new Set(current).add(entry.path));
    setTreeError(null);
    fetchFiles(workspaceId, entry.path, session, controller.signal)
      .then((next) => {
        if (controller.signal.aborted || activeKeyRef.current !== requestKey) return;
        setTree((current) =>
          current ? { ...current, entries: withChildren(current.entries, entry.path, next.entries) } : current,
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || activeKeyRef.current !== requestKey) return;
        setTreeError(errorMessage(error));
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(entry.path);
          return next;
        });
      })
      .finally(() => {
        if (branchControllers.current.get(entry.path) === controller) {
          branchControllers.current.delete(entry.path);
        }
        if (activeKeyRef.current === requestKey) {
          setLoadingBranches((current) => {
            const next = new Set(current);
            next.delete(entry.path);
            return next;
          });
        }
      });
  }

  useEffect(() => {
    return () => {
      fileSeq.current += 1;
      treeSeq.current += 1;
      fileController.current?.abort();
      branchControllers.current.forEach((controller) => controller.abort());
      branchControllers.current.clear();
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <AppHeader
        bridge={data?.bridge}
        error={data?.error ?? false}
        stalled={stalled}
        onHome={() => navigate(homePath(session))}
        rightTrail={<SettingsGear session={session} />}
      >
        <button
          type="button"
          onClick={() => navigate(spacePath(spaceId, session))}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <ArrowLeft className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{workspace?.label ?? "Files"}</div>
            <div className="truncate text-xs text-muted-foreground">Files</div>
          </div>
        </button>
      </AppHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ReadOnlyBanner device={data?.device} />
        {!workspace ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">Space not found.</p>
        ) : (
          <main className="flex flex-1 flex-col gap-4 px-3 py-4">
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <Breadcrumbs path={path} onOpen={openPath} />
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" disabled={treeLoading} onClick={() => setRefreshToken((n) => n + 1)}>
                    {treeLoading ? <Loader2 className="size-4 animate-spin" /> : null}
                    Refresh
                  </Button>
                  <Button variant="outline" size="sm" disabled={!path} onClick={() => openPath(parentPath(path))}>
                    Parent
                  </Button>
                </div>
              </div>
              <div className="rounded-md border bg-card p-2">
                {treeLoading && !tree ? (
                  <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Loading files…
                  </p>
                ) : treeError ? (
                  <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {treeError}
                  </p>
                ) : (
                  <>
                    <div className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground">
                      <FolderOpen className="size-4" />
                      <span className="min-w-0 truncate">{tree?.root}</span>
                    </div>
                    <FileTree
                      entries={tree?.entries ?? []}
                      selectedPath={selectedPath ?? undefined}
                      expanded={expanded}
                      loading={loadingBranches}
                      onToggleDir={toggleDir}
                      onOpenDir={(entry) => openPath(entry.path)}
                      onOpenFile={(entry) => openFile(entry.path)}
                    />
                    {tree?.truncated && (
                      <p className="px-1 pt-2 text-xs text-muted-foreground">Listing truncated. Open a narrower folder.</p>
                    )}
                  </>
                )}
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview</h2>
              <FilePreview file={preview} path={selectedPath} loading={previewLoading} error={previewError} />
            </section>
          </main>
        )}
      </div>
    </div>
  );
}
