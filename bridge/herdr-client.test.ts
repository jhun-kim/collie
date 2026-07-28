import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HerdrClient } from "./herdr-client.ts";

type WireRequest = {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
};

const dir = mkdtempSync(join(tmpdir(), "collie-herdr-client-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function exchange(
  tag: string,
  invoke: (client: HerdrClient) => Promise<unknown>,
  result: Record<string, unknown>,
): Promise<{ readonly request: WireRequest; readonly value: unknown }> {
  const socketPath = join(dir, `${tag}.sock`);
  let received: WireRequest | undefined;
  const server = net.createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      received = JSON.parse(buffer.slice(0, newline));
      connection.end(`${JSON.stringify({ id: received?.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    const value = await invoke(new HerdrClient(socketPath, 1000, "net"));
    if (received === undefined) throw new Error("test server did not receive a request");
    return { request: received, value };
  } finally {
    server.close();
  }
}

describe("HerdrClient worktree RPCs", () => {
  test("listWorktrees sends worktree.list with the selected workspace", async () => {
    // Given
    const reply = {
      type: "worktree_list",
      source: {
        repo_key: "repo-key",
        repo_name: "collie",
        repo_root: "/repo",
        source_checkout_path: "/repo",
        source_workspace_id: "w1",
      },
      worktrees: [],
    };

    // When
    const exchanged = await exchange(
      "list",
      (client) => client.listWorktrees({ workspaceId: "w1" }),
      reply,
    );

    // Then
    expect(exchanged.request.method).toBe("worktree.list");
    expect(exchanged.request.params).toEqual({ workspace_id: "w1" });
    expect(exchanged.value).toEqual(reply);
  });

  test("createWorktree sends exact optional params and forces focus false", async () => {
    // Given
    const reply = {
      type: "worktree_created",
      workspace: { workspace_id: "w2" },
      tab: { tab_id: "w2:t1" },
      root_pane: { pane_id: "w2:p1" },
      worktree: { path: "/repo-feature", label: "feature", is_bare: false },
    };

    // When
    const exchanged = await exchange(
      "create",
      (client) =>
        client.createWorktree({
          workspaceId: "w1",
          branch: "feature",
          base: "main",
          path: "/repo-feature",
          label: "Feature",
        }),
      reply,
    );

    // Then
    expect(exchanged.request.method).toBe("worktree.create");
    expect(exchanged.request.params).toEqual({
      workspace_id: "w1",
      branch: "feature",
      base: "main",
      path: "/repo-feature",
      label: "Feature",
      focus: false,
    });
    expect(exchanged.value).toEqual(reply);
  });

  test("openWorktree sends exactly one selector and forces focus false", async () => {
    // Given
    const reply = {
      type: "worktree_opened",
      workspace: { workspace_id: "w3" },
      tab: { tab_id: "w3:t1" },
      root_pane: { pane_id: "w3:p1" },
      worktree: { path: "/repo-feature", label: "feature", is_bare: false },
      already_open: false,
    };

    // When
    const exchanged = await exchange(
      "open",
      (client) =>
        client.openWorktree({
          workspaceId: "w1",
          path: "/repo-feature",
          label: "Feature",
        }),
      reply,
    );

    // Then
    expect(exchanged.request.method).toBe("worktree.open");
    expect(exchanged.request.params).toEqual({
      workspace_id: "w1",
      path: "/repo-feature",
      label: "Feature",
      focus: false,
    });
    expect(exchanged.value).toEqual(reply);
  });
});
