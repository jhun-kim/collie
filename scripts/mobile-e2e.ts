import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { chromium, devices, expect, webkit, type BrowserContextOptions, type Page } from "@playwright/test";

// Live mobile E2E runner for plan todo 16.
//
// Required environment:
//   COLLIE_E2E_BASE_URL       http://127.0.0.1:8794 (root starts the fixture bridge)
//   COLLIE_E2E_WORKSPACE_ID   workspace backed by COLLIE_E2E_REPO
//   COLLIE_E2E_PANE_ID        fixture pane only; this script types into it
//   COLLIE_E2E_REPO           temporary git repo used for file/git/worktree checks
//
// Optional environment:
//   COLLIE_E2E_DEVICE_HEADER / COLLIE_E2E_WRITE_DEVICE / COLLIE_E2E_READONLY_DEVICE
//     Enables explicit read-only write-gate verification and authenticated writes.
//   COLLIE_E2E_EXPECT_BLOCKED=1 / COLLIE_E2E_BLOCKED_PANE_ID / COLLIE_E2E_EXPECT_BLOCKING_TEXT
//     Requires a blocked fixture pane with a captured blockingMessage in /api/snapshot.
//   COLLIE_E2E_BROWSER=webkit / COLLIE_E2E_HEADLESS=0 / COLLIE_E2E_RUN_ID=<stable-id>
//
// It records PASS only for steps it actually executed. Environment-dependent checks use SKIP unless
// their expectation env says they are mandatory. Screenshots are written under
// .omo/evidence/screenshots/todo16-<run-id>-*.png.

type Status = "PASS" | "FAIL" | "SKIP";
type StepResult = { name: string; status: Status; detail: string };

type Snapshot = {
  bridge: "connected" | "disconnected";
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: Array<{ workspaceId: string; label: string }>;
};

type AgentView = {
  paneId: string;
  workspaceId: string;
  workspaceLabel?: string;
  status: string;
  cwd: string;
  blockingMessage?: { text: string; capturedAt: number };
};

type FileTreeResponse = {
  workspaceId: string;
  entries: Array<{ name: string; type: string; path: string }>;
};

type FileContentResponse = {
  workspaceId: string;
  path: string;
  kind: "text" | "image";
  encoding: "utf-8" | "base64";
  content: string;
};

type GitStatusResponse = {
  workspaceId: string;
  changed: Array<{ path: string; status: string; staged: boolean }>;
};

type GitDiffResponse = {
  workspaceId: string;
  file: string;
  staged: boolean;
  diff: string;
};

type PaneReadResponse = { paneId: string; text: string; truncated: boolean; revision: number };
type ActionResponse = { ok: true } | { ok: false; error: string; textDelivered?: boolean };
type UploadResponse = { path: string; name: string; size: number; mime: string };
type WorktreeResponse = {
  type: "worktree_created" | "worktree_opened";
  workspace: { workspace_id: string; label: string };
  root_pane: { pane_id: string; cwd: string };
};

class SkipStep extends Error {
  override readonly name = "SkipStep";
}

const results: StepResult[] = [];
const requiredEnv = [
  "COLLIE_E2E_BASE_URL",
  "COLLIE_E2E_WORKSPACE_ID",
  "COLLIE_E2E_PANE_ID",
  "COLLIE_E2E_REPO",
] as const;

