import { basename } from 'node:path';
import { loadConfig } from './config';
import { collectDirs, formatDir, pickMatches, recordSpawn } from './dirs';
import { logEvent, startHookServer, writeHookSettings } from './hooks';
import { SessionManager, loadFleet } from './sessions';
import type { Session } from './sessions';
import { ansi, cols, drawHome, drawOverlay, drawPicker, drawStatusBar, rows } from './ui';

type Mode = 'home' | 'attached' | 'overlay' | 'picker-dir' | 'picker-name' | 'picker-prompt';

const config = loadConfig();
const settingsFile = writeHookSettings();

const mgr = new SessionManager(config, settingsFile);

let mode: Mode = 'home';
let overlaySelected = 0;
let confirmKill = false;
let confirmQuit = false;

// picker state carried across the dir -> name -> prompt steps
let allDirs: string[] = [];
let pickerInput = '';
let pickerSelected = 0;
let spawnDir = '';
let spawnName = '';
let spawnResume = false;
const stdout = process.stdout;

// Full height: the atc status bar only exists on home/overlay screens;
// attached sessions surface fleet state via Claude Code's own status line.
function ptyRows(): number {
  return Math.max(4, rows());
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleStatus() {
  if (statusTimer !== null) {
    return;
  }

  statusTimer = setTimeout(() => {
    statusTimer = null;

    if (mode !== 'attached') {
      drawStatusBar(mgr);
    }
  }, 50);
}

// Force Claude Code to repaint its whole UI after we've drawn over it or
// switched sessions: a resize down and back up triggers its redraw path.
function jiggle(s: Session) {
  if (s.pty === null) {
    return;
  }

  s.pty.resize(cols(), ptyRows() - 1);

  setTimeout(() => s.pty?.resize(cols(), ptyRows()), 60);
}

function attach(s: Session) {
  mgr.focusedId = s.id;
  s.unread = false;

  // Attaching answers the attention request: swapping to a session that
  // needs you clears its need state (a still-pending prompt re-flags it via
  // the next Notification).
  if (s.state === 'needs_you') {
    s.state = 'running';
    s.lastMsg = 'attached';
  }

  mgr.writeStatus();

  mode = 'attached';

  stdout.write(ansi.clear + ansi.showCursor);

  jiggle(s);
  scheduleStatus();
}

function toBase() {
  const f = mgr.focused;

  if (f !== null && f.pty !== null) {
    mode = 'attached';

    stdout.write(ansi.clear + ansi.showCursor);

    jiggle(f);
  } else {
    mode = 'home';

    drawHome(loadFleet().length);
  }

  scheduleStatus();
}

// fzf-style overlay search: null when inactive, the pattern while active.
let overlayFilter: string | null = null;

function pickOverlaySessions(): Session[] {
  const sorted = mgr.sortSessions();

  if (overlayFilter === null || overlayFilter === '') {
    return sorted;
  }

  const f = overlayFilter.toLowerCase();

  return sorted.filter((s) => `${s.name} ${formatDir(s.cwd)}`.toLowerCase().includes(f));
}

function renderOverlay() {
  const sessions = pickOverlaySessions();

  overlaySelected = Math.max(0, Math.min(overlaySelected, sessions.length - 1));

  drawOverlay({
    sessions,
    selected: overlaySelected,
    confirmKill,
    confirmQuit,
    filter: overlayFilter,
  });

  scheduleStatus();
}

function openOverlay() {
  mode = 'overlay';
  overlaySelected = 0;
  confirmKill = false;
  confirmQuit = false;
  overlayFilter = null;

  stdout.write(ansi.clear);

  renderOverlay();
}

function renderPicker() {
  const verb = spawnResume ? 'adopt' : 'spawn';

  if (mode === 'picker-dir') {
    const items = pickMatches(allDirs, pickerInput).map((d) => formatDir(d));

    pickerSelected = Math.min(pickerSelected, Math.max(0, Math.min(items.length, 10) - 1));

    drawPicker({
      title: `${verb}: directory`,
      items,
      selected: pickerSelected,
      input: pickerInput,
      hint: 'type to filter · ↑↓ move · ⏎ select · esc cancel',
    });
  } else if (mode === 'picker-name') {
    drawPicker({
      title: `${verb}: name`,
      items: [],
      selected: -1,
      input: pickerInput,
      placeholder: basename(spawnDir),
      hint: `session name for ${formatDir(spawnDir)} · ⏎ accept · esc back`,
    });
  } else {
    drawPicker({
      title: 'spawn: initial prompt',
      items: [],
      selected: -1,
      input: pickerInput,
      placeholder: 'optional — ⏎ to start interactive',
      hint: 'first message for the session · ⏎ spawn · esc back',
    });
  }

  scheduleStatus();
}

async function openDirPicker(resume = false) {
  spawnResume = resume;

  allDirs = await collectDirs();

  pickerInput = '';
  pickerSelected = 0;
  mode = 'picker-dir';

  stdout.write(ansi.clear);

  renderPicker();
}

function restoreFleet() {
  const fleet = loadFleet();

  if (fleet.length === 0) {
    return;
  }

  let first: Session | null = null;

  for (const entry of fleet) {
    // Skip entries already live (restore pressed twice, or partial fleet).
    const live = mgr.sessions.some((s) => s.pty !== null && s.claudeId === entry.claudeId);

    if (live) {
      continue;
    }

    const s = mgr.spawn(entry.cwd, entry.name, '', cols(), ptyRows(), entry.claudeId);

    first ??= s;
  }

  if (first !== null) {
    attach(first);
  }
}

function spawnFromPicker(prompt: string) {
  const name = spawnName === '' ? basename(spawnDir) : spawnName;

  recordSpawn(spawnDir);

  const namedBy = spawnName === '' ? 'auto' : 'user';
  const s = mgr.spawn(spawnDir, name, prompt, cols(), ptyRows(), spawnResume, namedBy);

  attach(s);
}

function quit(code = 0): never {
  mgr.killAll();

  try {
    server.stop(true);
  } catch {}

  stdout.write(ansi.showCursor + ansi.altScreenOff + ansi.reset);

  try {
    process.stdin.setRawMode(false);
  } catch {}

  process.exit(code);
}

function printSessionOutput(s: Session, data: string) {
  if (mode === 'attached' && mgr.focusedId === s.id) {
    stdout.write(data);
  }
}

function refreshScreens() {
  if (mode === 'overlay') {
    renderOverlay();
  }

  // Focused session died under us: surface the list instead of a dead screen.
  const f = mgr.focused;

  if (mode === 'attached' && f !== null && f.state === 'exited') {
    openOverlay();
  }

  scheduleStatus();
}

mgr.onOutput = printSessionOutput;
mgr.onChange = refreshScreens;

const server = startHookServer((e) => {
  // Statusline heartbeats would drown the log.
  if (e.event !== 'Statusline') {
    logEvent(e);
  }

  mgr.applyHook(e);
});

// Best-effort clipboard: OSC 52 (works through zellij/tmux/ssh) plus any
// local clipboard helper that exists.
function copyToClipboard(text: string) {
  stdout.write(`\u001B]52;c;${Buffer.from(text).toString('base64')}\u0007`);

  for (const cmd of [['clip.exe'], ['wl-copy'], ['xclip', '-selection', 'clipboard']]) {
    try {
      const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });

      void proc.stdin.write(text);
      void proc.stdin.end();
      break;
    } catch {}
  }
}

