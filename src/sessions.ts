import { spawn, type IPty } from "bun-pty";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { socketPath, stateDir, statusFile } from "./config";
import type { HookEvent } from "./hooks";

export type SessionState = "running" | "needs_you" | "done" | "exited";

export interface Session {
  id: string;
  name: string;
  cwd: string;
  pty: IPty | null;
  state: SessionState;
  unread: boolean;
  lastMsg: string;
  claudeId?: string;
  createdAt: number;
}

let counter = 0;

export interface FleetEntry {
  name: string;
  cwd: string;
  claudeId: string;
}

const fleetFile = join(stateDir, "fleet.json");

export function loadFleet(): FleetEntry[] {
  try {
    return JSON.parse(readFileSync(fleetFile, "utf8"));
  } catch {
    return [];
  }
}

export class SessionManager {
  sessions: Session[] = [];
  focusedId: string | null = null;
  onOutput: (s: Session, data: string) => void = () => {};
  onChange: () => void = () => {};

  constructor(
    private config: Config,
    private settingsFile: string,
  ) {}

  get focused(): Session | null {
    return this.sessions.find((s) => s.id === this.focusedId) ?? null;
  }

  // resume: true opens claude's own session picker; a string resumes that
  // specific claude session id (fleet restore).
  spawn(
    cwd: string,
    name: string,
    prompt: string,
    cols: number,
    rows: number,
    resume: boolean | string = false,
  ): Session {
    const id = `s${++counter}-${Date.now().toString(36)}`;
    const args = [
      ...this.config.claudeArgs,
      "--settings",
      this.settingsFile,
      ...(resume === true ? ["--resume"] : []),
      ...(typeof resume === "string" ? ["--resume", resume] : []),
      ...(prompt ? [prompt] : []),
    ];
    const pty = spawn(this.config.claudeBin, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...(process.env as Record<string, string>),
        ATC_SESSION_ID: id,
        ATC_SOCKET: socketPath,
      },
    });
    const session: Session = {
      id,
      name,
      cwd,
      pty,
      state: "running",
      unread: false,
      lastMsg: prompt || (resume ? "adopting…" : "started"),
      claudeId: typeof resume === "string" ? resume : undefined,
      createdAt: Date.now(),
    };
    pty.onData((d) => this.onOutput(session, d));
    pty.onExit(() => {
      session.pty = null;
      if (session.state !== "exited") {
        session.state = "exited";
        session.unread = this.focusedId !== session.id;
        session.lastMsg = "process exited";
      }
      this.changed();
    });
    this.sessions.push(session);
    this.saveFleet();
    this.saveStatus();
    return session;
  }

  handleHook(e: HookEvent) {
    const s = this.sessions.find((x) => x.id === e.atcId);
    if (!s) return;
    const focused = this.focusedId === s.id;
    let dirty = false;
    if (typeof e.payload.session_id === "string" && s.claudeId !== e.payload.session_id) {
      s.claudeId = e.payload.session_id;
      this.saveFleet();
      dirty = true;
    }
    switch (e.event) {
      case "SessionStart":
        if (s.lastMsg === "adopting…") {
          s.lastMsg = "adopted";
          dirty = true;
        }
        break;
      case "Notification":
        s.state = "needs_you";
        s.unread = !focused;
        s.lastMsg = String(e.payload.message ?? "needs input");
        dirty = true;
        break;
      case "Stop":
        s.state = "done";
        s.unread = !focused;
        s.lastMsg = "turn done";
        dirty = true;
        break;
      case "UserPromptSubmit":
        s.state = "running";
        s.unread = false;
        s.lastMsg = String(e.payload.prompt ?? "").slice(0, 80) || "working";
        dirty = true;
        break;
      case "SessionEnd":
        s.state = "exited";
        s.unread = false;
        s.lastMsg = "session ended";
        dirty = true;
        break;
      // Statusline heartbeats only matter for the claudeId capture above.
    }
    if (dirty) this.changed();
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  resumeCommand(id: string): string | null {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    const resume = s.claudeId ? `claude --resume ${s.claudeId}` : "claude --resume";
    return `cd '${s.cwd.replace(/'/g, `'\\''`)}' && ${resume}`;
  }

  ack(id: string) {
    const s = this.sessions.find((x) => x.id === id);
    if (s) s.unread = false;
    this.changed();
  }

  kill(id: string) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    if (s.pty) {
      s.pty.kill();
      s.pty = null;
      s.state = "exited";
      s.lastMsg = "killed";
    } else {
      this.sessions = this.sessions.filter((x) => x.id !== id);
      if (this.focusedId === id) this.focusedId = null;
    }
    this.saveFleet();
    this.changed();
  }

  killAll() {
    for (const s of this.sessions) s.pty?.kill();
  }

  private changed() {
    this.saveStatus();
    this.onChange();
  }

  // Consumed by the injected statusline command so wrangled sessions render
  // fleet state inside Claude Code's own status line.
  saveStatus() {
    const c = this.counts();
    const urgent = this.sorted().find((s) => s.state === "needs_you");
    try {
      writeFileSync(statusFile, JSON.stringify({ ...c, urgent: urgent?.name ?? null }));
    } catch {}
  }

  // Persisted continuously so a crash (or quit) leaves a restorable fleet.
  // Deliberate kills rewrite the file; unexpected session/atc deaths do not,
  // so the last known fleet survives for `R` restore.
  saveFleet() {
    const fleet: FleetEntry[] = this.sessions
      .filter((s) => s.pty && s.claudeId)
      .map((s) => ({ name: s.name, cwd: s.cwd, claudeId: s.claudeId! }));
    try {
      writeFileSync(fleetFile, JSON.stringify(fleet, null, 2));
    } catch {}
  }

  counts() {
    const c = { needs_you: 0, running: 0, done: 0, exited: 0 };
    for (const s of this.sessions) c[s.state]++;
    return c;
  }

  // Overlay order: who needs you first, then finished turns, then busy, then dead.
  sorted(): Session[] {
    const rank: Record<SessionState, number> = {
      needs_you: 0,
      done: 1,
      running: 2,
      exited: 3,
    };
    return [...this.sessions].sort(
      (a, b) => rank[a.state] - rank[b.state] || a.createdAt - b.createdAt,
    );
  }
}
