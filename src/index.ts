import { basename } from "node:path";
import { loadConfig } from "./config";
import { candidateDirs, displayDir, fuzzyFilter, recordSpawn } from "./dirs";
import { logEvent, startHookServer, writeHookSettings } from "./hooks";
import { loadFleet, SessionManager, type Session } from "./sessions";
import {
  ansi,
  cols,
  drawHome,
  drawOverlay,
  drawPicker,
  drawStatusBar,
  rows,
} from "./ui";

type Mode = "home" | "attached" | "overlay" | "picker-dir" | "picker-name" | "picker-prompt";

const config = loadConfig();
const settingsFile = writeHookSettings();
const mgr = new SessionManager(config, settingsFile);

let mode: Mode = "home";
let overlaySelected = 0;
let confirmKill = false;
let confirmQuit = false;

// picker state carried across the dir -> name -> prompt steps
let allDirs: string[] = [];
let pickerInput = "";
let pickerSelected = 0;
let spawnDir = "";
let spawnName = "";
let spawnResume = false;

const stdout = process.stdout;

// Full height: the atc status bar only exists on home/overlay screens now;
// attached sessions surface fleet state via Claude Code's own status line.
function ptyRows(): number {
  return Math.max(4, rows());
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleStatus() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    if (mode !== "attached") drawStatusBar(mgr);
  }, 50);
}

// Force Claude Code to repaint its whole UI after we've drawn over it or
// switched sessions: a resize down and back up triggers its redraw path.
function jiggle(s: Session) {
  if (!s.pty) return;
  s.pty.resize(cols(), ptyRows() - 1);
  setTimeout(() => s.pty?.resize(cols(), ptyRows()), 60);
}

function attach(s: Session) {
  mgr.focusedId = s.id;
  s.unread = false;
  mode = "attached";
  stdout.write(ansi.clear + ansi.showCursor);
  jiggle(s);
  scheduleStatus();
}

function toBase() {
  const f = mgr.focused;
  if (f && f.pty) {
    mode = "attached";
    stdout.write(ansi.clear + ansi.showCursor);
    jiggle(f);
  } else {
    mode = "home";
    drawHome(loadFleet().length);
  }
  scheduleStatus();
}

function renderOverlay() {
  drawOverlay({ sessions: mgr.sorted(), selected: overlaySelected, confirmKill, confirmQuit });
  scheduleStatus();
}

function openOverlay() {
  mode = "overlay";
  overlaySelected = 0;
  confirmKill = false;
  confirmQuit = false;
  stdout.write(ansi.clear);
  renderOverlay();
}

function renderPicker() {
  const verb = spawnResume ? "adopt" : "spawn";
  if (mode === "picker-dir") {
    const items = fuzzyFilter(allDirs, pickerInput).map(displayDir);
    pickerSelected = Math.min(pickerSelected, Math.max(0, Math.min(items.length, 10) - 1));
    drawPicker({
      title: `${verb}: directory`,
      items,
      selected: pickerSelected,
      input: pickerInput,
      hint: "type to filter · ↑↓ move · ⏎ select · esc cancel",
    });
  } else if (mode === "picker-name") {
    drawPicker({
      title: `${verb}: name`,
      items: [],
      selected: -1,
      input: pickerInput,
      placeholder: basename(spawnDir),
      hint: `session name for ${displayDir(spawnDir)} · ⏎ accept · esc back`,
    });
  } else {
    drawPicker({
      title: "spawn: initial prompt",
      items: [],
      selected: -1,
      input: pickerInput,
      placeholder: "optional — ⏎ to start interactive",
      hint: "first message for the session · ⏎ spawn · esc back",
    });
  }
  scheduleStatus();
}

async function openDirPicker(resume = false) {
  spawnResume = resume;
  allDirs = await candidateDirs();
  pickerInput = "";
  pickerSelected = 0;
  mode = "picker-dir";
  stdout.write(ansi.clear);
  renderPicker();
}

