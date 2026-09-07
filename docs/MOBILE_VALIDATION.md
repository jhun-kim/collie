# Mobile workspace feature validation

The 18-task feature plan's bridge and frontend implementation is present. Automated validation uses
an isolated Herdr session, a temporary Git repository, and a loopback-only fixture bridge. Existing
user panes and repositories are excluded from the mutating E2E run.

| Capability | Evidence |
| --- | --- |
| Worktree list/create/open and blocked-first cards | Bridge/route unit tests; live API creation and mobile form submission |
| Live terminal observe/control/input/resize/release | Protocol/proxy/component tests; actual Herdr output after mobile input |
| File tree and text/Markdown/image preview | Containment and size tests; mobile folder navigation and preview |
| Git diff/stage/unstage/commit | Argument/path/write-gate tests; live API and mobile UI commits in the fixture repo |
| Multiple photo/file attachments | Upload/queue/error/retry tests; browser upload and explicit composer Send |
| Blocking questions and notifications | Capture-generation and notification-body tests; live blocked snapshot and dashboard-to-pane navigation |
| Existing replies, special keys, prompts, and session scope | Full bridge and web regression suites; live fixture reply/key checks |
| macOS auto-start | Fake launchctl lifecycle tests; native deployment validation recorded in local task 18 evidence |

On 2026-09-07, the full bridge suite passed 548 tests plus the lifecycle shell suite. The full web
suite passed 1,099 tests before the final connection-recovery additions; those additions have
targeted component coverage. Chromium and WebKit each passed all 18 mobile/API E2E checks with no
skips. Both TypeScript configurations and the PWA build passed. Oxlint reported no errors and ten
pre-existing warnings. See [the security audit](SECURITY_AUDIT.md) for the reviewed boundaries.

Run `bun run test`, `cd web && bun run test`, `bun run typecheck`, `bun run lint`, and
`bun run build` for local validation. `bun run test:mobile` requires the explicit disposable fixture
environment documented at the top of [mobile-e2e.ts](../scripts/mobile-e2e.ts). It aborts before
mutation unless the URL is loopback and the selected pane belongs to the temporary repository.

## Known limits and plan adjustments

- Physical iPhone home-screen installation, standalone camera capture, OS Web Push delivery/tap,
  and a real host reboot were not exercised by browser automation. These remain the device-dependent
  part of task 18; automated checks must not be interpreted as evidence that those steps ran.
- Worktree cards show the last successful refresh time as **Updated**. Herdr does not provide a
  per-worktree activity timestamp in the current snapshot. Git badges are available for open
  workspace checkouts; a closed worktree can be opened to inspect its Git state.
- General file uploads share the existing image-upload directory and 48-hour retention policy,
  pruned on startup and every six hours, preserving that lifecycle instead of adding a 24-hour one.
- Source files are previewed as safe monospace text; Markdown uses the existing text-node renderer.
- Git log/branch and the standalone blocking-message route remain gated 501 scaffolds. The shipped
  UI uses the implemented Git operations and snapshot/push question fields.
- No browser view, account/usage panel, QR pairing, Git push/delete/force UI, or public Funnel ingress
  was added. The fork remains compatible with ordinary spaces and the existing dashboard.

Local `.omo/evidence/task-*-collie-orca-features.txt` files and their screenshots retain the
task-specific execution records without publishing machine configuration or fixture output.
