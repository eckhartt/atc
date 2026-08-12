# Roadmap

Sequencing for the move from the MVP (single process, PTY passthrough) to the target architecture
(daemon/client). What each phase is for lives in [architecture](./architecture/overview.md); this
doc only tracks order, scope, and status. Each phase ships usable — atc never breaks for daily work
between phases.

## Phase 1 — subcommand entry and adapter extraction

Status: done

- Restructure the entrypoint into one CLI with subcommands: `atc` (client/UI), `atc hook-report`,
  `atc statusline` — the injected settings reference `process.execPath` subcommands instead of loose
  script paths.
- Extract everything Claude-specific (spawn args, `--settings` generation, resume semantics,
  transcript name-pulling, statusline chaining) into a `ClaudeAdapter` behind an interface.
- No behavior change. Unblocks `bun build --compile` single-binary distribution.

## Phase 2 — daemon/client split

Status: done · design: [daemon](./architecture/daemon.md), [protocol](./architecture/protocol.md)

- `atcd` owns PTYs, session state, and the hook socket; the TUI becomes a thin client speaking the
  wire protocol over a unix socket.
- tmux-style auto-spawn: the first `atc` invocation boots the daemon if absent.
- Per-client focus; a session can stream to several clients.
- SQLite (`bun:sqlite`) replaces the JSON state files, except `status.json`, which the injected
  statusline keeps reading directly.
- Fleet restore demotes to cold-boot recovery after daemon death.

Build order inside the phase (sequence matters more than the wire format):

1. Per-client outbound queue with short-write and `drain` handling, guarded by a loss test that
   blasts a slow reader and asserts zero loss — Bun's `socket.write()` silently drops what the
   kernel buffer won't take.
2. Correlation ids and the error shape.
3. Permission arbitration (first response wins, broadcast resolution, `already_answered`).
4. Attach/streaming with the jiggle-repaint fallback; screen-model replay arrives in phase 3 with
   zero wire changes.

## Phase 3 — screen model

Status: done

- Per-session vt state machine (`@xterm/headless`) in the daemon.
- Attach becomes instant screen replay; the resize-jiggle repaint dies.
- Unlocks toast compositing over live sessions and session previews.

## Phase 4 — attention and permissions

Status: done

- Permission request/response as first-class protocol messages, even while PTY sessions can't answer
  them structurally.
- Detector-stack interface in the adapter (hooks first, screen-state heuristics as the universal
  fallback) so non-Claude agents become an adapter, not a refactor.

## Phase 5 — futures

Status: unscoped

Named so earlier phases don't foreclose them; each gets its own scoping when it becomes real:

- SDK surface: headless Agent SDK sessions in the same inbox as PTY sessions, with structured
  permission approval from any client.
- Remote transport: the same protocol over TCP+auth or an SSH tunnel (work-machine daemon, laptop
  client).
- MCP exposure: daemon verbs as MCP tools so sessions can query and drive the fleet.
- Codex (or other CLI agent) adapter.
- Windows support beyond WSL (ConPTY via the PTY provider interface).
