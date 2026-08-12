# Architecture overview

atc is a single Bun process that multiplexes Claude Code sessions without a tiling layout engine:
one focused session owns the whole terminal, and everything else is reached through a
keyboard-driven overlay. The design bet is that the pain of many-session work is attention routing,
not window management.

## Process model

```
terminal ──> atc (src/index.ts)
              ├── PTY per session ──> claude --settings <generated>
              ├── unix socket server (hook + statusline reports)
              └── state files in ~/.local/state/atc/
```

- Each session is a `claude` child process on its own PTY (`bun-pty`). The focused session's bytes
  pass through raw to the terminal; background output is discarded (Claude repaints on attach,
  forced by a resize jiggle).
- There is no vt screen model yet. Attach fidelity relies on Claude Code redrawing itself on
  SIGWINCH. This is the known MVP tradeoff; a daemon/client split with a per-session screen model is
  the planned next architecture (to be specced separately).
- `src/sessions.ts` is the state machine: session states are `running`, `needs_you`, `done`,
  `exited`, each with an `unread` attention flag.

## Claude integration

Sessions are instrumented via a generated settings file passed as `claude --settings`:

- Hooks (`SessionStart`, `Notification`, `Stop`, `UserPromptSubmit`, `SessionEnd`) run
  `src/hook-report.ts`, which forwards the event JSON to atc's unix socket. `SessionStart` carries
  the Claude session id at spawn/resume time, which is what makes the fleet restorable before any
  interaction.
- The statusline command (`src/statusline.ts`) chains the user's own configured statusline, then
  appends the fleet segment read from `status.json`, so fleet state renders inside Claude Code's own
  status line while attached. Its stdin JSON is also heartbeated to the socket as a second
  id-capture path.
- Session names are pulled from Claude's transcripts (`custom-title` lines from `/rename`, `summary`
  lines as fallback) — atc is not the naming authority.

## State files

All in `~/.local/state/atc/`:

| File                 | Purpose                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet.json`         | Live fleet (name, cwd, Claude session id). Rewritten on deliberate kills only, so any crash or quit leaves a restorable fleet for `R`. |
| `status.json`        | Counts + most urgent session, read by the injected statusline on each render.                                                          |
| `events.log`         | One JSON line per received hook event (statusline heartbeats excluded), for debugging state issues.                                    |
| `spawn-history.json` | Directories previously spawned from, merged with zoxide's frecency list in the spawn picker.                                           |

## Recovery model

atc's children die with it (PTY close → SIGHUP), but Claude streams transcripts to disk
continuously, so sessions are data, not processes. `claude --resume <id>` reconstructs any of them;
the fleet file makes that a single keypress after a crash. The same mechanism powers adopt (`r`) and
yank/eject (`y`/`Y`).
