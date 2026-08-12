import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'bun-pty';
import type { IPty } from 'bun-pty';
import type { AgentAdapter } from './agent-adapter';
import { socketPath, stateDir, statusFile } from './config';
import type { HookEvent } from './hooks';
import { isRecord } from './report';

export type SessionState = 'running' | 'needs_you' | 'done' | 'exited';

export type SessionEventKind = 'added' | 'state' | 'renamed' | 'removed';

// The over-the-wire view of a session: everything but the PTY handle, plus
// the surface kind.
export interface SessionDescriptor {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly state: SessionState;
  readonly unread: boolean;
  readonly lastMsg: string;
  readonly claudeId?: string;
  readonly namedBy: 'user' | 'auto' | 'agent';
  readonly createdAt: number;
  readonly kind: 'pty';
  readonly alive: boolean;
}

export interface Session {
  id: string;
  name: string;
  cwd: string;
  pty: IPty | null;
  state: SessionState;
  unread: boolean;
  lastMsg: string;
  claudeId?: string;

  // who last named this session: the agent's own rename beats everything, a
  // user-typed spawn name beats auto-summaries.
  namedBy: 'user' | 'auto' | 'agent';
  createdAt: number;
}

let counter = 0;

export interface FleetEntry {
  readonly name: string;
  readonly cwd: string;
  readonly claudeId: string;
}

const fleetFile = join(stateDir, 'fleet.json');

export interface FleetStore {
  readonly loadFleet: () => FleetEntry[];
  readonly writeFleet: (entries: readonly FleetEntry[]) => void;
}

const jsonFleetStore: FleetStore = {
  loadFleet: () => loadFleet(),
  writeFleet: (entries) => {
    try {
      writeFileSync(fleetFile, JSON.stringify(entries, null, 2));
    } catch {}
  },
};

function loadFleet(): FleetEntry[] {
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

  onEvent: (kind: SessionEventKind, s: Session) => void = () => {};

  private readonly adapter: AgentAdapter;

  private readonly store: FleetStore;

  constructor(adapter: AgentAdapter, store: FleetStore = jsonFleetStore) {
    this.adapter = adapter;
    this.store = store;
  }

  get focused(): Session | null {
    return this.sessions.find((s) => s.id === this.focusedId) ?? null;
  }

  // resume: true opens the agent's own session picker; a string resumes that
  // specific agent session id (fleet restore).
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
    const plan = this.adapter.planSpawn({ prompt, resume });

    const pty = spawn(plan.bin, plan.args, {
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

      this.onEvent('state', session);
      this.emitChange();
    });

    this.sessions.push(session);
    this.writeFleet();
    this.writeStatus();
    this.onEvent('added', session);

    return session;
  }

  collectDescriptors(): SessionDescriptor[] {
    return this.sessions.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: s.state,
      unread: s.unread,
      lastMsg: s.lastMsg,
      ...(s.claudeId === undefined ? {} : { claudeId: s.claudeId }),
      namedBy: s.namedBy,
      createdAt: s.createdAt,
      kind: 'pty',
      alive: s.pty !== null,
    }));
  }

  applyHook(e: HookEvent) {
    const s = this.sessions.find((x) => x.id === e.atcId);

    if (!s) {
      return;
    }

    const ev = this.adapter.normalizeHook(e);
    const focused = this.focusedId === s.id;
    let dirty = false;

    if (ev.agentSessionID !== undefined && s.claudeId !== ev.agentSessionID) {
      s.claudeId = ev.agentSessionID;

      this.writeFleet();

      dirty = true;
    }

    if (ev.nameSource !== undefined) {
      void this.refreshName(s, ev.nameSource);
    }

    switch (ev.kind) {
      case 'started': {
        if (s.lastMsg === 'adopting…') {
          s.lastMsg = 'adopted';
          dirty = true;
        }

        break;
      }
      case 'needs-input': {
        s.state = 'needs_you';
        s.unread = !focused;
        s.lastMsg = ev.message ?? 'needs input';
        dirty = true;
        break;
      }
      case 'turn-done': {
        s.state = 'done';
        s.unread = !focused;
        s.lastMsg = 'turn done';
        dirty = true;
        break;
      }
      case 'prompt-submitted': {
        s.state = 'running';
        s.unread = false;
        s.lastMsg = ev.message ?? 'working';
        dirty = true;
        break;
      }
      case 'ended': {
        s.state = 'exited';
        s.unread = false;
        s.lastMsg = 'session ended';
        dirty = true;
        break;
      }

      // Heartbeats only matter for the agent-session-id capture above.
      case 'heartbeat': {
        break;
      }
    }

    if (dirty) {
      this.onEvent('state', s);
      this.emitChange();
    }
  }

  private async refreshName(s: Session, source: string) {
    const update = await this.adapter.loadName(source, s.namedBy);

    if (update === null || update.name === '' || update.name === s.name) {
      return;
    }

    s.name = update.name;

    if (update.namedBy !== undefined) {
      s.namedBy = update.namedBy;
    }

    this.writeFleet();
    this.onEvent('renamed', s);
    this.emitChange();
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(id: string): string | null {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return null;
    }

    return this.adapter.buildResumeCommand(s.cwd, s.claudeId);
  }

  attach(id: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return;
    }

    s.unread = false;

    // Attaching answers the attention request: a still-pending prompt
    // re-flags it via the next notification.
    if (s.state === 'needs_you') {
      s.state = 'running';
      s.lastMsg = 'attached';
    }

    this.onEvent('state', s);
    this.emitChange();
  }

  ack(id: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (s) {
      s.unread = false;

      this.onEvent('state', s);
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

      this.onEvent('state', s);
    } else {
      this.sessions = this.sessions.filter((x) => x.id !== id);

      if (this.focusedId === id) {
        this.focusedId = null;
      }

      this.onEvent('removed', s);
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
  // fleet state inside their own status line.
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

    this.store.writeFleet(fleet);
  }

  countStates() {
    return countSessionStates(this.sessions);
  }

  sortSessions(): Session[] {
    return sortSessionViews(this.sessions);
  }
}

export function countSessionStates(
  list: readonly { readonly state: SessionState }[],
): Record<SessionState, number> {
  const c = { needs_you: 0, running: 0, done: 0, exited: 0 };

  for (const s of list) {
    c[s.state]++;
  }

  return c;
}

// Overlay order: who needs you first, then finished turns, then busy, then dead.
export function sortSessionViews<
  T extends { readonly state: SessionState; readonly createdAt: number },
>(list: readonly T[]): T[] {
  const rank: Record<SessionState, number> = {
    needs_you: 0,
    done: 1,
    running: 2,
    exited: 3,
  };

  return [...list].toSorted((a, b) => rank[a.state] - rank[b.state] || a.createdAt - b.createdAt);
}