function requireEnv(name: (typeof requiredEnv)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const baseUrl = requireEnv("COLLIE_E2E_BASE_URL").replace(/\/+$/, "");
const workspaceId = requireEnv("COLLIE_E2E_WORKSPACE_ID");
const paneId = requireEnv("COLLIE_E2E_PANE_ID");
const repo = requireEnv("COLLIE_E2E_REPO");
const runId = process.env.COLLIE_E2E_RUN_ID?.trim() || new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const fixtureRoot = "collie-e2e";
const screenshotDir = join(".omo", "evidence", "screenshots");
const screenshotPrefix = `todo16-${runId}`;

function apiUrl(path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function writeHeaders(): Record<string, string> {
  const name = process.env.COLLIE_E2E_DEVICE_HEADER?.trim();
  const value = process.env.COLLIE_E2E_WRITE_DEVICE?.trim();
  return name && value ? { [name]: value } : {};
}

function paneRoutePath(): string {
  return `/pane/${encodeURI(paneId)}`;
}

function readonlyHeaders(): HeadersInit | null {
  const name = process.env.COLLIE_E2E_DEVICE_HEADER?.trim();
  const value = process.env.COLLIE_E2E_READONLY_DEVICE?.trim();
  return name && value ? { [name]: value } : null;
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(writeHeaders())) headers.set(key, value);
  return fetch(apiUrl(path), { ...init, headers });
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const res = await request(path, { ...init, headers });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function abort(message: string): never {
  console.error(`ABORT ${message}`);
  process.exit(1);
}

async function strictPrerequisites(): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) abort(`COLLIE_E2E_RUN_ID has unsafe characters: ${runId}`);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    abort(`COLLIE_E2E_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!/^https?:$/.test(parsed.protocol) || !loopbackHosts.has(parsed.hostname)) {
    abort(`COLLIE_E2E_BASE_URL must be loopback http(s), got ${baseUrl}`);
  }

  const repoReal = await realpath(repo).catch((error) => abort(`COLLIE_E2E_REPO realpath failed: ${error instanceof Error ? error.message : String(error)}`));
  const tempRoots = await Promise.all(
    ["/tmp", "/private/tmp", "/var/tmp"].map((root) => realpath(root).catch(() => null)),
  );
  if (!tempRoots.some((root) => root !== null && (repoReal === root || repoReal.startsWith(`${root}/`)))) {
    abort(`COLLIE_E2E_REPO must resolve under a temp directory, got ${repoReal}`);
  }

  await runGit(["rev-parse", "--is-inside-work-tree"]);
  const snap = await snapshot();
  if (snap.bridge !== "connected") abort(`bridge is ${snap.bridge}`);
  const fixturePane = [...snap.agents, ...snap.shellPanes].find((pane) => pane.paneId === paneId);
  if (!fixturePane) abort(`fixture pane ${paneId} not in snapshot`);
  if (fixturePane.workspaceId !== workspaceId) abort(`fixture pane ${paneId} workspace=${fixturePane.workspaceId}, expected ${workspaceId}`);
  const cwdReal = await realpath(fixturePane.cwd).catch((error) => abort(`fixture pane cwd realpath failed: ${error instanceof Error ? error.message : String(error)}`));
  if (cwdReal !== repoReal) abort(`fixture pane cwd=${cwdReal}, expected repo=${repoReal}`);
}

async function step(name: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, status: "PASS", detail });
    console.log(`PASS ${name}: ${detail}`);
  } catch (error) {
    if (error instanceof SkipStep) {
      results.push({ name, status: "SKIP", detail: error.message });
      console.log(`SKIP ${name}: ${error.message}`);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, status: "FAIL", detail });
    console.error(`FAIL ${name}: ${detail}`);
  }
}

function skip(message: string): never {
  throw new SkipStep(message);
}

async function runGit(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout;
}


async function configureFixtureGit(): Promise<void> {
  try {
    await runGit(["config", "user.email", "collie-e2e@example.invalid"]);
    await runGit(["config", "user.name", "Collie E2E"]);
  } catch (error) {
    abort(`failed to configure fixture git repo: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function prepareRepoFixtures(): Promise<string[]> {
  await mkdir(join(repo, fixtureRoot), { recursive: true });
  const files = ["note.txt", "sample.md"];
  for (const file of files) {
    const content = await readFile(join("scripts", "e2e-fixtures", file), "utf8");
    await writeFile(join(repo, fixtureRoot, file), content, "utf8");
  }
  const png = await readFile(join("scripts", "e2e-fixtures", "pixel.png.base64"), "utf8");
  await writeFile(join(repo, fixtureRoot, "pixel.png"), Buffer.from(png.trim(), "base64"));
  return files.concat("pixel.png").map((file) => `${fixtureRoot}/${file}`);
}

async function snapshot(): Promise<Snapshot> {
  return jsonRequest<Snapshot>("/api/snapshot");
}

async function waitForPaneText(needle: string, timeoutMs = 12_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const pane = await jsonRequest<PaneReadResponse>(`/api/pane/${encodePath(paneId)}?lines=600`);
    last = pane.text;
    if (last.split(/\r?\n/).some((line) => line.trim() === needle)) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`pane ${paneId} did not show ${needle}; tail=${last.slice(-240)}`);
}

async function expectAction(res: ActionResponse, label: string): Promise<void> {
  if (!res.ok) throw new Error(`${label}: ${res.error}`);
}

async function waitForSocket(page: Page, url: string, action?: "control"): Promise<string> {
  return page.evaluate(
    ({ socketUrl, mode }) =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(socketUrl);
        const timer = window.setTimeout(() => {
          ws.close();
          reject(new Error(`timed out waiting for ${mode} websocket`));
        }, 8_000);
        ws.onerror = () => {
          window.clearTimeout(timer);
          reject(new Error(`${mode} websocket error`));
        };
        ws.onmessage = (event) => {
          if (mode === "control") {
            ws.send(JSON.stringify({ cmd: "terminal.resize", cols: 100, rows: 30 }));
            ws.send(JSON.stringify({ cmd: "terminal.input", text: "\u0015" }));
            ws.send(JSON.stringify({ cmd: "terminal.release" }));
          } else {
            ws.close();
          }
          window.clearTimeout(timer);
          resolve(String(event.data).slice(0, 160));
        };
      }),
    { socketUrl: url, mode: action ?? "observe" },
  );
}

