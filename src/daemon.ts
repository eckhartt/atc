import { unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import type { AgentAdapter } from './agent-adapter';
import { logEvent, startHookServer } from './hooks';
import { OutboundQueue } from './outbound-queue';
import type { SocketWriter } from './outbound-queue';
import { MAX_CHUNK, MAX_LINE, PROTOCOL_V, decodeMessage, encodeMessage } from './protocol';
import type { ErrorCode, EventMsg, RequestMsg } from './protocol';
import { SessionManager, loadFleet } from './sessions';
import type { SessionDescriptor } from './sessions';

export interface DaemonOptions {
  readonly socketPath: string;
  readonly reporterSocketPath: string;

  // Build string sent in the handshake and in mismatch errors, e.g. "atc/0.1.0".
  readonly build: string;
  readonly adapter: AgentAdapter;
}

export interface DaemonHandle {
  readonly stop: () => void;
}

/**
 * The daemon: owns the sessions, the client-protocol listener, and the
 * reporter listener. Protocol requests are NDJSON lines, one response per
 * request, and state changes broadcast to every connected client. The first
 * request on a connection must be `daemon.hello`; an unknown method is an
 * error, never a disconnect; a malformed or oversized line is a disconnect,
 * because transports guarantee byte integrity and such a line means a buggy
 * or hostile peer.
 */
export function startDaemon(opts: DaemonOptions): DaemonHandle {
  const mgr = new SessionManager(opts.adapter);
  const clients = new Set<Connection>();

  mgr.onEvent = (kind, s) => {
    const builders: Record<typeof kind, () => EventMsg> = {
      added: () => ({ v: PROTOCOL_V, ev: 'session.added', session: getDescriptor(mgr, s.id) }),
      state: () => ({
        v: PROTOCOL_V,
        ev: 'session.state',
        s: s.id,
        state: s.state,
        unread: s.unread,
        lastMsg: s.lastMsg,
      }),
      renamed: () => ({
        v: PROTOCOL_V,
        ev: 'session.renamed',
        s: s.id,
        name: s.name,
        namedBy: s.namedBy,
      }),
      removed: () => ({ v: PROTOCOL_V, ev: 'session.removed', s: s.id }),
    };

    const event = builders[kind]();

    for (const client of clients) {
      client.sendEvent(event);
    }
  };

  const reporter = startHookServer((e) => {
    if (e.event !== 'Statusline') {
      logEvent(e);
    }

    mgr.applyHook(e);
  }, opts.reporterSocketPath);

  const ctx: DaemonContext = {
    build: opts.build,
    collectSessions: () => mgr.collectDescriptors(),
    spawnSession: (p) => {
      const s = mgr.spawn(p.cwd, p.name, p.prompt, p.cols, p.rows, p.resume, p.namedBy);

      return getDescriptor(mgr, s.id);
    },
    killSession: (id) => {
      if (!mgr.sessions.some((s) => s.id === id)) {
        return false;
      }

      mgr.kill(id);

      return true;
    },
    ackSession: (id) => {
      if (!mgr.sessions.some((s) => s.id === id)) {
        return false;
      }

      mgr.ack(id);

      return true;
    },
    buildResumeCommand: (id) => mgr.buildResumeCommand(id),
    restoreFleet: (cols, rows) => {
      let restored = 0;

      for (const entry of loadFleet()) {
        const live = mgr.sessions.some((s) => s.pty !== null && s.claudeId === entry.claudeId);

        if (live) {
          continue;
        }

        mgr.spawn(entry.cwd, entry.name, '', cols, rows, entry.claudeId);

        restored++;
      }

      return restored;
    },
  };

  try {
    unlinkSync(opts.socketPath);
  } catch {}

  const server = Bun.listen<Connection>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        socket.data = new Connection(socket, ctx);

        clients.add(socket.data);
      },
      data(socket, buf) {
        socket.data.applyChunk(buf.toString());
      },
      drain(socket) {
        socket.data.drain();
      },
      close(socket) {
        clients.delete(socket.data);
      },
      error() {},
    },
  });

  return {
    stop() {
      server.stop(true);
      reporter.stop(true);
      mgr.killAll();
    },
  };
}

function getDescriptor(mgr: SessionManager, id: string): SessionDescriptor {
  const d = mgr.collectDescriptors().find((x) => x.id === id);

  if (d === undefined) {
    throw new Error(`descriptor for unknown session ${id}`);
  }

  return d;
}

interface SpawnParams {
  readonly cwd: string;
  readonly name: string;
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
  readonly resume: boolean | string;
  readonly namedBy: 'user' | 'auto';
}

interface DaemonContext {
  readonly build: string;
  readonly collectSessions: () => SessionDescriptor[];
  readonly spawnSession: (p: SpawnParams) => SessionDescriptor;
  readonly killSession: (id: string) => boolean;
  readonly ackSession: (id: string) => boolean;
  readonly buildResumeCommand: (id: string) => string | null;
  readonly restoreFleet: (cols: number, rows: number) => number;
}

interface PeerSocket extends SocketWriter {
  readonly end: () => void;
}

