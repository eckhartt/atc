# atc

atc is a terminal control tower for Claude Code sessions: a single Bun process that hosts stock
`claude` instances in PTYs behind a keyboard-driven session list with hook-driven attention routing.
No panes, no tiling, no mouse. See `docs/architecture/overview.md` for how the pieces fit; the
README documents keys and user-facing behavior.

## Layout

Single package, no workspaces. `src/` holds the app (one primary export or entry concern per file),
`test/` holds the PTY-driven e2e suite, `bin/atc` is the executable shim. `scripts/` holds repo
tooling, not app code.

## Runtime rules

- Bun only. `bun test`, never vitest or jest. `bun <file>`, never node or ts-node.
- PTYs come from `bun-pty`. Never add `node-pty`: its fd-socket plumbing delivers no data events
  under Bun.
- The TUI is hand-rolled ANSI on purpose — no TUI framework until the daemon/screen-model
  architecture lands. Escape sequences are written as `\u001B` escapes, never raw bytes and never
  `\x1b`.
- Everything the hooks and CI run is a root `package.json` script; invoke gates by script name,
  never by re-spelling the underlying command.

## Claude integration contract

- Wrangled sessions are instrumented only via the generated `--settings` file (`writeHookSettings`):
  hooks (`SessionStart`, `Notification`, `Stop`, `UserPromptSubmit`, `SessionEnd`) and a chained
  statusline. Never touch the user's own Claude settings.
- Hook and statusline reporters run inside the wrangled session and must always exit 0 — a broken
  reporter must never break the session it reports on.
- Claude is the naming authority for sessions: `/rename` custom-titles beat user-typed names beat
  auto-summaries.
- State files live in `~/.local/state/atc/` (`fleet.json`, `status.json`, `events.log`,
  `spawn-history.json`). `fleet.json` is rewritten on deliberate kills only, so crashes leave a
  restorable fleet.

## Function naming — project verbs

Project additions to the shared taxonomy (keep in sync with `zgeoff/function-verb` in
`.oxlintrc.json`): `ack`, `adopt`, `attach`, `boot`, `copy`, `draw`, `jiggle`, `kill`, `log`,
`open`, `quit`, `record`, `refresh`, `restore`, `schedule`, `spawn`, `truncate`, `yank`.

Exempt names (tiny geometry/row helpers and script entrypoints): `cols`, `rows`, `ptyRows`, `out`,
`main`, `boxTop`, `boxDivider`, `boxBottom`, `boxRow`, `dimRow`.

## Testing

- The suite is end-to-end by design: `test/e2e.test.ts` boots the real TUI inside a `bun-pty`
  pseudo-terminal, drives it with keystrokes, and asserts on screen bytes. A fake `claude` bash
  script stands in for the real binary and emits hook events through the real reporter.
- Each test gets a fresh temp `$HOME` via `beforeEach` — the per-test isolation is deliberate
  because tests exercise on-disk state (`fleet.json`, config, transcripts).
- Flat `test('…')` blocks with behavioral titles; no `describe`.
- Never spawn the real `claude` binary in tests; verification against real Claude Code happens
  manually before merging changes to the integration contract.

## Dependencies

- Exact pins only (bunfig `exact = true`); the 7-day `minimumReleaseAge` gate applies. When the
  latest version is younger than the gate, pin the newest version that passes — don't add exclusions
  for convenience.
- A dependency knip can't see gets its `knip.json` ignore entry in the same PR that introduces it,
  with the reason in the PR description.
