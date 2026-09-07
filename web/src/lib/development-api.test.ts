import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { isApiErrorStatus } from "./api";
import {
  fetchWorktrees, createWorktree, openWorktree, fetchFiles, fetchFile,
  fetchGitStatus, fetchGitDiff, stageFiles, unstageFiles, commitChanges, uploadFile,
} from "./development-api";

describe("development API session and workspace boundaries", () => {
  it("scopes every read to the selected session and workspace without corrupting paths", async () => {
    const calls: URL[] = [];
    server.use(http.get(/\/api\/(worktrees|files|file|git\/status|git\/diff)$/, ({ request }) => {
      calls.push(new URL(request.url));
      return HttpResponse.json({});
    }));
    const workspace = "w 1";
    const session = "qa & preview";
    await fetchWorktrees(workspace, session);
    await fetchFiles(workspace, "src/a&b", session);
    await fetchFile(workspace, "src/a#b.ts", session);
    await fetchGitStatus(workspace, session);
    await fetchGitDiff(workspace, "src/a&b.ts", true, session);
    expect(calls).toHaveLength(5);
    for (const url of calls) {
      expect(url.searchParams.get("session")).toBe(session);
      expect(url.searchParams.get("workspaceId")).toBe(workspace);
    }
    expect(calls[1]!.searchParams.get("depth")).toBe("1");
    expect(calls[2]!.searchParams.get("path")).toBe("src/a#b.ts");
    expect(calls[4]!.searchParams.get("file")).toBe("src/a&b.ts");
    expect(calls[4]!.searchParams.get("staged")).toBe("true");
  });

  it("sends explicit workspace IDs for worktree and Git writes", async () => {
    const calls: Array<{ url: URL; body: unknown }> = [];
    server.use(http.post(/\/api\/(worktrees(?:\/open)?|git\/(?:stage|unstage|commit))$/, async ({ request }) => {
      calls.push({ url: new URL(request.url), body: await request.json() });
      return HttpResponse.json({});
    }));
    await createWorktree({ workspaceId: "w1", branch: "feature/mobile", base: "main" }, "qa");
    await openWorktree({ workspaceId: "w1", path: "/repo/worktree" }, "qa");
    await stageFiles("w1", ["a b.ts"], "qa");
    await unstageFiles("w1", ["a b.ts"], "qa");
    await commitChanges("w1", "Mobile work", "qa");
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.url.searchParams.get("session")).toBe("qa");
      expect(call.body).toMatchObject({ workspaceId: "w1" });
    }
    expect(calls[2]!.body).toEqual({ workspaceId: "w1", files: ["a b.ts"] });
    expect(calls[4]!.body).toEqual({ workspaceId: "w1", message: "Mobile work" });
  });

  it("preserves a permission refusal for callers", async () => {
    server.use(http.post("/api/git/commit", () => HttpResponse.json({ error: "read only" }, { status: 403 })));
    await expect(commitChanges("w1", "test").catch((error: unknown) => isApiErrorStatus(error, 403))).resolves.toBe(true);
  });
});

describe("general file upload", () => {
  it("uploads multipart with session scope and reports completion", async () => {
    let requestUrl: URL | undefined;
    let uploaded = "";
    server.use(http.post("/api/upload", async ({ request }) => {
      requestUrl = new URL(request.url);
      // Read the actual multipart bytes: jsdom's File is a different realm from Node's parser.
      uploaded = await request.text();
      return HttpResponse.json({ path: "/tmp/note.txt", name: "note.txt", size: 5, mime: "text/plain" });
    }));
    const progress = vi.fn();
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const append = vi.spyOn(FormData.prototype, "append");
    await expect(uploadFile(file, "qa", progress))
      .resolves.toMatchObject({ path: "/tmp/note.txt" });
    expect(requestUrl?.searchParams.get("session")).toBe("qa");
    expect(append).toHaveBeenCalledWith("file", file);
    expect(uploaded).toContain('name="file"');
    append.mockRestore();
    expect(progress).toHaveBeenLastCalledWith(100);
  });

  it("rejects oversized uploads with the original status", async () => {
    server.use(http.post("/api/upload", () => HttpResponse.json({ error: "file too large" }, { status: 413 })));
    await expect(uploadFile(new File(["x"], "note.txt")).catch((error: unknown) => isApiErrorStatus(error, 413)))
      .resolves.toBe(true);
  });

  it("does not start a cancelled upload", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadFile(new File(["x"], "note.txt"), undefined, undefined, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
