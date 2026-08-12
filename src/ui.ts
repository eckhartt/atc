import { displayDir } from "./dirs";
import type { Session, SessionManager, SessionState } from "./sessions";

const ESC = "\x1b";
export const ansi = {
  altScreenOn: `${ESC}[?1049h`,
  altScreenOff: `${ESC}[?1049l`,
  clear: `${ESC}[2J${ESC}[H`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  saveCursor: `${ESC}7`,
  restoreCursor: `${ESC}8`,
  reset: `${ESC}[0m`,
  moveTo: (row: number, col: number) => `${ESC}[${row};${col}H`,
};

const GLYPH: Record<SessionState, string> = {
  needs_you: `${ESC}[31m●${ESC}[0m`,
  running: `${ESC}[36m◐${ESC}[0m`,
  done: `${ESC}[32m✓${ESC}[0m`,
  exited: `${ESC}[90m✗${ESC}[0m`,
};

const STATE_LABEL: Record<SessionState, string> = {
  needs_you: "NEEDS YOU",
  running: "running",
  done: "done",
  exited: "exited",
};

function out(s: string) {
  process.stdout.write(s);
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/[\r\n\x1b]+/g, " ");
  if (max <= 0) return "";
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)) + "…";
}

export function cols(): number {
  return process.stdout.columns || 80;
}
export function rows(): number {
  return process.stdout.rows || 24;
}

export function drawStatusBar(mgr: SessionManager) {
  const c = mgr.counts();
  const width = cols();
  const focused = mgr.focused;
  const urgent = mgr.sorted().find((s) => s.state === "needs_you");
  const left = ` atc ▏${focused ? focused.name : "no session"} `;
  const parts: string[] = [];
  if (c.needs_you > 0)
    parts.push(`● ${c.needs_you} need you${urgent ? `: ${urgent.name}` : ""}`);
  if (c.done > 0) parts.push(`✓ ${c.done} done`);
  if (c.running > 0) parts.push(`◐ ${c.running} running`);
  if (c.exited > 0) parts.push(`✗ ${c.exited}`);
  const right = ` ${parts.join(" ▏") || "idle"} ▏^Space `;
  const pad = Math.max(1, width - left.length - right.length);
  const bg = c.needs_you > 0 ? `${ESC}[1;97;41m` : `${ESC}[30;47m`;
  const text = truncate(left + " ".repeat(pad) + right, width).padEnd(width);
  out(ansi.saveCursor + ansi.moveTo(rows(), 1) + bg + text + ansi.reset + ansi.restoreCursor);
}

// All box rows are built as {styled, plainWidth} pairs so centering and edge
// alignment never depend on ANSI-stripped length math at draw time.
interface Row {
  styled: string;
  width: number;
}

function drawBox(rowsList: Row[]) {
  const boxWidth = Math.max(...rowsList.map((r) => r.width));
  const top = Math.max(1, Math.floor((rows() - 1 - rowsList.length) / 2));
  const left = Math.max(1, Math.floor((cols() - boxWidth) / 2));
  let buf = ansi.hideCursor;
  rowsList.forEach((r, i) => {
    buf += ansi.moveTo(top + i, left) + r.styled;
  });
  out(buf);
}

function boxTop(width: number, title: string): Row {
  const t = ` ${title} `;
  return { styled: `┌${t}${"─".repeat(Math.max(0, width - 2 - t.length))}┐`, width };
}
function boxDivider(width: number): Row {
  return { styled: `├${"─".repeat(width - 2)}┤`, width };
}
function boxBottom(width: number): Row {
  return { styled: `└${"─".repeat(width - 2)}┘`, width };
}
function boxRow(width: number, styledContent: string, contentPlainLen: number): Row {
  const pad = " ".repeat(Math.max(0, width - 4 - contentPlainLen));
  return { styled: `│ ${styledContent}${pad} │`, width };
}
function dimRow(width: number, text: string): Row {
  const t = truncate(text, width - 4);
  return boxRow(width, `${ESC}[90m${t}${ESC}[0m`, t.length);
}

