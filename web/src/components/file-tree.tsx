import { ChevronRight, FileText, Folder, FolderOpen, Link as LinkIcon, Loader2 } from "lucide-react";

import type { FileEntry } from "@/lib/development-api";
import { cn } from "@/lib/utils";

type FileTreeProps = {
  entries: readonly FileEntry[];
  selectedPath?: string;
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  onToggleDir: (entry: FileEntry) => void;
  onOpenDir: (entry: FileEntry) => void;
  onOpenFile: (entry: FileEntry) => void;
};

function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function EntryRow({
  entry,
  depth,
  selectedPath,
  expanded,
  loading,
  onToggleDir,
  onOpenDir,
  onOpenFile,
}: FileTreeProps & { entry: FileEntry; depth: number }) {
  const isDir = entry.type === "dir";
  const isExpanded = expanded.has(entry.path);
  const isLoading = loading.has(entry.path);
  const selected = selectedPath === entry.path;
  const Icon = entry.type === "dir" ? Folder : entry.type === "symlink" ? LinkIcon : FileText;

  return (
    <li>
      <div
        className={cn(
          "flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-accent",
          selected && "bg-accent text-accent-foreground",
        )}
        style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
      >
        {isDir ? (
          <button
            type="button"
            onClick={() => onToggleDir(entry)}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${entry.name}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
          >
            {isLoading ? (
              <Loader2 className="size-4 animate-spin" aria-label="Loading" />
            ) : (
              <ChevronRight className={cn("size-4 transition-transform", isExpanded && "rotate-90")} />
            )}
          </button>
        ) : (
          <span className="size-7 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          disabled={entry.type === "symlink"}
          onClick={() => (isDir ? onOpenDir(entry) : onOpenFile(entry))}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left disabled:pointer-events-none disabled:opacity-50"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </button>
        {entry.type === "file" && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {sizeLabel(entry.size)}
          </span>
        )}
        {isDir && (
          <button
            type="button"
            onClick={() => onOpenDir(entry)}
            aria-label={`Open ${entry.name}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
          >
            <FolderOpen className="size-4" />
          </button>
        )}
      </div>
      {isDir && isExpanded && entry.children && entry.children.length > 0 && (
        <ul className="mt-0.5 space-y-0.5">
          {entry.children.map((child) => (
            <EntryRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              entries={entry.children ?? []}
              selectedPath={selectedPath}
              expanded={expanded}
              loading={loading}
              onToggleDir={onToggleDir}
              onOpenDir={onOpenDir}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FileTree(props: FileTreeProps) {
  if (props.entries.length === 0) {
    return <p className="px-1 py-8 text-center text-sm text-muted-foreground">No files here.</p>;
  }
  return (
    <ul className="space-y-0.5">
      {props.entries.map((entry) => (
        <EntryRow key={entry.path} entry={entry} depth={0} {...props} />
      ))}
    </ul>
  );
}
