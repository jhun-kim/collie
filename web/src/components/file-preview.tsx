import { FileText, Image as ImageIcon } from "lucide-react";

import { MarkdownText } from "@/components/markdown-text";
import type { FileContentResponse } from "@/lib/development-api";

type FilePreviewProps = {
  file: FileContentResponse | null;
  path: string | null;
  loading: boolean;
  error: string | null;
};

function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function FilePreview({ file, path, loading, error }: FilePreviewProps) {
  if (loading) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Loading preview…</p>;
  }
  if (error) {
    return <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>;
  }
  if (!file || !path) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Select a file to preview.</p>;
  }

  if (file.kind === "image") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ImageIcon className="size-4" />
          <span className="truncate">{file.mime}</span>
        </div>
        <img
          src={`data:${file.mime};base64,${file.content}`}
          alt={path}
          className="max-h-[60vh] w-full rounded-md border object-contain"
        />
      </div>
    );
  }

  if (isMarkdown(path)) {
    return (
      <div className="rounded-md border bg-card px-3 py-3">
        <MarkdownText text={file.content} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <FileText className="size-4" />
        <span>{file.mime}</span>
      </div>
      <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
        {file.content}
      </pre>
    </div>
  );
}