class Connection {
  private readonly peer: PeerSocket;

  private readonly ctx: DaemonContext;

  private readonly queue: OutboundQueue;

  private buffer = '';

  private helloed = false;

  constructor(peer: PeerSocket, ctx: DaemonContext) {
    this.peer = peer;
    this.ctx = ctx;

    this.queue = new OutboundQueue(peer);
  }

  sendEvent(event: EventMsg): void {
    if (this.helloed) {
      this.queue.send(encodeMessage(event));
    }
  }

  applyChunk(chunk: string): void {
    const buffered = this.buffer + chunk;

    if (buffered.length > MAX_LINE) {
      this.sendErr(0, 'bad_args', `line exceeds ${MAX_LINE} bytes`);
      this.peer.end();

      return;
    }

    const lines = buffered.split('\n');

    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }

      if (!this.applyLine(line)) {
        this.peer.end();

        return;
      }
    }
  }

  drain(): void {
    this.queue.drain();
  }

  // false: the connection is beyond recovery and gets closed.
  private applyLine(line: string): boolean {
    const decoded = decodeMessage(line);

    if (decoded.kind === 'malformed') {
      this.sendErr(0, 'bad_args', `malformed line: ${decoded.reason}`);

      return false;
    }

    if (decoded.kind !== 'request') {
      this.sendErr(0, 'bad_args', 'only requests flow client to daemon');

      return false;
    }

    const req = decoded.msg;

    if (req.m === 'daemon.hello') {
      return this.applyHello(req);
    }

    if (!this.helloed) {
      this.sendErr(req.id, 'unauthorized', 'daemon.hello must be the first request');

      return false;
    }

    this.applyRequest(req);

    return true;
  }

  private applyRequest(req: RequestMsg): void {
    switch (req.m) {
      case 'daemon.ping': {
        this.sendOk(req.id, {});

        return;
      }
      case 'session.list': {
        this.sendOk(req.id, { sessions: this.ctx.collectSessions() });

        return;
      }
      case 'session.spawn': {
        this.applySpawn(req);

        return;
      }
      case 'session.kill': {
        this.applySessionVerb(req, this.ctx.killSession);

        return;
      }
      case 'session.ack': {
        this.applySessionVerb(req, this.ctx.ackSession);

        return;
      }
      case 'session.resumeCommand': {
        const id = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';
        const command = this.ctx.buildResumeCommand(id);

        if (command === null) {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.sendOk(req.id, { command });
        }

        return;
      }
      case 'fleet.restore': {
        const cols = typeof req.p?.['cols'] === 'number' ? req.p['cols'] : 80;
        const rows = typeof req.p?.['rows'] === 'number' ? req.p['rows'] : 24;

        this.sendOk(req.id, { restored: this.ctx.restoreFleet(cols, rows) });

        return;
      }
      default: {
        this.sendErr(req.id, 'unknown_method', `unknown method '${req.m}'`);
      }
    }
  }

  private applySpawn(req: RequestMsg): void {
    const cwd = req.p?.['cwd'];

    if (typeof cwd !== 'string' || cwd === '') {
      this.sendErr(req.id, 'bad_args', 'session.spawn requires a cwd');

      return;
    }

    const name = typeof req.p?.['name'] === 'string' ? req.p['name'] : '';
    const rawResume = req.p?.['resume'];
    let resume: boolean | string = false;

    if (typeof rawResume === 'boolean' || typeof rawResume === 'string') {
      resume = rawResume;
    }

    const session = this.ctx.spawnSession({
      cwd,
      name: name === '' ? basename(cwd) : name,
      prompt: typeof req.p?.['prompt'] === 'string' ? req.p['prompt'] : '',
      cols: typeof req.p?.['cols'] === 'number' ? req.p['cols'] : 80,
      rows: typeof req.p?.['rows'] === 'number' ? req.p['rows'] : 24,
      resume,
      namedBy: name === '' ? 'auto' : 'user',
    });

    this.sendOk(req.id, { session });
  }

  private applySessionVerb(req: RequestMsg, verb: (id: string) => boolean): void {
    const id = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';

    if (verb(id)) {
      this.sendOk(req.id, {});
    } else {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
    }
  }

  private applyHello(req: RequestMsg): boolean {
    const client = typeof req.p?.['client'] === 'string' ? req.p['client'] : 'unknown client';

    if (req.v !== PROTOCOL_V) {
      this.sendErr(
        req.id,
        'protocol_mismatch',
        `${client} speaks protocol v${req.v}, daemon ${this.ctx.build} speaks v${PROTOCOL_V}; restart the daemon so both run the same build`,
      );

      return false;
    }

    this.helloed = true;

    this.sendOk(req.id, {
      daemon: this.ctx.build,
      limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
    });

    return true;
  }

  private sendOk(id: number, ok: Readonly<Record<string, unknown>>): void {
    this.queue.send(encodeMessage({ v: PROTOCOL_V, id, ok }));
  }

  private sendErr(id: number, code: ErrorCode, msg: string): void {
    this.queue.send(encodeMessage({ v: PROTOCOL_V, id, err: { code, msg } }));
  }
}