async function withMobilePage(fn: (page: Page) => Promise<void>): Promise<string> {
  const browserType = process.env.COLLIE_E2E_BROWSER === "webkit" ? webkit : chromium;
  const browser = await browserType.launch({ headless: process.env.COLLIE_E2E_HEADLESS !== "0" });
  const fallbackDevice: BrowserContextOptions = {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  };
  const contextOptions: BrowserContextOptions = {
    ...(devices["iPhone 13"] ?? fallbackDevice),
    extraHTTPHeaders: writeHeaders(),
  };
  const context = await browser.newContext(contextOptions);
  try {
    const page = await context.newPage();
    await fn(page);
    return "mobile browser checks completed";
  } finally {
    await context.close();
    await browser.close();
  }
}

async function openMobileRoute(page: Page, route: string, visibleText: string | RegExp): Promise<void> {
  await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await expect(page.getByText(visibleText).first()).toBeVisible({ timeout: 12_000 });
  await expectNoHorizontalOverflow(page);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return { viewport: window.innerWidth, documentWidth: root.scrollWidth };
  });
  assert(
    overflow.documentWidth <= overflow.viewport + 1,
    `horizontal overflow viewport=${overflow.viewport} document=${overflow.documentWidth}`,
  );
}

async function clickChangeAction(page: Page, file: string, action: "Stage" | "Unstage"): Promise<void> {
  const row = page
    .getByText(file, { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'rounded-md')][1]")
    .first();
  await expect(row).toBeVisible({ timeout: 12_000 });
  await row.getByRole("button", { name: action, exact: true }).click();
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, `${screenshotPrefix}-${name}.png`), fullPage: true });
}

await strictPrerequisites();
await configureFixtureGit();

await step("environment contract", async () => `${basename(repo)} workspace=${workspaceId} pane=${paneId}`);

await step("snapshot fixture scope", async () => {
  const snap = await snapshot();
  assert(snap.bridge === "connected", `bridge is ${snap.bridge}`);
  assert(snap.workspaces.some((workspace) => workspace.workspaceId === workspaceId), `workspace ${workspaceId} not in snapshot`);
  assert([...snap.agents, ...snap.shellPanes].some((pane) => pane.paneId === paneId), `pane ${paneId} not in snapshot`);
  return `${snap.workspaces.length} workspace(s), ${snap.agents.length + snap.shellPanes.length} pane(s)`;
});

