# Security contracts for workspace extensions

This document defines the security boundary for the worktree, terminal, file, Git, upload,
and blocking-message APIs. It extends, and does not replace, the load-bearing controls in
[ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model).

## Implemented scope

Worktree list/create/open, terminal observe/control, file listing/preview, Git status/diff/stage/
unstage/commit, and multipart uploads are implemented. Blocking questions are captured on agent
transitions and exposed in snapshots and notification bodies. Git log/branch and the standalone
`/api/blocking-message` route remain gated `501 Not Implemented` stubs; the UI does not use them.

## Request gates and exposure

- The existing Host allowlist and same-origin check apply to every new HTTP and WebSocket handshake.
- Read-only operations may pass the existing read gate: worktree/file/Git inspection, terminal
  observation, and blocking-message reads.
- Terminal control, worktree creation, Git mutations, and uploads additionally require the existing
  per-device write authorization. Missing or non-allowlisted device identity remains read-only.
- Every implemented mutation records a bounded, newline-safe action in the existing owner-only
  append-only audit log. Secrets, file contents, terminal input, and full commit messages must not be
  copied into audit details.
- The bridge continues to bind to loopback only. The supported default ingress is tailnet-only
  HTTPS through Tailscale Serve; Tailscale Funnel and any other public exposure are forbidden.

## Terminal rendering boundary

Raw terminal frames must be parsed by xterm.js as terminal data. Application code must not convert
ANSI output into HTML, interpolate it into markup, assign it through `innerHTML`, or inject it into
an HTML-rendering API. The existing strict Content Security Policy remains in force. Terminal
WebSocket handshakes require a valid same-origin `Origin`. Observation and control are explicit
modes: observation remains read-only, while control uses the write gate above. Only one controller
may own a pane at a time; implementations must bound buffering, apply backpressure, and release
ownership cleanly on disconnect.

## Git execution allowlist

Git handlers spawn `git` directly with an argv array and a fixed working directory. They never use a
shell, accept a command string, or pass user-controlled environment configuration. The complete
subcommand allowlist is:

- `status`: status inspection only, with server-selected machine-readable flags.
- `diff`: working-tree or staged diff only; optional validated pathspecs follow `--`.
- `add` (the stage operation): validated pathspecs only, following `--`.
- `restore --staged` (the unstage operation): validated pathspecs only, following `--`. An
  implementation may use an equivalent non-destructive index-only unstage form.
- `commit`: a server-constructed `commit -m <message>` argv; the message is one argv value, never
  command text.
- `log`: history inspection only, with server-selected bounded-output flags.
- `branch`: branch listing or `--show-current` only; branch creation, deletion, rename, and checkout
  are outside the allowlist.

All other subcommands and unrecognised flags are rejected before process creation. In particular,
`push`, `clean`, `reset --hard`, hooks or aliases as command substitutes, arbitrary executables, and
all shell commands are forbidden. A request cannot supply `-C`, `-c`, `--exec-path`, repository
paths, output paths, pager/editor settings, or another global Git option.

## Workspace path containment

File-read and Git path inputs are relative to the selected workspace root. Reject absolute paths,
NUL bytes, and any `..` segment before normalization. Resolve the workspace root and each existing
target with `realpath`, and accept a target only when the result is the root itself or has the root
plus the platform path separator as its prefix. This common-root check must be path-aware, not a raw
string-prefix test. Symlinks that resolve outside the workspace are rejected. Git pathspecs pass the
same validation before entering argv. These APIs do not create arbitrary workspace files.

Uploads never accept a workspace destination. They write only a server-chosen filename beneath the
isolated staging root described below.

## Upload handling

- The maximum file size is 10 MiB, enforced before and after multipart parsing.
- The compose/send flow accepts at most five attachments per message.
- Uploads live in an isolated owner-only (`0700`) staging directory; created files are owner-only
  and never served as executable content.
- The server chooses a collision-resistant filename. Client filenames are metadata only and never
  become a path.
- Uploaded bytes are data only: the bridge does not execute them, source them, expand archives, run
  format handlers, or infer commands from their contents.
- Staged uploads use the existing shared 48-hour retention policy, with pruning at startup and every
  six hours without following symlinks. This intentionally preserves the existing image-upload
  lifecycle instead of the feature plan's proposed 24-hour policy. Removing an attachment cancels
  pending transfer and excludes its path from the message; already stored bytes expire through this
  shared sweep.

These rules apply in addition to MIME and size validation already used by pane image uploads.
