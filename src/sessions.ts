import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'bun-pty';
import type { IPty } from 'bun-pty';
import type { Config } from './config';
import { socketPath, stateDir, statusFile } from './config';
import type { HookEvent } from './hooks';
import { isRecord } from './report';

export type SessionState = 'running' | 'needs_you' | 'done' | 'exited';

export interface Session {
  id: string;
  name: string;
  cwd: string;
  pty: IPty | null;
  state: SessionState;
  unread: boolean;
  lastMsg: string;
  claudeId?: string;

  // who last named this session: claude /rename beats everything, a
  // user-typed spawn name beats auto-summaries, defaults track claude.
  namedBy: 'user' | 'auto' | 'claude';
  createdAt: number;
}

let counter = 0;

export interface FleetEntry {
  name: string;
  cwd: string;
  claudeId: string;
}

const fleetFile = join(stateDir, 'fleet.json');

export function loadFleet(): FleetEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fleetFile, 'utf8'));

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (entry): entry is FleetEntry =>
        isRecord(entry) &&
        typeof entry['name'] === 'string' &&
        typeof entry['cwd'] === 'string' &&
        typeof entry['claudeId'] === 'string',
    );
  } catch {
    return [];
  }
}

function collectEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
}

export class SessionManager {
  sessions: Session[] = [];

  focusedId: string | null = null;

  onOutput: (s: Session, data: string) => void = () => {};

  onChange: () => void = () => {};

  private readonly config: Config;

  private readonly settingsFile: string;