let fixtureFiles: string[] = [];
await step("prepare fixture files", async () => {
  fixtureFiles = await prepareRepoFixtures();
  return fixtureFiles.join(", ");
});

await step("access guard rejects cross-origin reads", async () => {
  const res = await fetch(apiUrl("/api/snapshot"), { headers: { Origin: "http://evil.example" } });
  assert(res.status === 403, `expected 403, got ${res.status}`);
  return "GET /api/snapshot rejected mismatched Origin";
});

await step("readonly device gate rejects writes", async () => {
  const headers = readonlyHeaders();
  if (headers === null) skip("COLLIE_E2E_DEVICE_HEADER and COLLIE_E2E_READONLY_DEVICE not provided");
  const res = await fetch(apiUrl("/api/git/stage"), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, files: [`${fixtureRoot}/missing.txt`] }),
  });
  assert(res.status === 403, `expected 403, got ${res.status}`);
  return "write route rejected read-only fixture device";
});

await step("files API browses text, markdown, and image", async () => {
  const tree = await jsonRequest<FileTreeResponse>(`/api/files?workspaceId=${encodeURIComponent(workspaceId)}&path=${fixtureRoot}&depth=1`);
  const names = new Set(tree.entries.map((entry) => entry.name));
  for (const expected of ["note.txt", "sample.md", "pixel.png"]) assert(names.has(expected), `${expected} missing from tree`);
  const text = await jsonRequest<FileContentResponse>(`/api/file?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(`${fixtureRoot}/note.txt`)}`);
  const markdown = await jsonRequest<FileContentResponse>(`/api/file?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(`${fixtureRoot}/sample.md`)}`);
  const image = await jsonRequest<FileContentResponse>(`/api/file?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(`${fixtureRoot}/pixel.png`)}`);
  assert(text.kind === "text" && text.content.includes("text fixture"), "text preview did not return fixture content");
  assert(markdown.kind === "text" && markdown.content.includes("# Collie Mobile E2E"), "markdown preview did not return fixture content");
  assert(image.kind === "image" && image.encoding === "base64", "image preview did not return base64 image");
  return `tree=${tree.entries.length} text+markdown+image previews ok`;
});

await step("git API stages, diffs, unstages, and commits", async () => {
  const file = "tracked.txt";
  const original = await readFile(join(repo, file), "utf8").catch(() => "");
  await writeFile(join(repo, file), `${original.replace(/\n?$/, "\n")}collie e2e ${runId}\n`, "utf8");
  const initial = await jsonRequest<GitStatusResponse>(`/api/git/status?workspaceId=${encodeURIComponent(workspaceId)}`);
  assert(initial.changed.some((change) => change.path === file && !change.staged), `${file} not shown as unstaged`);
  const unstagedDiff = await jsonRequest<GitDiffResponse>(`/api/git/diff?workspaceId=${encodeURIComponent(workspaceId)}&file=${encodeURIComponent(file)}&staged=false`);
  assert(unstagedDiff.diff.includes(runId), "unstaged diff missing fixture content");
  await jsonRequest(`/api/git/stage`, { method: "POST", body: JSON.stringify({ workspaceId, files: [file] }) });
  const stagedDiff = await jsonRequest<GitDiffResponse>(`/api/git/diff?workspaceId=${encodeURIComponent(workspaceId)}&file=${encodeURIComponent(file)}&staged=true`);
  assert(stagedDiff.diff.includes(runId), "staged diff missing fixture content");
  await jsonRequest(`/api/git/unstage`, { method: "POST", body: JSON.stringify({ workspaceId, files: [file] }) });
  const unstaged = await jsonRequest<GitStatusResponse>(`/api/git/status?workspaceId=${encodeURIComponent(workspaceId)}`);
  assert(unstaged.changed.some((change) => change.path === file && !change.staged), `${file} not shown as unstaged after unstage`);
  await jsonRequest(`/api/git/stage`, { method: "POST", body: JSON.stringify({ workspaceId, files: [file] }) });
  await jsonRequest(`/api/git/commit`, { method: "POST", body: JSON.stringify({ workspaceId, message: `collie mobile e2e ${runId}` }) });
  const finalStatus = await jsonRequest<GitStatusResponse>(`/api/git/status?workspaceId=${encodeURIComponent(workspaceId)}`);
  assert(!finalStatus.changed.some((change) => change.path === file), `${file} still changed after commit`);
  return file;
});

