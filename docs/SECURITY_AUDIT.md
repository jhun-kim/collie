# Security audit — Collie Orca feature plan todo 17

Date: 2026-09-07  
Reviewer lane: security/regression review  
Verdict: **APPROVE**

This audit covers the bridge blocking-capture work, web worktree/live-terminal/file/Git/attachments/question UI, and the existing/new bridge file, Git, upload, and terminal boundaries listed in `.omo/plans/collie-orca-features.md` todo 17.

No critical, high, or medium security blocker was found in the current implementation. The previous worktree resolver typecheck blocker is fixed, the source-control/worktree/file late-fetch guards are present, and `docs/SECURITY_EXTENSIONS.md` now reflects live routes plus the intentional 48-hour upload sweep reused from existing uploads.

## Findings

### Blockers

None.

### Notes / follow-up

- `bridge/index.ts:145` logs only the pane id when a blocking message is captured. It does not log the question text. This is an intentional diagnostic tied to the Todo 8 acceptance that captured blocking messages are surfaced, so it is not treated as a security finding.
- One full `web` test run initially produced a single `Composer — attachments` status assertion failure, while `composer.test.tsx` alone passed and the immediately repeated full `web` run passed. I am recording this as a non-blocking flaky-test observation because it did not reproduce and the targeted attachment tests are not in the security-critical write-gate path for this audit.
- The lsp diagnostics tool was not exposed in this execution environment. TypeScript `tsc --noEmit`, targeted Vitest/Bun suites, full bridge/web suites, and static scans were used as the review substitutes.

## Checks performed

### Stage 1 — Spec and security-contract compliance

Result: **pass**

- Todo 17 requires XSS review, write-gate coverage, audit events, command-injection review, path traversal review, and a written audit report. This document is the written audit report.
- `docs/SECURITY_EXTENSIONS.md` now documents implemented scope instead of the old all-501 stub state: worktrees, terminal observe/control, file listing/preview, Git status/diff/stage/unstage/commit, multipart upload, and blocking-message snapshot/notification integration are live; Git log/branch and standalone `/api/blocking-message` remain gated 501 stubs.
- The upload retention statement is now aligned with current code: existing shared 48-hour retention with a 6-hour sweep is intentional (`docs/SECURITY_EXTENSIONS.md:76`, `bridge/uploads.ts:10`).

### Origin, device, session, and workspace gates

Result: **pass**

- Bridge write gates are centralized through `guard(req, cfg, "write")`; writes require both request access and an authorized device (`bridge/server.ts:1019`).
- Worktree create/open are write-gated before handler dispatch and use the selected session runtime (`bridge/server.ts:1051`).
- File routes are read-only GET routes, session-scoped by registry lookup, and rooted from the selected workspace's current pane cwd (`bridge/server.ts:1098`).
- Git status/diff are reads; stage/unstage/commit are writes with device attribution and audit after successful mutation (`bridge/server.ts:1147`, `bridge/server.ts:1260`).
- Terminal observation/control are explicit WebSocket modes; control uses the write gate and terminal origin validation (`bridge/server.ts:157`).
- Source-control late status/diff/mutation completions are scoped with `activeKey` containing workspace and session (`web/src/routes/source-control.tsx:126`, `web/src/routes/source-control.tsx:214`).
- Worktree route late create/open completions and root revalidation paths are covered by passing tests in `web/src/routes/worktrees.test.tsx`.
- Files route lazy expand/open/preview fetches are covered by passing tests in `web/src/routes/files.test.tsx`.

QA server read-only/blocked probes against `http://127.0.0.1:8794`:

```text
GET /api/snapshot with QA device: 200
GET /api/snapshot from blocked Origin: 403
POST /api/git/stage as read-only device: 403
POST /api/worktrees as read-only device: 403
POST /api/upload as read-only device: 403
GET /ws/terminal/... from blocked Origin: 403
GET /ws/terminal/... mode=control as read-only device: 403
```