function restoreFleet() {
  const fleet = loadFleet();
  if (fleet.length === 0) return;
  let first: Session | null = null;
  for (const entry of fleet) {
    // Skip entries already live (restore pressed twice, or partial fleet).
    if (mgr.sessions.some((s) => s.pty && s.claudeId === entry.claudeId)) continue;
    const s = mgr.spawn(entry.cwd, entry.name, "", cols(), ptyRows(), entry.claudeId);
    first ??= s;
  }
  if (first) attach(first);
}

function doSpawn(prompt: string) {
  const name = spawnName || basename(spawnDir);
  recordSpawn(spawnDir);
  const s = mgr.spawn(spawnDir, name, prompt, cols(), ptyRows(), spawnResume);
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

mgr.onOutput = (s, data) => {
  if (mode === "attached" && mgr.focusedId === s.id) stdout.write(data);
};

mgr.onChange = () => {
  if (mode === "overlay") renderOverlay();
  // Focused session died under us: surface the list instead of a dead screen.
  const f = mgr.focused;
  if (mode === "attached" && f && f.state === "exited") openOverlay();
  scheduleStatus();
};

const server = startHookServer((e) => {
  if (e.event !== "Statusline") logEvent(e); // heartbeats would drown the log
  mgr.handleHook(e);
});

// Best-effort clipboard: OSC 52 (works through zellij/tmux/ssh) plus any
// local clipboard helper that exists.
function copyToClipboard(text: string) {
  stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  for (const cmd of [["clip.exe"], ["wl-copy"], ["xclip", "-selection", "clipboard"]]) {
    try {
      const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(text);
      proc.stdin.end();
      break;
    } catch {}
  }
}

// ---- input ----

const KEY = {
  ctrlSpace: 0x00,
  ctrlC: 0x03,
  esc: 0x1b,
  enter: 0x0d,
  backspace: 0x7f,
} as const;

function isUp(buf: Buffer): boolean {
  return buf.toString() === "\x1b[A" || buf.toString() === "\x1bOA";
}
function isDown(buf: Buffer): boolean {
  return buf.toString() === "\x1b[B" || buf.toString() === "\x1bOB";
}

function handleOverlayKey(buf: Buffer) {
  const sorted = mgr.sorted();
  const sel = sorted[overlaySelected];

  if (confirmKill || confirmQuit) {
    if (buf[0] === 0x79 /* y */) {
      if (confirmQuit) quit();
      if (confirmKill && sel) mgr.kill(sel.id);
    }
    confirmKill = false;
    confirmQuit = false;
    renderOverlay();
    return;
  }

  if (buf[0] === KEY.ctrlSpace || (buf[0] === KEY.esc && buf.length === 1)) return toBase();
  if (isDown(buf) || buf.toString() === "j") {
    overlaySelected = Math.min(sorted.length - 1, overlaySelected + 1);
    return renderOverlay();
  }
  if (isUp(buf) || buf.toString() === "k") {
    overlaySelected = Math.max(0, overlaySelected - 1);
    return renderOverlay();
  }
  const ch = buf.toString();
  if (buf[0] === KEY.enter && sel?.pty) return attach(sel);
  if (ch === "a" && sel) {
    mgr.ack(sel.id);
    return renderOverlay();
  }
  if (ch === "n") return void openDirPicker();
  if (ch === "r") return void openDirPicker(true);
  if ((ch === "y" || ch === "Y") && sel) {
    const cmd = mgr.resumeCommand(sel.id);
    if (cmd) {
      copyToClipboard(cmd);
      sel.lastMsg = "resume cmd copied";
      if (ch === "Y") mgr.kill(sel.id); // eject: hand the session off entirely
    }
    return renderOverlay();
  }
  if (ch === "K" && sel) {
    confirmKill = true;
    return renderOverlay();
  }
  if (ch === "q" || buf[0] === KEY.ctrlC) {
    if (mgr.sessions.some((s) => s.pty)) {
      confirmQuit = true;
      return renderOverlay();
    }
    quit();
  }
}

function handleTextKey(buf: Buffer, onSubmit: () => void, onCancel: () => void) {
  // Pasted chunks arrive as one buffer: split into per-char events so a
  // trailing newline still submits. Escape sequences stay intact.
  if (buf.length > 1 && buf[0] !== KEY.esc) {
    for (const ch of buf.toString()) {
      handleTextKey(Buffer.from(ch), onSubmit, onCancel);
      if ((mode as Mode) === "attached" || ch === "\r") return;
    }
    return;
  }
  if (buf[0] === KEY.esc && buf.length === 1) return onCancel();
  if (buf[0] === KEY.ctrlSpace) return toBase();
  if (buf[0] === KEY.enter) return onSubmit();
  if (buf[0] === KEY.backspace) {
    pickerInput = pickerInput.slice(0, -1);
    return renderPicker();
  }
  if (buf[0] === 0x15 /* ctrl-u */) {
    pickerInput = "";
    return renderPicker();
  }
  if (mode === "picker-dir") {
    if (isDown(buf)) {
      pickerSelected++;
      return renderPicker();
    }
    if (isUp(buf)) {
      pickerSelected = Math.max(0, pickerSelected - 1);
      return renderPicker();
    }
  }
  const text = buf.toString();
  if ([...text].every((c) => c >= " " && c !== "\x7f")) {
    pickerInput += text;
    renderPicker();
  }
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (buf: Buffer) => {
  switch (mode) {
    case "attached": {
      if (buf[0] === KEY.ctrlSpace && buf.length === 1) return openOverlay();
      const f = mgr.focused;
      if (f?.pty) f.pty.write(buf.toString());
      return;
    }
    case "home": {
      if (buf[0] === KEY.ctrlSpace) return openOverlay();
      const ch = buf.toString();
      if (ch === "n") return void openDirPicker();
      if (ch === "r") return void openDirPicker(true);
      if (ch === "R") return restoreFleet();
      if (ch === "q" || buf[0] === KEY.ctrlC) {
        if (mgr.sessions.some((s) => s.pty)) return openOverlay();
        quit();
      }
      return;
    }
    case "overlay":
      return handleOverlayKey(buf);
    case "picker-dir":
      return handleTextKey(
        buf,
        () => {
          const items = fuzzyFilter(allDirs, pickerInput);
          const raw = pickerInput.trim();
          const chosen =
            items[pickerSelected] ??
            (raw.startsWith("/") || raw.startsWith("~")
              ? raw.replace(/^~/, process.env.HOME ?? "~")
              : null);
          if (!chosen) return;
          spawnDir = chosen;
          pickerInput = "";
          mode = "picker-name";
          stdout.write(ansi.clear);
          renderPicker();
        },
        () => toBase(),
      );
    case "picker-name":
      return handleTextKey(
        buf,
        () => {
          spawnName = pickerInput.trim();
          pickerInput = "";
          // Adopt skips the prompt step: claude --resume opens its own
          // session picker inside the new PTY.
          if (spawnResume) return doSpawn("");
          mode = "picker-prompt";
          stdout.write(ansi.clear);
          renderPicker();
        },
        () => {
          pickerInput = "";
          mode = "picker-dir";
          stdout.write(ansi.clear);
          renderPicker();
        },
      );
    case "picker-prompt":
      return handleTextKey(
        buf,
        () => doSpawn(pickerInput.trim()),
        () => {
          pickerInput = "";
          mode = "picker-name";
          stdout.write(ansi.clear);
          renderPicker();
        },
      );
  }
});

stdout.on("resize", () => {
  const f = mgr.focused;
  if (f?.pty) f.pty.resize(cols(), ptyRows());
  if (mode === "home") drawHome(loadFleet().length);
  if (mode === "overlay") {
    stdout.write(ansi.clear);
    renderOverlay();
  }
  if (mode.startsWith("picker")) {
    stdout.write(ansi.clear);
    renderPicker();
  }
  scheduleStatus();
});

process.on("uncaughtException", (err) => {
  stdout.write(ansi.showCursor + ansi.altScreenOff + ansi.reset);
  try {
    process.stdin.setRawMode(false);
  } catch {}
  console.error(err);
  process.exit(1);
});
process.on("SIGTERM", () => quit());
process.on("SIGHUP", () => quit());

// ---- start ----
stdout.write(ansi.altScreenOn);
drawHome(loadFleet().length);
drawStatusBar(mgr);
