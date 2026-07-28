import { isAbsolute } from "node:path";

import type { AuditLog } from "./audit.ts";
import type {
  HerdrClient,
  WorktreeCreateOptions,
  WorktreeCreatedResult,
  WorktreeListResult,
  WorktreeOpenOptions,
  WorktreeOpenedResult,
} from "./herdr-client.ts";
import type { WorkspaceView } from "./types.ts";

type WorktreeClient = Pick<HerdrClient, "listWorktrees" | "createWorktree" | "openWorktree">;
type WorktreeAudit = Pick<AuditLog, "record">;

export type WorktreeRouteContext = {
  readonly herdr: WorktreeClient;
  readonly audit: WorktreeAudit;
  readonly workspaces: readonly WorkspaceView[];
  readonly session: string;
  readonly device: string | null;
};

export type WorktreeRouteResult =
  | {
      readonly ok: true;
      readonly data: WorktreeListResult | WorktreeCreatedResult | WorktreeOpenedResult;
    }
  | { readonly ok: false; readonly status: 400 | 405 | 502; readonly error: string };

function failure(status: 400 | 405 | 502, error: string): WorktreeRouteResult {
  return { ok: false, status, error };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value?: string } | { readonly ok: false } {
  const value = body[key];
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  return trimmed.length > 0 ? { ok: true, value: trimmed } : { ok: false };
}

function resolveWorkspaceId(
  requested: unknown,
  workspaces: readonly WorkspaceView[],
): { readonly ok: true; readonly workspaceId: string } | { readonly ok: false } {
  if (requested !== undefined) {
    if (typeof requested !== "string") return { ok: false };
    const workspaceId = requested.trim();
    return workspaceId.length > 0 ? { ok: true, workspaceId } : { ok: false };
  }
  const focused = workspaces.filter((workspace) => workspace.focused);
  return focused.length === 1 && focused[0] !== undefined
    ? { ok: true, workspaceId: focused[0].workspaceId }
    : { ok: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "herdr worktree request failed";
}

export async function handleWorktreeRoute(
  req: Request,
  context: WorktreeRouteContext,
): Promise<WorktreeRouteResult> {
  const url = new URL(req.url);
  const isCollection = url.pathname === "/api/worktrees";
  const isOpen = url.pathname === "/api/worktrees/open";

  if (isCollection && req.method === "GET") {
    const workspace = resolveWorkspaceId(
      url.searchParams.get("workspaceId") ?? undefined,
      context.workspaces,
    );
    if (!workspace.ok) return failure(400, "exactly one workspace required");
    try {
      return {
        ok: true,
        data: await context.herdr.listWorktrees({ workspaceId: workspace.workspaceId }),
      };
    } catch (error) {
      return failure(502, errorMessage(error));
    }
  }

  if ((!isCollection && !isOpen) || req.method !== "POST") {
    return failure(405, "method not allowed");
  }

  let body: Record<string, unknown> | null;
  try {
    body = recordValue(await req.json());
  } catch {
    return failure(400, "bad body");
  }
  if (body === null) return failure(400, "bad body");

  const workspace = resolveWorkspaceId(body.workspaceId, context.workspaces);
  if (!workspace.ok) return failure(400, "exactly one workspace required");
  const label = optionalString(body, "label");
  if (!label.ok) return failure(400, "bad label");

  if (isCollection) {
    const branch = optionalString(body, "branch");
    const base = optionalString(body, "base");
    if (!branch.ok || branch.value === undefined) return failure(400, "branch required");
    if (!base.ok || body.path !== undefined) return failure(400, "bad worktree options");
    const options: WorktreeCreateOptions = {
      workspaceId: workspace.workspaceId,
      branch: branch.value,
      ...(base.value !== undefined ? { base: base.value } : {}),
      ...(label.value !== undefined ? { label: label.value } : {}),
    };
    try {
      const data = await context.herdr.createWorktree(options);
      context.audit.record({
        action: "worktree.create",
        session: context.session,
        device: context.device,
        detail: options,
      });
      return { ok: true, data };
    } catch (error) {
      return failure(502, errorMessage(error));
    }
  }

  const branch = optionalString(body, "branch");
  const path = optionalString(body, "path");
  if (!branch.ok || !path.ok) return failure(400, "bad worktree selector");
  const selectors = Number(branch.value !== undefined) + Number(path.value !== undefined);
  if (selectors !== 1) return failure(400, "exactly one branch or path required");
  if (path.value !== undefined && !isAbsolute(path.value)) {
    return failure(400, "path must be absolute");
  }
  let options: WorktreeOpenOptions;
  if (branch.value !== undefined) {
    options = {
      workspaceId: workspace.workspaceId,
      branch: branch.value,
      ...(label.value !== undefined ? { label: label.value } : {}),
    };
  } else if (path.value !== undefined) {
    options = {
      workspaceId: workspace.workspaceId,
      path: path.value,
      ...(label.value !== undefined ? { label: label.value } : {}),
    };
  } else {
    return failure(400, "exactly one branch or path required");
  }
  try {
    const data = await context.herdr.openWorktree(options);
    context.audit.record({
      action: "worktree.open",
      session: context.session,
      device: context.device,
      detail: options,
    });
    return { ok: true, data };
  } catch (error) {
    return failure(502, errorMessage(error));
  }
}
