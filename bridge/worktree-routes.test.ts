import { describe, expect, test } from "bun:test";

import type {
  WorktreeCreateOptions,
  WorktreeCreatedResult,
  WorktreeListResult,
  WorktreeOpenOptions,
  WorktreeOpenedResult,
} from "./herdr-client.ts";
import type { WorkspaceView } from "./types.ts";
import {
  handleWorktreeRoute,
  type WorktreeRouteContext,
} from "./worktree-routes.ts";

const workspaces: readonly WorkspaceView[] = [
  {
    workspaceId: "w1",
    number: 1,
    label: "main",
    focused: true,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
  },
];

const workspace = {
  workspace_id: "w2",
  number: 2,
  label: "feature",
  focused: false,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: "w2:t1",
  agent_status: "unknown",
} as const;

const tab = {
  tab_id: "w2:t1",
  workspace_id: "w2",
  number: 1,
  label: "1",
  focused: false,
  pane_count: 1,
  agent_status: "unknown",
} as const;

const rootPane = {
  pane_id: "w2:p1",
  terminal_id: "term",
  workspace_id: "w2",
  tab_id: "w2:t1",
  focused: false,
  cwd: "/repo-feature",
  agent_status: "unknown",
  revision: 0,
} as const;

const worktree = {
  path: "/repo-feature",
  branch: "feature",
  is_bare: false,
  is_detached: false,
  is_prunable: false,
  is_linked_worktree: true,
  label: "feature",
} as const;

const listResult: WorktreeListResult = {
  type: "worktree_list",
  source: {
    repo_key: "repo-key",
    repo_name: "collie",
    repo_root: "/repo",
    source_checkout_path: "/repo",
  },
  worktrees: [],
};

const createdResult: WorktreeCreatedResult = {
  type: "worktree_created",
  workspace,
  tab,
  root_pane: rootPane,
  worktree,
};

const openedResult: WorktreeOpenedResult = {
  type: "worktree_opened",
  workspace,
  tab,
  root_pane: rootPane,
  worktree,
  already_open: false,
};

function request(path: string, method: string, body?: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
  });
}

function harness(overrides: Partial<WorktreeRouteContext> = {}) {
  const calls: Array<{ readonly method: string; readonly options: unknown }> = [];
  const audits: unknown[] = [];
  const context: WorktreeRouteContext = {
    herdr: {
      listWorktrees: (options) => {
        calls.push({ method: "list", options });
        return Promise.resolve(listResult);
      },
      createWorktree: (options: WorktreeCreateOptions) => {
        calls.push({ method: "create", options });
        return Promise.resolve(createdResult);
      },
      openWorktree: (options: WorktreeOpenOptions) => {
        calls.push({ method: "open", options });
        return Promise.resolve(openedResult);
      },
    },
    audit: { record: (entry) => audits.push(entry) },
    workspaces,
    session: "default",
    device: "phone",
    ...overrides,
  };
  return { calls, audits, context };
}

describe("handleWorktreeRoute", () => {
  test("lists the uniquely focused workspace when workspaceId is omitted", async () => {
    // Given
    const { calls, context } = harness();

    // When
    const result = await handleWorktreeRoute(request("/api/worktrees", "GET"), context);

    // Then
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ method: "list", options: { workspaceId: "w1" } }]);
  });

  test("rejects missing or ambiguous focus without calling Herdr", async () => {
    // Given
    const none = harness({ workspaces: [] });
    const ambiguous = harness({
      workspaces: [
        ...workspaces,
        {
          workspaceId: "w2",
          number: 2,
          label: "other",
          focused: true,
          activeTabId: "w2:t1",
          tabCount: 1,
          paneCount: 1,
        },
      ],
    });

    // When
    const results = await Promise.all([
      handleWorktreeRoute(request("/api/worktrees", "GET"), none.context),
      handleWorktreeRoute(request("/api/worktrees", "GET"), ambiguous.context),
    ]);

    // Then
    expect(results.map((result) => result.ok ? 200 : result.status)).toEqual([400, 400]);
    expect(none.calls).toEqual([]);
    expect(ambiguous.calls).toEqual([]);
  });

  test("creates from a nonblank branch and audits only after success", async () => {
    // Given
    const { calls, audits, context } = harness();

    // When
    const result = await handleWorktreeRoute(
      request(
        "/api/worktrees",
        "POST",
        JSON.stringify({ branch: " feature ", base: "main", label: "Feature" }),
      ),
      context,
    );

    // Then
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        method: "create",
        options: { workspaceId: "w1", branch: "feature", base: "main", label: "Feature" },
      },
    ]);
    expect(audits).toHaveLength(1);
  });

  test.each([
    ["blank branch", { branch: " " }],
    ["missing branch", {}],
    ["an arbitrary path", { branch: "feature", path: "/tmp/feature" }],
  ] as const)("rejects create with %s without calls or audit", async (_case, body) => {
    // Given
    const { calls, audits, context } = harness();

    // When
    const result = await handleWorktreeRoute(
      request("/api/worktrees", "POST", JSON.stringify(body)),
      context,
    );

    // Then
    expect(result.ok).toBe(false);
    expect(result.ok ? 200 : result.status).toBe(400);
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("opens an absolute path and audits the successful call", async () => {
    // Given
    const { calls, audits, context } = harness();

    // When
    const result = await handleWorktreeRoute(
      request("/api/worktrees/open", "POST", JSON.stringify({ path: "/repo/feature" })),
      context,
    );

    // Then
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { method: "open", options: { workspaceId: "w1", path: "/repo/feature" } },
    ]);
    expect(audits).toHaveLength(1);
  });

  test.each([
    ["neither selector", {}],
    ["both selectors", { branch: "feature", path: "/repo/feature" }],
    ["relative path", { path: "../feature" }],
  ] as const)("rejects open with %s without calls or audit", async (_case, body) => {
    // Given
    const { calls, audits, context } = harness();

    // When
    const result = await handleWorktreeRoute(
      request("/api/worktrees/open", "POST", JSON.stringify(body)),
      context,
    );

    // Then
    expect(result.ok).toBe(false);
    expect(result.ok ? 200 : result.status).toBe(400);
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("rejects malformed JSON without calls or audit", async () => {
    // Given
    const { calls, audits, context } = harness();

    // When
    const result = await handleWorktreeRoute(
      request("/api/worktrees", "POST", "{"),
      context,
    );

    // Then
    expect(result).toEqual({ ok: false, status: 400, error: "bad body" });
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("maps an unsupported Herdr method to an explicit 502 without audit", async () => {
    // Given
    const { audits, context } = harness({
      herdr: {
        listWorktrees: () => Promise.reject(new Error("unknown variant `worktree.list`")),
        createWorktree: () => Promise.reject(new Error("unused")),
        openWorktree: () => Promise.reject(new Error("unused")),
      },
    });

    // When
    const result = await handleWorktreeRoute(request("/api/worktrees", "GET"), context);

    // Then
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "unknown variant `worktree.list`",
    });
    expect(audits).toEqual([]);
  });
});