// ---- input ----

const KEY = {
  ctrlSpace: 0x00,
  ctrlC: 0x03,
  ctrlU: 0x15,
  esc: 0x1b,
  enter: 0x0d,
  backspace: 0x7f,
} as const;

function isUp(buf: Buffer): boolean {
  return buf.toString() === '\u001B[A' || buf.toString() === '\u001BOA';
}

function isDown(buf: Buffer): boolean {
  return buf.toString() === '\u001B[B' || buf.toString() === '\u001BOB';
}

function applyOverlayFilterKey(buf: Buffer): boolean {
  if (overlayFilter === null) {
    return false;
  }

  // esc clears the filter but stays in the overlay; enter falls through to
  // the normal handler so it attaches the selected match.
  if (buf[0] === KEY.esc && buf.length === 1) {
    overlayFilter = null;

    stdout.write(ansi.clear);

    renderOverlay();

    return true;
  }

  if (buf[0] === KEY.backspace) {
    overlayFilter = overlayFilter.slice(0, -1);

    stdout.write(ansi.clear);

    renderOverlay();

    return true;
  }

  if (buf[0] === KEY.ctrlU) {
    overlayFilter = '';

    stdout.write(ansi.clear);

    renderOverlay();

    return true;
  }

  if (buf[0] === KEY.enter || isUp(buf) || isDown(buf) || buf[0] === KEY.ctrlSpace) {
    return false;
  }

  const text = buf.toString();
  let printable = text.length > 0;

  for (const c of text) {
    if (c < ' ' || c === '\u007F') {
      printable = false;
      break;
    }
  }

  if (printable) {
    overlayFilter += text;

    stdout.write(ansi.clear);

    renderOverlay();

    return true;
  }

  return true;
}