No authorized production write was sent by this reviewer.

### Audit-log evidence

Result: **pass for event presence**

The QA audit log tail at `/tmp/collie-mobile-qa.jKnSiD/state/audit.log` contained these action counts in the last 80 lines:

```text
file.upload: 6
git.commit: 5
git.stage: 10
git.unstage: 5
terminal.control: 1
worktree.create: 6
```

This confirms the live QA environment is emitting the expected write-action event types. I did not create new authorized writes for this audit.

### XSS, terminal rendering, links, and CSP-sensitive paths

Result: **pass**

- Static scan found no source use of `dangerouslySetInnerHTML`, `.innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or shell execution in the reviewed bridge/web source. The only `dangerouslySetInnerHTML` match is a defensive comment in `web/src/components/markdown-text.tsx`.
- Terminal data reaches xterm via `term.write(decodeTerminalFrame(message))` after the client parser requires `type: "terminal.frame"`, `encoding: "ansi"`, and base64 bytes (`web/src/components/live-terminal.tsx:122`, `web/src/lib/live-terminal.ts:71`).
- The current LiveTerminal implementation uses actual xterm types, `localTerminal.parser.registerOscHandler(52, () => true)`, and an `onFallback` ref. This handles OSC 52 through xterm's parser API; the audit should not claim OSC is blocked before parsing (`web/src/components/live-terminal.tsx:73`, `web/src/components/live-terminal.tsx:205`).
- xterm starts with `disableStdin: true`; native stdin is set to `false` only when the user explicitly takes control and restored on release/control-drop (`web/src/components/live-terminal.tsx:195`, `web/src/components/live-terminal.tsx:278`).
- WebLinks opens only `http`/`https` URLs and uses `noopener,noreferrer` (`web/src/components/live-terminal.tsx:52`).
- Markdown, filenames, Git paths, terminal/question text, and file preview content render through React text nodes or structured React elements, not HTML injection (`web/src/components/markdown-text.tsx:6`, `web/src/components/file-preview.tsx`).

### Terminal control lease and input flow

Result: **pass**

- Terminal handshake parses explicit observe/control modes and bounded dimensions (`bridge/terminal-protocol.ts:59`).
- Observe mode rejects every client command; control input accepts exactly one text/base64 payload and enforces the 1 MiB input limit (`bridge/terminal-protocol.ts:103`).
- The terminal proxy allows multiple observers, reserves one controller per socket/pane, audits only after a valid first control frame, rejects malformed/binary client messages, applies backpressure behavior, and releases lease on close/disposal (`bridge/terminal-proxy.ts`).
- Targeted terminal protocol/proxy/route/Bun integration tests passed.

### Command injection and Git allowlist

Result: **pass**

- Git subcommands are restricted to `status`, `diff`, `add`, `reset`, and `commit` (`bridge/git-ops.ts:15`).
- Git pathspec magic (`:`), absolute paths, `..`, and NUL bytes are rejected before entering argv (`bridge/git-ops.ts:116`, `bridge/file-ops.ts:141`).
- Stage, unstage, and commit build fixed argv arrays and pass file paths after `--`; commit message is one argv value (`bridge/git-ops.ts:224`).
- Static scans found no source `shell: true` or shell-command construction in the reviewed handlers. Markdown fixture-note matches from broad scans were false positives, not executable source.

### File path traversal, symlink, and bounds

Result: **pass for implemented checks**

- File paths are parsed as workspace-relative only; absolute paths, NUL bytes, and `..` are rejected (`bridge/file-ops.ts:141`).
- Requested path components are checked with `lstat`, and symlink components are refused (`bridge/file-ops.ts:175`).
- Listings are bounded by depth and total entry count; file previews are capped at 1 MiB (`bridge/file-ops.ts:95`, `bridge/file-ops.ts:327`).
- File operation tests cover traversal rejection, symlink refusal, binary refusal, oversized preview refusal, and entry cap truncation.

Residual note: this lane did not build a hostile filesystem race harness to swap entries between `readdir`/`lstat`/`readFile`. Static code and tests cover normal traversal/symlink/bounds behavior.

### Upload MIME, size, storage, and expiry

Result: **pass**

- `POST /api/upload` is write-gated before `handleUpload` (`bridge/server.ts:220`).
- The upload handler enforces declared and parsed size limits, MIME allowlist, owner-only upload directory creation, server-chosen saved names, and audit after successful save (`bridge/upload.ts:84`, `bridge/upload.ts:100`, `bridge/upload.ts:109`, `bridge/upload.ts:119`).
- The compose/send flow accepts at most five attachments per message, and target composer tests pass in isolation.
- Upload pruning uses the intentional shared 48-hour TTL with a 6-hour sweep (`bridge/uploads.ts:10`, `docs/SECURITY_EXTENSIONS.md:76`).

### Blocking capture and notification race behavior

Result: **pass**

- Blocking capture stores per-pane generations and clears/ignores stale captures when a pane resolves or disappears (`bridge/blocking-capture.ts`).
- Snapshot enrichment reads the capture store additively without mutating engine state (`bridge/server.ts:1033`).
- Notification bodies use captured blocking question text only when available and fall back to the pane-specific wording when capture fails.
- The read-failure fallback is acceptable because it keeps notification delivery alive, does not suppress the pane state transition, and is covered by regression tests.

## Validation evidence

Commands run from `/Users/chai/Documents/GitHub/herdr_mobile`:

```text
bun run typecheck
=> pass

