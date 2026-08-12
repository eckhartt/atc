# atc

Control tower for Claude Code sessions. Hosts stock `claude` instances in PTYs
behind a keyboard-driven session list with hook-driven attention routing —
no panes, no tiling, no mouse.

## Run

```sh
bun src/index.ts   # or `atc` if bin/atc is on your PATH
```

Runs fine nested inside zellij/tmux (give the pane locked mode so Ctrl-Space
reaches atc).

## Keys

| Key | Where | Action |
| --- | --- | --- |
| `Ctrl-Space` | anywhere | toggle session overlay |
| `n` | home/overlay | spawn: pick dir (zoxide + history, fuzzy) → name → optional first prompt |
| `r` | home/overlay | adopt: pick dir → name → `claude --resume` (Claude's session picker opens in the new PTY) |
| `R` | home | restore last fleet — respawns every session from `fleet.json` via `claude --resume <id>` |
| `j`/`k`/`↑`/`↓` | overlay/picker | move |
| `Enter` | overlay | attach (auto-acks) |
| `a` | overlay | ack notification without attaching |
| `y` | overlay | yank `cd <dir> && claude --resume <id>` to clipboard (OSC 52 + clip.exe/wl-copy/xclip) |
| `Y` | overlay | eject: yank the resume command, then kill the session here — paste it in any pane to take over |
| `K` | overlay | kill selected (confirm with `y`) |
| `q` | home/overlay | quit (confirm if sessions live) |

Everything else is passed through to the focused Claude session, which owns
the full screen. Fleet state renders inside Claude Code's own status line
(injected via the same `--settings` file): your configured statusline runs
first, and atc appends `▏● 2 need you: auth-bug`. atc draws its own status
bar only on the home and overlay screens.

## How state tracking works

Spawned sessions get a `--settings` file injecting `Notification`, `Stop`,
`UserPromptSubmit`, and `SessionEnd` hooks that report to a unix socket
(`$XDG_RUNTIME_DIR/atc.sock`). Your global Claude settings are untouched;
sessions you start outside atc are unaffected. States: red `●` needs you,
cyan `◐` running, green `✓` turn done, gray `✗` exited. The overlay sorts
needs-you first; the status bar turns red and names the most urgent session.

## Config

`~/.config/atc/config.json`:

```json
{ "claudeBin": "claude", "claudeArgs": [] }
```

`claudeArgs` is prepended to every spawn (e.g. `["--model", "opus"]`).
Spawn-dir history, `fleet.json`, `status.json` (read by the injected
statusline), and `events.log` (one JSON line per received hook event, for
debugging state issues) live in `~/.local/state/atc/`.

## Crash safety

atc continuously writes the live fleet (name, cwd, Claude session id) to
`fleet.json`. If atc dies — crash, SIGKILL, closed window — the child claude
processes die with it, but every session's transcript is already on disk.
Restart atc and press `R`: the whole fleet respawns via `claude --resume`.
Only deliberate kills (`K`, `Y` eject) remove entries from the fleet file, so
quitting atc also leaves a restorable fleet for next time.