await step("worktree API creates a fixture branch", async () => {
  const branch = `collie-e2e/${runId}`;
  const created = await jsonRequest<WorktreeResponse>("/api/worktrees", {
    method: "POST",
    body: JSON.stringify({ workspaceId, branch, label: `e2e ${runId}` }),
  });
  assert(created.type === "worktree_created", `unexpected result ${created.type}`);
  assert(typeof created.root_pane.pane_id === "string" && created.root_pane.pane_id.length > 0, "created pane id missing");
  return `${branch} -> ${created.root_pane.pane_id}`;
});

await step("pane reply and special keys target only fixture pane", async () => {
  const marker = `collie-e2e-reply-${runId}`;
  await expectAction(
    await jsonRequest<ActionResponse>(`/api/pane/${encodePath(paneId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ text: marker, submit: false }),
    }),
    "reply",
  );
  await expectAction(
    await jsonRequest<ActionResponse>(`/api/pane/${encodePath(paneId)}/keys`, {
      method: "POST",
      body: JSON.stringify({ keys: ["ctrl+u"] }),
    }),
    "keys",
  );
  return marker;
});

await step("attachment upload path can be delivered to fixture pane", async () => {
  const form = new FormData();
  const content = await readFile(join("scripts", "e2e-fixtures", "note.txt"));
  form.append("file", new File([content], `collie-e2e-${runId}.txt`, { type: "text/plain" }));
  const upload = await jsonRequest<UploadResponse>("/api/upload", { method: "POST", body: form });
  assert(upload.path.includes("uploads/"), `unexpected upload path ${upload.path}`);
  await expectAction(
    await jsonRequest<ActionResponse>(`/api/pane/${encodePath(paneId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ text: `Attachment: ${upload.path}`, submit: false }),
    }),
    "attachment reply",
  );
  await expectAction(
    await jsonRequest<ActionResponse>(`/api/pane/${encodePath(paneId)}/keys`, {
      method: "POST",
      body: JSON.stringify({ keys: ["ctrl+u"] }),
    }),
    "attachment clear",
  );
  return upload.name;
});

await step("blocked question appears in snapshot when fixture is blocked", async () => {
  const expected = process.env.COLLIE_E2E_EXPECT_BLOCKED === "1";
  const blockedPane = process.env.COLLIE_E2E_BLOCKED_PANE_ID?.trim() || paneId;
  const snap = await snapshot();
  const pane = snap.agents.find((agent) => agent.paneId === blockedPane);
  if (!pane || pane.status !== "blocked") {
    if (expected) throw new Error(`${blockedPane} is not blocked in snapshot`);
    skip(`${blockedPane} is not blocked in this fixture run`);
  }
  assert(pane.blockingMessage?.text, `${blockedPane} is blocked but has no blockingMessage`);
  const contains = process.env.COLLIE_E2E_EXPECT_BLOCKING_TEXT?.trim();
  if (contains) assert(pane.blockingMessage.text.includes(contains), `blockingMessage missing ${contains}`);
  return pane.blockingMessage.text.slice(0, 100);
});


