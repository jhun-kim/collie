type DiffViewProps = {
  diff: string;
  loading: boolean;
  error: string | null;
};

function lineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "bg-status-done/10 text-status-done";
  if (line.startsWith("-") && !line.startsWith("---")) return "bg-destructive/10 text-destructive";
  if (line.startsWith("@@")) return "bg-primary/10 text-primary";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
    return "text-muted-foreground";
  }
  return "text-foreground";
}

export function DiffView({ diff, loading, error }: DiffViewProps) {
  if (loading) return <p className="py-10 text-center text-sm text-muted-foreground">Loading diff…</p>;
  if (error) {
    return <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>;
  }
  if (!diff.trim()) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No diff for this selection.</p>;
  }
  return (
    <pre className="max-h-[58vh] overflow-auto rounded-md border bg-muted/30 py-2 font-mono text-[11px] leading-relaxed">
      {diff.split("\n").map((line, index) => (
        <div key={index} className={`px-3 ${lineClass(line)}`}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}