cd web && bun run typecheck
=> pass

bun test ./bridge/blocking-capture.test.ts ./bridge/file-ops.test.ts ./bridge/git-ops.test.ts ./bridge/upload.test.ts ./bridge/terminal-protocol.test.ts ./bridge/terminal-proxy.test.ts ./bridge/terminal-route.test.ts ./bridge/terminal-bun.integration.test.ts ./bridge/worktree-routes.test.ts ./bridge/sessions.test.ts
=> 190 pass, 0 fail, 355 expect() calls

cd web && bun run test -- src/components/live-terminal.test.tsx src/lib/live-terminal.test.ts src/routes/files.test.tsx src/routes/source-control.test.tsx src/routes/worktrees.test.tsx src/components/agent-chat.test.tsx
=> 6 passed, 63 tests passed

bun test ./bridge
=> 548 pass, 0 fail, 1027 expect() calls

cd web && bun run test -- src/components/composer.test.tsx
=> 1 passed, 44 tests passed

cd web && bun run test
=> first run: 1 transient failure in Composer attachments status assertion
=> immediate rerun: 93 passed, 1099 tests passed
```

Static scans run:

```text
rg -n 'dangerouslySetInnerHTML|\.innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|shell:\s*true|Bun\.spawn\(\s*[`"'"']' bridge web/src
ast-grep --pattern 'console.log($$$ARGS)' bridge web/src
ast-grep --pattern 'catch ($E) { }' bridge web/src
ast-grep --pattern 'catch { }' bridge web/src
ast-grep --pattern 'apiKey = "$VALUE"' bridge web/src
ast-grep --pattern 'shell: true' bridge web/src
```

No blocker was found by the static scans. Existing console logs and the intentional pane-id-only blocking diagnostic remain non-blocking. Broad `ast-grep` matches under Markdown fixture notes are not executable source findings.

## Not verified in this lane

- Browser, terminal, and fixture pane UI were not manipulated, per reviewer-lane instructions.
- Authorized production write probes were not sent by this reviewer.
- Launchd deployment and actual E2E ownership remain with the root/owner lane.
- CSP behavior was reviewed statically through server headers and terminal rendering code; no browser CSP report was captured by this lane.
- A dedicated hostile local filesystem TOCTOU race harness was not run.