function applyOverlayKey(buf: Buffer) {
  const filtered = pickOverlaySessions();
  const sel = filtered[overlaySelected];

  if (confirmKill || confirmQuit) {
    if (buf[0] === 0x79 /* y */) {
      if (confirmQuit) {
        quit();
      }

      if (confirmKill && sel !== undefined) {
        mgr.kill(sel.id);
      }
    }

    confirmKill = false;
    confirmQuit = false;

    renderOverlay();

    return;
  }

  if (applyOverlayFilterKey(buf)) {
    return;
  }

  if (buf.toString() === '/') {
    overlayFilter = '';
    overlaySelected = 0;

    stdout.write(ansi.clear);

    renderOverlay();

    return;
  }

  if (buf[0] === KEY.ctrlSpace || (buf[0] === KEY.esc && buf.length === 1)) {
    toBase();

    return;
  }

  if (isDown(buf) || buf.toString() === 'j') {
    overlaySelected = Math.min(filtered.length - 1, overlaySelected + 1);

    renderOverlay();

    return;
  }

  if (isUp(buf) || buf.toString() === 'k') {
    overlaySelected = Math.max(0, overlaySelected - 1);

    renderOverlay();

    return;
  }

  const ch = buf.toString();

  if (buf[0] === KEY.enter && sel !== undefined && sel.pty !== null) {
    attach(sel);

    return;
  }

  if (ch === 'a' && sel !== undefined) {
    mgr.ack(sel.id);

    renderOverlay();

    return;
  }

  if (ch === 'n') {
    void openDirPicker();

    return;
  }

  if (ch === 'r') {
    void openDirPicker(true);

    return;
  }

  if ((ch === 'y' || ch === 'Y') && sel !== undefined) {
    const cmd = mgr.buildResumeCommand(sel.id);

    if (cmd !== null) {
      copyToClipboard(cmd);

      sel.lastMsg = 'resume cmd copied';

      // Y is eject: hand the session off entirely.
      if (ch === 'Y') {
        mgr.kill(sel.id);
      }
    }

    renderOverlay();

    return;
  }

  if (ch === 'K' && sel !== undefined) {
    confirmKill = true;

    renderOverlay();

    return;
  }

  if (ch === 'q' || buf[0] === KEY.ctrlC) {
    if (mgr.sessions.some((s) => s.pty !== null)) {
      confirmQuit = true;

      renderOverlay();

      return;
    }

    quit();
  }
}

function applyTextKey(buf: Buffer, onSubmit: () => void, onCancel: () => void) {
  // Pasted chunks arrive as one buffer: split into per-char events so a
  // trailing newline still submits. Escape sequences stay intact.
  if (buf.length > 1 && buf[0] !== KEY.esc) {
    for (const ch of buf.toString()) {
      applyTextKey(Buffer.from(ch), onSubmit, onCancel);

      if (mode === 'attached' || ch === '\r') {
        return;
      }
    }

    return;
  }

  if (buf[0] === KEY.esc && buf.length === 1) {
    onCancel();

    return;
  }

  if (buf[0] === KEY.ctrlSpace) {
    toBase();

    return;
  }

  if (buf[0] === KEY.enter) {
    onSubmit();

    return;
  }

  if (buf[0] === KEY.backspace) {
    pickerInput = pickerInput.slice(0, -1);

    renderPicker();

    return;
  }

  if (buf[0] === KEY.ctrlU) {
    pickerInput = '';

    renderPicker();

    return;
  }

  if (mode === 'picker-dir') {
    if (isDown(buf)) {
      pickerSelected++;

      renderPicker();

      return;
    }

    if (isUp(buf)) {
      pickerSelected = Math.max(0, pickerSelected - 1);

      renderPicker();

      return;
    }
  }

  const text = buf.toString();
  let printable = true;

  for (const c of text) {
    if (c < ' ' || c === '\u007F') {
      printable = false;
      break;
    }
  }

  if (printable) {
    pickerInput += text;

    renderPicker();
  }
}