await step("mobile UI blocked question opens from dashboard into detail", async () =>
  withMobilePage(async (page) => {
    const expected = process.env.COLLIE_E2E_EXPECT_BLOCKED === "1";
    const blockedPane = process.env.COLLIE_E2E_BLOCKED_PANE_ID?.trim() || paneId;
    const blockingText = process.env.COLLIE_E2E_EXPECT_BLOCKING_TEXT?.trim();
    if (!expected || !blockingText) skip("COLLIE_E2E_EXPECT_BLOCKED and COLLIE_E2E_EXPECT_BLOCKING_TEXT not provided");

    await openMobileRoute(page, "/", /Collie/i);
    const card = page.getByText(blockingText, { exact: true }).locator("xpath=ancestor::button[1]");
    await expect(card).toBeVisible({ timeout: 12_000 });
    await card.click();
    await page.waitForURL((url) => decodeURIComponent(url.pathname) === `/pane/${blockedPane}`, { timeout: 12_000 });
    await expect(page.getByLabel("Agent question")).toContainText(blockingText, { timeout: 12_000 });
    await expectNoHorizontalOverflow(page);
    await screenshot(page, "blocked-question-detail");
  }),
);

await step("terminal observe and control websocket", async () =>
  withMobilePage(async (page) => {
    await openMobileRoute(page, `/space/${encodePath(workspaceId)}/files`, /Files/i);
    const socketBase = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const observe = await waitForSocket(page, `${socketBase}/ws/terminal/${encodePath(paneId)}?mode=observe&cols=100&rows=30`);
    assert(observe.length > 0, "observe websocket returned no frame");
    const control = await waitForSocket(page, `${socketBase}/ws/terminal/${encodePath(paneId)}?mode=control&cols=100&rows=30`, "control");
    assert(control.length > 0, "control websocket returned no frame");
  }),
);

await step("mobile UI files browse text, markdown, image, and error states", async () =>
  withMobilePage(async (page) => {
    await openMobileRoute(page, `/space/${encodePath(workspaceId)}/files`, /Files/i);
    await page.getByRole("button", { name: `Open ${fixtureRoot}` }).click();
    await expect(page.getByRole("button", { name: /note\.txt/ })).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: /note\.txt/ }).click();
    await expect(page.getByText(/text fixture/i)).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: /sample\.md/ }).click();
    await expect(page.getByText("Collie Mobile E2E", { exact: false })).toBeVisible({ timeout: 12_000 });

    await page.getByRole("button", { name: /pixel\.png/ }).click();
    await expect(page.getByRole("img", { name: `${fixtureRoot}/pixel.png` })).toBeVisible({ timeout: 12_000 });

    await expectNoHorizontalOverflow(page);
    await screenshot(page, "files-interactions");

    await openMobileRoute(page, "/space/__collie_e2e_missing__/files", /Space not found\./i);
    await screenshot(page, "files-error");
  }),
);

await step("mobile UI source control stages, diffs, unstages, and commits", async () =>
  withMobilePage(async (page) => {
    const file = "src/example.ts";
    const original = await readFile(join(repo, file), "utf8").catch(() => "");
    await writeFile(join(repo, file), `${original.replace(/\n?$/, "\n")}// collie ui git ${runId}\n`, "utf8");

    await openMobileRoute(page, `/space/${encodePath(workspaceId)}/git`, /Source control/i);
    await expect(page.getByText(file, { exact: true })).toBeVisible({ timeout: 12_000 });
    await page.getByText(file, { exact: true }).click();
    await expect(page.getByText("Diff", { exact: true })).toBeVisible();
    await expect(page.getByText(runId, { exact: false })).toBeVisible({ timeout: 12_000 });

    await clickChangeAction(page, file, "Stage");
    await clickChangeAction(page, file, "Unstage");
    await clickChangeAction(page, file, "Stage");

    await page.getByRole("button", { name: "Commit" }).click();
    await expect(page.getByPlaceholder("Commit message")).toBeVisible({ timeout: 12_000 });
    await page.getByPlaceholder("Commit message").fill(`collie ui e2e ${runId}`);
    await page.getByRole("button", { name: "Tap to commit" }).click();
    await expect(page.getByText(/Committed\.|\[.*\]/i)).toBeVisible({ timeout: 12_000 });
    await expectNoHorizontalOverflow(page);
    await screenshot(page, "source-control-interactions");
  }),
);

