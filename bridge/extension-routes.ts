import type { Config } from "./config.ts";

export const EXTENSION_GROUPS = [
  "worktrees",
  "terminal",
  "files",
  "git",
  "upload",
  "blocking-message",
] as const;

export type ExtensionGroup = (typeof EXTENSION_GROUPS)[number];
export type ExtensionAccess = "read" | "write";

export type ExtensionRouteMatch =
  | {
      readonly kind: "scaffold";
      readonly group: ExtensionGroup;
      readonly access: ExtensionAccess;
    }
  | {
      readonly kind: "method-not-allowed";
      readonly group: ExtensionGroup;
      readonly access: "read";
    };

function unsupported(group: ExtensionGroup): ExtensionRouteMatch {
  return { kind: "method-not-allowed", group, access: "read" };
}

export function classifyExtensionRoute(req: Request): ExtensionRouteMatch | null {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/api/worktrees") {
    if (req.method === "GET") return { kind: "scaffold", group: "worktrees", access: "read" };
    if (req.method === "POST") return { kind: "scaffold", group: "worktrees", access: "write" };
    return unsupported("worktrees");
  }
  if (pathname === "/api/worktrees/open") {
    return req.method === "POST"
      ? { kind: "scaffold", group: "worktrees", access: "write" }
      : unsupported("worktrees");
  }
  if (pathname.startsWith("/api/worktrees/")) return unsupported("worktrees");

  if (/^\/ws\/terminal\/[^/]+$/.test(pathname)) {
    if (req.method !== "GET") return unsupported("terminal");
    const mode = url.searchParams.get("mode") ?? "observe";
    if (mode === "observe") return { kind: "scaffold", group: "terminal", access: "read" };
    if (mode === "control") return { kind: "scaffold", group: "terminal", access: "write" };
    return unsupported("terminal");
  }

  if (pathname === "/api/files" || pathname === "/api/file") {
    return req.method === "GET"
      ? { kind: "scaffold", group: "files", access: "read" }
      : unsupported("files");
  }

  const gitPrefix = "/api/git/";
  if (pathname.startsWith(gitPrefix)) {
    const action = pathname.slice(gitPrefix.length);
    switch (action) {
      case "status":
      case "diff":
      case "log":
      case "branch":
        return req.method === "GET"
          ? { kind: "scaffold", group: "git", access: "read" }
          : unsupported("git");
      case "stage":
      case "unstage":
      case "commit":
        return req.method === "POST"
          ? { kind: "scaffold", group: "git", access: "write" }
          : unsupported("git");
      default:
        return unsupported("git");
    }
  }

  if (pathname === "/api/upload") {
    return req.method === "POST"
      ? { kind: "scaffold", group: "upload", access: "write" }
      : unsupported("upload");
  }

  if (pathname === "/api/blocking-message") {
    return req.method === "GET"
      ? { kind: "scaffold", group: "blocking-message", access: "read" }
      : unsupported("blocking-message");
  }

  return null;
}

export function terminalOriginAllowed(req: Request, cfg: Config): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;

  try {
    return (
      new URL(origin).host === (req.headers.get("host") ?? "") ||
      cfg.allowedOrigins.includes(origin)
    );
  } catch {
    return false;
  }
}