  constructor(config: Config, settingsFile: string) {
    this.config = config;
    this.settingsFile = settingsFile;
  }

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
    namedBy: 'user' | 'auto' = 'auto',
  ): Session {
    const id = `s${++counter}-${Date.now().toString(36)}`;

    const args = [
      ...this.config.claudeArgs,
      '--settings',
      this.settingsFile,
      ...(resume === true ? ['--resume'] : []),
      ...(typeof resume === 'string' ? ['--resume', resume] : []),
      ...(prompt === '' ? [] : [prompt]),
    ];

    const pty = spawn(this.config.claudeBin, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: collectEnv({ ATC_SESSION_ID: id, ATC_SOCKET: socketPath }),
    });

    let initialMsg = prompt;

    if (initialMsg === '') {
      initialMsg = resume === false ? 'started' : 'adopting…';
    }

    const session: Session = {
      id,
      name,
      cwd,
      pty,
      state: 'running',
      unread: false,
      lastMsg: initialMsg,
      ...(typeof resume === 'string' ? { claudeId: resume } : {}),
      namedBy,
      createdAt: Date.now(),
    };

    pty.onData((d) => {
      this.onOutput(session, d);
    });

    pty.onExit(() => {
      session.pty = null;

      if (session.state !== 'exited') {
        session.state = 'exited';
        session.unread = this.focusedId !== session.id;
        session.lastMsg = 'process exited';
      }

      this.emitChange();
    });

    this.sessions.push(session);
    this.writeFleet();
    this.writeStatus();

    return session;
  }

  applyHook(e: HookEvent) {
    const s = this.sessions.find((x) => x.id === e.atcId);

    if (!s) {
      return;
    }

    const focused = this.focusedId === s.id;
    const sessionId = e.payload['session_id'];
    let dirty = false;

    if (typeof sessionId === 'string' && s.claudeId !== sessionId) {
      s.claudeId = sessionId;

      this.writeFleet();

      dirty = true;
    }

    const transcript = e.payload['transcript_path'];

    if (
      typeof transcript === 'string' &&
      ['SessionStart', 'UserPromptSubmit', 'Stop'].includes(e.event)
    ) {
      void this.refreshName(s, transcript);
    }

    switch (e.event) {
      case 'SessionStart': {
        if (s.lastMsg === 'adopting…') {
          s.lastMsg = 'adopted';
          dirty = true;
        }

        break;
      }
      case 'Notification': {
        const message = e.payload['message'];

        s.state = 'needs_you';
        s.unread = !focused;
        s.lastMsg = typeof message === 'string' && message !== '' ? message : 'needs input';
        dirty = true;
        break;
      }
      case 'Stop': {
        s.state = 'done';
        s.unread = !focused;
        s.lastMsg = 'turn done';
        dirty = true;
        break;
      }
      case 'UserPromptSubmit': {
        const prompt = e.payload['prompt'];
        const preview = typeof prompt === 'string' ? prompt.slice(0, 80) : '';

        s.state = 'running';
        s.unread = false;
        s.lastMsg = preview === '' ? 'working' : preview;
        dirty = true;
        break;
      }
      case 'SessionEnd': {
        s.state = 'exited';
        s.unread = false;
        s.lastMsg = 'session ended';
        dirty = true;
        break;
      }

      // Statusline heartbeats only matter for the claudeId capture above.
    }

    if (dirty) {
      this.emitChange();
    }
  }

  // Claude is the naming authority: /rename writes custom-title lines to the
  // transcript, auto-summaries write summary lines. Pull the freshest.
  private async refreshName(s: Session, transcript: string) {
    try {
      const proc = Bun.spawn(['grep', '-E', '"type":"(custom-title|summary)"', transcript], {
        stdout: 'pipe',
        stderr: 'ignore',
      });

      const text = await new Response(proc.stdout).text();

      let title: string | undefined;
      let summary: string | undefined;

      for (const line of text.split('\n')) {
        if (line.trim() === '') {
          continue;
        }

        try {
          const parsed: unknown = JSON.parse(line);

          if (!isRecord(parsed)) {
            continue;
          }

          const customTitle = parsed['customTitle'];
          const summaryText = parsed['summary'];

          if (parsed['type'] === 'custom-title' && typeof customTitle === 'string') {
            title = customTitle;
          }

          if (parsed['type'] === 'summary' && typeof summaryText === 'string') {
            summary = summaryText;
          }
        } catch {}
      }

      const next = title ?? (s.namedBy === 'user' ? undefined : summary);

      if (next !== undefined && next !== '' && next !== s.name) {
        s.name = next;

        if (title !== undefined) {
          s.namedBy = 'claude';
        }

        this.writeFleet();
        this.emitChange();
      }
    } catch {}
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(id: string): string | null {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return null;
    }

    const resume = s.claudeId === undefined ? 'claude --resume' : `claude --resume ${s.claudeId}`;
    const quoted = s.cwd.replaceAll("'", String.raw`'\''`);

    return `cd '${quoted}' && ${resume}`;
  }

  ack(id: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (s) {
      s.unread = false;
    }

    this.emitChange();
  }

  kill(id: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return;
    }

    if (s.pty) {
      s.pty.kill();

      s.pty = null;
      s.state = 'exited';
      s.lastMsg = 'killed';
    } else {
      this.sessions = this.sessions.filter((x) => x.id !== id);

      if (this.focusedId === id) {
        this.focusedId = null;
      }
    }

    this.writeFleet();
    this.emitChange();
  }

  killAll() {
    for (const s of this.sessions) {
      s.pty?.kill();
    }
  }

  private emitChange() {
    this.writeStatus();
    this.onChange();
  }

  // Consumed by the injected statusline command so wrangled sessions render
  // fleet state inside Claude Code's own status line.
  writeStatus() {
    const c = this.countStates();
    const urgent = this.sortSessions().find((s) => s.state === 'needs_you');

    try {
      writeFileSync(statusFile, JSON.stringify({ ...c, urgent: urgent?.name ?? null }));
    } catch {}
  }

  // Persisted continuously so a crash (or quit) leaves a restorable fleet.
  // Deliberate kills rewrite the file; unexpected session/atc deaths do not,
  // so the last known fleet survives for `R` restore.
  writeFleet() {
    const fleet: FleetEntry[] = [];

    for (const s of this.sessions) {
      if (s.pty !== null && s.claudeId !== undefined) {
        fleet.push({ name: s.name, cwd: s.cwd, claudeId: s.claudeId });
      }
    }

    try {
      writeFileSync(fleetFile, JSON.stringify(fleet, null, 2));
    } catch {}
  }

  countStates() {
    const c = { needs_you: 0, running: 0, done: 0, exited: 0 };

    for (const s of this.sessions) {
      c[s.state]++;
    }

    return c;
  }

  // Overlay order: who needs you first, then finished turns, then busy, then dead.
  sortSessions(): Session[] {
    const rank: Record<SessionState, number> = {
      needs_you: 0,
      done: 1,
      running: 2,
      exited: 3,
    };

    return [...this.sessions].toSorted(
      (a, b) => rank[a.state] - rank[b.state] || a.createdAt - b.createdAt,
    );
  }
}