await step("mobile UI worktree create form opens a fixture pane", async () =>
  withMobilePage(async (page) => {
    await openMobileRoute(page, "/worktrees", /Worktrees/i);
    await page.getByRole("button", { name: "New worktree" }).click();
    await expect(page.getByRole("dialog", { name: "New worktree" })).toBeVisible({ timeout: 12_000 });
    await page.getByLabel("Branch").fill(`collie-e2e/ui-${runId}`);
    await page.getByLabel("Label (optional)").fill(`ui e2e ${runId}`);
    await page.getByRole("button", { name: "Create worktree & open shell" }).click();
    await page.waitForURL(/\/pane\//, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 12_000 });
    await expectNoHorizontalOverflow(page);
    await screenshot(page, "worktree-create");
  }),
);

await step("mobile UI composer uploads an attachment and sends explicitly", async () =>
  withMobilePage(async (page) => {
    await openMobileRoute(page, paneRoutePath(), /VIEW|CONTROLS|Connecting|Not connected/i);
    await page.locator('input[type="file"][accept="image/*,text/*,application/pdf"]').setInputFiles(join("scripts", "e2e-fixtures", "note.txt"));
    await expect(page.getByLabel("Attachments")).toContainText("note.txt", { timeout: 12_000 });
    await expect(page.getByLabel("Attachments")).toContainText("Ready", { timeout: 12_000 });
    await page.getByPlaceholder(/Type a (shell command|reply)…/).fill(`printf 'collie-ui-send-${runId}\\n'\n: <<'COLLIE_E2E_ATTACHMENTS'`);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Sent ✓")).toBeVisible({ timeout: 12_000 });
    await expectAction(
      await jsonRequest<ActionResponse>(`/api/pane/${encodePath(paneId)}/keys`, {
        method: "POST",
        body: JSON.stringify({ keys: ["ctrl+c", "ctrl+u"] }),
      }),
      "composer attachment cleanup",
    );
    await expectNoHorizontalOverflow(page);
    await screenshot(page, "composer-upload-send");
  }),
);

await step("mobile UI live terminal takes control, sends input, resizes, and releases", async () =>
  withMobilePage(async (page) => {
    await openMobileRoute(page, paneRoutePath(), /VIEW|CONTROLS|Connecting|Not connected/i);
    await page.locator('button[aria-label="Live terminal"]').click();
    await expect(page.locator('button[aria-label="Show conversation"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("region", { name: "Live terminal" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Take control" }).click();
    await expect(page.getByText("control", { exact: true })).toBeVisible({ timeout: 12_000 });
    const marker = `live-${Date.now().toString(36)}`;
    await page.getByLabel("Mobile terminal input").fill(`printf '${marker}\\n'\n`);
    await page.getByRole("region", { name: "Live terminal" }).getByRole("button", { name: "Send" }).click();
    await waitForPaneText(marker);
    await page.getByRole("button", { name: "Increase terminal font" }).click();
    await page.setViewportSize({ width: 375, height: 667 });
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Release" }).click();
    await expect(page.getByRole("button", { name: "Take control" })).toBeVisible({ timeout: 12_000 });
    await screenshot(page, "live-terminal-control");
  }),
);

const failed = results.filter((result) => result.status === "FAIL");
const passed = results.filter((result) => result.status === "PASS");
const skipped = results.filter((result) => result.status === "SKIP");

console.log("");
console.log(`Collie mobile E2E: ${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed`);
for (const result of skipped) console.log(`SKIP ${result.name}: ${result.detail}`);
if (failed.length > 0) {
  for (const result of failed) console.error(`FAIL ${result.name}: ${result.detail}`);
  process.exit(1);
}