export interface OverlayView {
  sessions: Session[];
  selected: number;
  confirmKill: boolean;
  confirmQuit: boolean;
}

export function drawOverlay(view: OverlayView) {
  const width = Math.min(cols() - 4, 90);
  const rowsList: Row[] = [boxTop(width, "sessions")];

  if (view.sessions.length === 0) rowsList.push(dimRow(width, "no sessions — n to spawn"));

  view.sessions.forEach((s, i) => {
    const sel = i === view.selected;
    const name = truncate(s.name, 16).padEnd(16);
    const state = STATE_LABEL[s.state].padEnd(9);
    const dir = truncate(displayDir(s.cwd), 18).padEnd(18);
    const msgWidth = Math.max(4, width - 4 - 2 - 17 - 10 - 19);
    const msg = truncate(s.lastMsg, msgWidth).padEnd(msgWidth);
    const unread = s.unread ? `${ESC}[1;33m!${ESC}[0m` : " ";
    const body = `${name} ${state} ${dir} ${msg}`;
    const styledBody = sel ? `${ESC}[7m${body}${ESC}[0m` : body;
    rowsList.push(boxRow(width, `${GLYPH[s.state]}${unread}${styledBody}`, 2 + body.length));
  });

  rowsList.push(boxDivider(width));
  let hint = "↑↓/jk · ⏎ attach · a ack · n new · r adopt · y yank cmd · Y eject · K kill · q quit";
  if (view.confirmKill) hint = "kill selected session? y / n";
  if (view.confirmQuit) hint = "quit atc and kill all sessions? y / n";
  rowsList.push(dimRow(width, hint));
  rowsList.push(boxBottom(width));
  drawBox(rowsList);
}

export interface PickerView {
  title: string;
  items: string[];
  selected: number;
  input: string;
  placeholder?: string;
  hint: string;
}

export function drawPicker(view: PickerView) {
  const width = Math.min(cols() - 4, 90);
  const rowsList: Row[] = [boxTop(width, view.title)];

  const shown = view.items.slice(0, 10);
  shown.forEach((item, i) => {
    const t = truncate(item, width - 4);
    const styled = i === view.selected ? `${ESC}[7m${t.padEnd(width - 4)}${ESC}[0m` : t;
    rowsList.push(boxRow(width, styled, i === view.selected ? width - 4 : t.length));
  });

  const inputShown = truncate(view.input, width - 8);
  let inputStyled: string;
  let inputLen: number;
  if (!inputShown && view.placeholder) {
    const ph = truncate(view.placeholder, width - 8);
    inputStyled = `> ${ESC}[93m█${ESC}[0m${ESC}[90m ${ph}${ESC}[0m`;
    inputLen = 2 + 1 + 1 + ph.length;
  } else {
    inputStyled = `> ${inputShown}${ESC}[93m█${ESC}[0m`;
    inputLen = 2 + inputShown.length + 1;
  }
  rowsList.push(boxRow(width, inputStyled, inputLen));
  rowsList.push(boxDivider(width));
  rowsList.push(dimRow(width, view.hint));
  rowsList.push(boxBottom(width));
  drawBox(rowsList);
}

export function drawHome(fleetCount = 0) {
  out(ansi.clear + ansi.hideCursor);
  const msgs = [
    "atc — control tower for claude sessions",
    "",
    "n       spawn a session",
    "r       adopt an existing session (claude --resume)",
    ...(fleetCount > 0 ? [`R       restore last fleet (${fleetCount} sessions)`] : []),
    "^Space  session list",
    "q       quit",
  ];
  const top = Math.max(1, Math.floor((rows() - 1 - msgs.length) / 2));
  msgs.forEach((m, i) => {
    const left = Math.max(1, Math.floor((cols() - m.length) / 2));
    const styled = i === 0 ? `${ESC}[1m${m}${ESC}[0m` : `${ESC}[90m${m}${ESC}[0m`;
    out(ansi.moveTo(top + i, left) + styled);
  });
}