process.stdin.setRawMode(true);
process.stdin.resume();

// Stateful decode for the stdin -> PTY path: a multi-byte character split
// across two stdin reads must not be mangled by per-chunk toString().
const stdinDecoder = new TextDecoder('utf-8');

process.stdin.on('data', (buf: Buffer) => {
  switch (mode) {
    case 'attached': {
      if (buf[0] === KEY.ctrlSpace && buf.length === 1) {
        openOverlay();

        return;
      }

      const f = mgr.focused;

      f?.pty?.write(stdinDecoder.decode(buf, { stream: true }));

      return;
    }
    case 'home': {
      if (buf[0] === KEY.ctrlSpace) {
        openOverlay();

        return;
      }

      const ch = buf.toString();

      if (ch === 'n') {
        void openDirPicker();

        return;
      }

      if (ch === 'r') {
        void openDirPicker(true);

        return;
      }

      if (ch === 'R') {
        restoreFleet();

        return;
      }

      if (ch === 'q' || buf[0] === KEY.ctrlC) {
        if (mgr.sessions.some((s) => s.pty !== null)) {
          openOverlay();

          return;
        }

        quit();
      }

      return;
    }
    case 'overlay': {
      applyOverlayKey(buf);

      return;
    }
    case 'picker-dir': {
      applyTextKey(
        buf,
        () => {
          const items = pickMatches(allDirs, pickerInput);
          const raw = pickerInput.trim();
          let chosen = items[pickerSelected] ?? null;

          if (chosen === null && (raw.startsWith('/') || raw.startsWith('~'))) {
            chosen = raw.replace(/^~/u, process.env['HOME'] ?? '~');
          }

          if (chosen === null) {
            return;
          }

          spawnDir = chosen;
          pickerInput = '';
          mode = 'picker-name';

          stdout.write(ansi.clear);

          renderPicker();
        },
        () => {
          toBase();
        },
      );

      return;
    }
    case 'picker-name': {
      applyTextKey(
        buf,
        () => {
          spawnName = pickerInput.trim();
          pickerInput = '';

          // Adopt skips the prompt step: claude --resume opens its own
          // session picker inside the new PTY.
          if (spawnResume) {
            spawnFromPicker('');

            return;
          }

          mode = 'picker-prompt';

          stdout.write(ansi.clear);

          renderPicker();
        },
        () => {
          pickerInput = '';
          mode = 'picker-dir';

          stdout.write(ansi.clear);

          renderPicker();
        },
      );

      return;
    }
    case 'picker-prompt': {
      applyTextKey(
        buf,
        () => {
          spawnFromPicker(pickerInput.trim());
        },
        () => {
          pickerInput = '';
          mode = 'picker-name';

          stdout.write(ansi.clear);

          renderPicker();
        },
      );
    }
  }
});

stdout.on('resize', () => {
  const f = mgr.focused;

  f?.pty?.resize(cols(), ptyRows());

  if (mode === 'home') {
    drawHome(loadFleet().length);
  }

  if (mode === 'overlay') {
    stdout.write(ansi.clear);

    renderOverlay();
  }

  if (mode.startsWith('picker')) {
    stdout.write(ansi.clear);

    renderPicker();
  }

  scheduleStatus();
});

process.on('uncaughtException', (err) => {
  stdout.write(ansi.showCursor + ansi.altScreenOff + ansi.reset);

  try {
    process.stdin.setRawMode(false);
  } catch {}

  console.error(err);
  process.exit(1);
});

process.on('SIGTERM', () => quit());
process.on('SIGHUP', () => quit());

// ---- start ----
stdout.write(ansi.altScreenOn);

drawHome(loadFleet().length);
drawStatusBar(mgr);
