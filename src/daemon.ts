import { unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import type { AgentAdapter } from './agent-adapter';
import { AttachRegistry } from './attach-registry';
import type { Dims } from './attach-registry';
import { logEvent, startHookServer } from './hooks';
import { OutboundQueue } from './outbound-queue';
import type { SocketWriter } from './outbound-queue';
import { PermissionRegistry } from './permission-registry';
import type { AnswerResult } from './permission-registry';
import { MAX_CHUNK, MAX_LINE, PROTOCOL_V, decodeMessage, encodeMessage } from './protocol';
import type { ErrorCode, EventMsg, RequestMsg } from './protocol';
import { SessionManager, loadFleet } from './sessions';
import type { SessionDescriptor, SessionState } from './sessions';

export interface DaemonOptions {
  readonly socketPath: string;
  readonly reporterSocketPath: string;

  // Build string sent in the handshake and in mismatch errors, e.g. "atc/0.1.0".
  readonly build: string;
  readonly adapter: AgentAdapter;

  // Outbound queue capacity per client; small values force desync in tests.
  readonly queueBytes?: number;
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

  const emitEvent = (event: EventMsg) => {
    for (const client of clients) {
      client.sendEvent(event);
    }
  };

  const registry = new PermissionRegistry();

  registry.onRequested = (req) => {
    emitEvent({
      v: PROTOCOL_V,
      ev: 'permission.requested',
      request: req.id,
      s: req.sessionID,
      message: req.message,
      respondable: req.respondable,
    });
  };

  registry.onResolved = (id, decision) => {
    emitEvent({ v: PROTOCOL_V, ev: 'permission.resolved', request: id, decision });
  };

  const attachments = new AttachRegistry<OutputClient>();
  const seqs = new Map<string, number>();
  const ptyDims = new Map<string, Dims>();
  const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const applyEffectiveDims = (sessionID: string) => {
    const dims = attachments.findEffectiveDims(sessionID);

    if (dims === null) {
      return;
    }

    const prev = ptyDims.get(sessionID);

    if (prev !== undefined && prev.cols === dims.cols && prev.rows === dims.rows) {
      return;
    }

    const s = mgr.sessions.find((x) => x.id === sessionID);

    s?.pty?.resize(dims.cols, dims.rows);
    ptyDims.set(sessionID, dims);

    emitEvent({
      v: PROTOCOL_V,
      ev: 'session.resized',
      s: sessionID,
      cols: dims.cols,
      rows: dims.rows,
    });
  };

  // Debounced so two clients resizing in opposite directions cannot produce
  // a SIGWINCH storm; a no-op effective size never reaches the PTY.
  const scheduleResize = (sessionID: string) => {
    if (resizeTimers.has(sessionID)) {
      return;
    }

    resizeTimers.set(
      sessionID,
      setTimeout(() => {
        resizeTimers.delete(sessionID);

        applyEffectiveDims(sessionID);
      }, 50),
    );
  };

  // A resize down and back up forces a full repaint from the hosted agent;
  // this is the pre-screen-model replay on attach and desync recovery.
  const jiggleSession = (sessionID: string) => {
    const s = mgr.sessions.find((x) => x.id === sessionID);

    if (s === undefined || s.pty === null) {
      return;
    }

    const dims = ptyDims.get(sessionID) ?? { cols: 80, rows: 24 };

    s.pty.resize(dims.cols, Math.max(2, dims.rows - 1));

    setTimeout(() => {
      s.pty?.resize(dims.cols, dims.rows);
    }, 60);
  };

  mgr.onOutput = (s, data) => {
    const conns = attachments.collectClients(s.id);

    if (conns.length === 0) {
      return;
    }

    let seq = seqs.get(s.id) ?? 0;

    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      const chunk = data.slice(i, i + MAX_CHUNK);

      seq++;

      const event: EventMsg = { v: PROTOCOL_V, ev: 'session.output', s: s.id, seq, d: chunk };

      for (const conn of conns) {
        conn.sendOutput(s.id, event, chunk.length);
      }
    }

    seqs.set(s.id, seq);
  };

  // Permission requests are synthesized from attention transitions: entering
  // needs_you opens one, and leaving it (answered directly in the terminal,
  // or the session dying) dismisses whatever is pending.
  const lastStates = new Map<string, SessionState>();

  const recordAttention: SessionManager['onEvent'] = (kind, s) => {
    if (kind === 'removed') {
      registry.answerAll(s.id, 'dismissed');
      lastStates.delete(s.id);

      return;
    }

    const prev = lastStates.get(s.id);

    lastStates.set(s.id, s.state);

    if (s.state === 'needs_you' && prev !== 'needs_you') {
      registry.open(s.id, s.lastMsg, false);
    }

    if (prev === 'needs_you' && s.state !== 'needs_you') {
      registry.answerAll(s.id, 'dismissed');
    }
  };

  mgr.onEvent = (kind, s) => {
    recordAttention(kind, s);

    if (kind === 'removed') {
      attachments.removeSession(s.id);
      seqs.delete(s.id);
      ptyDims.delete(s.id);
    }

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

    emitEvent(builders[kind]());
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

      ptyDims.set(s.id, { cols: p.cols, rows: p.rows });

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
    answerPermission: (request, decision) => registry.answer(request, decision),
    attachSession: (client, sessionID, dims) => {
      const s = mgr.sessions.find((x) => x.id === sessionID);

      if (s === undefined) {
        return 'missing';
      }

      if (s.pty === null) {
        return 'dead';
      }

      attachments.attach(sessionID, client, dims);

      scheduleResize(sessionID);
      jiggleSession(sessionID);

      return 'ok';
    },
    detachSession: (client, sessionID) => {
      attachments.detach(sessionID, client);

      scheduleResize(sessionID);
    },
    detachClient: (client) => {
      for (const sessionID of attachments.detachAll(client)) {
        scheduleResize(sessionID);
      }
    },
    writeSessionInput: (sessionID, data) => {
      const s = mgr.sessions.find((x) => x.id === sessionID);

      if (s === undefined) {
        return 'missing';
      }

      if (s.pty === null) {
        return 'dead';
      }

      s.pty.write(data);

      return 'ok';
    },
    resizeSession: (client, sessionID, dims) => {
      if (!attachments.updateDims(sessionID, client, dims)) {
        return false;
      }

      scheduleResize(sessionID);

      return true;
    },
    jiggleSession,
    ...(opts.queueBytes === undefined ? {} : { queueBytes: opts.queueBytes }),
    getEffectiveDims: (sessionID) =>
      attachments.findEffectiveDims(sessionID) ?? ptyDims.get(sessionID) ?? { cols: 80, rows: 24 },
    restoreFleet: (cols, rows) => {
      let restored = 0;

      for (const entry of loadFleet()) {
        const live = mgr.sessions.some((s) => s.pty !== null && s.claudeId === entry.claudeId);

        if (live) {
          continue;
        }

        const s = mgr.spawn(entry.cwd, entry.name, '', cols, rows, entry.claudeId);

        ptyDims.set(s.id, { cols, rows });

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
        ctx.detachClient(socket.data);
      },
      error() {},
    },
  });

  return {
    stop() {
      for (const timer of resizeTimers.values()) {
        clearTimeout(timer);
      }

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
  readonly answerPermission: (request: string, decision: string) => AnswerResult;
  readonly restoreFleet: (cols: number, rows: number) => number;
  readonly attachSession: (
    client: OutputClient,
    sessionID: string,
    dims: Dims,
  ) => 'ok' | 'missing' | 'dead';
  readonly detachSession: (client: OutputClient, sessionID: string) => void;
  readonly detachClient: (client: OutputClient) => void;
  readonly writeSessionInput: (sessionID: string, data: string) => 'ok' | 'missing' | 'dead';
  readonly resizeSession: (client: OutputClient, sessionID: string, dims: Dims) => boolean;
  readonly jiggleSession: (sessionID: string) => void;
  readonly queueBytes?: number;
  readonly getEffectiveDims: (sessionID: string) => Dims;
}

// The slice of a connection the attach bookkeeping needs: identity plus the
// ability to receive output events.
interface OutputClient {
  readonly sendOutput: (sessionID: string, event: EventMsg, byteLength: number) => void;
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

  private readonly desynced = new Map<string, number>();

  constructor(peer: PeerSocket, ctx: DaemonContext) {
    this.peer = peer;
    this.ctx = ctx;

    this.queue = new OutboundQueue(peer, ctx.queueBytes);
  }

  sendEvent(event: EventMsg): void {
    if (this.helloed && !this.queue.send(encodeMessage(event))) {
      this.peer.end();
    }
  }

  // Output is droppable: an overflow discards this session's backlog for
  // this client and resynchronizes with a repaint once the queue drains. An
  // intermediate chunk is never dropped without that resync, because a byte
  // stream cut mid-escape corrupts the client's terminal state.
  sendOutput(sessionID: string, event: EventMsg, byteLength: number): void {
    if (!this.helloed) {
      return;
    }

    const dropped = this.desynced.get(sessionID);

    if (dropped !== undefined) {
      this.desynced.set(sessionID, dropped + byteLength);

      return;
    }

    if (!this.queue.send(encodeMessage(event))) {
      this.desynced.set(sessionID, byteLength);
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

    if (this.queue.queuedBytes > 0 || this.desynced.size === 0) {
      return;
    }

    for (const [sessionID, dropped] of this.desynced) {
      this.desynced.delete(sessionID);
      this.sendEvent({ v: PROTOCOL_V, ev: 'session.desync', s: sessionID, dropped });
      this.ctx.jiggleSession(sessionID);
    }
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
      case 'session.attach': {
        this.applyAttach(req);

        return;
      }
      case 'session.detach': {
        const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';

        this.ctx.detachSession(this, sessionID);
        this.sendOk(req.id, {});

        return;
      }
      case 'session.input': {
        this.applyInput(req);

        return;
      }
      case 'session.resize': {
        this.applyResize(req);

        return;
      }
      case 'permission.respond': {
        this.applyPermissionRespond(req);

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

  private applyAttach(req: RequestMsg): void {
    const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';
    const cols = typeof req.p?.['cols'] === 'number' ? req.p['cols'] : 80;
    const rows = typeof req.p?.['rows'] === 'number' ? req.p['rows'] : 24;
    const result = this.ctx.attachSession(this, sessionID, { cols, rows });

    if (result === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    const dims = this.ctx.getEffectiveDims(sessionID);

    this.sendOk(req.id, { cols: dims.cols, rows: dims.rows });
  }

  private applyInput(req: RequestMsg): void {
    const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';
    const data = typeof req.p?.['d'] === 'string' ? req.p['d'] : '';
    const result = this.ctx.writeSessionInput(sessionID, data);

    if (result === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    this.sendOk(req.id, {});
  }

  private applyResize(req: RequestMsg): void {
    const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';
    const cols = typeof req.p?.['cols'] === 'number' ? req.p['cols'] : 0;
    const rows = typeof req.p?.['rows'] === 'number' ? req.p['rows'] : 0;

    if (cols < 1 || rows < 1) {
      this.sendErr(req.id, 'bad_args', 'session.resize requires positive cols and rows');

      return;
    }

    if (!this.ctx.resizeSession(this, sessionID, { cols, rows })) {
      this.sendErr(req.id, 'bad_args', `not attached to session '${sessionID}'`);

      return;
    }

    this.sendOk(req.id, {});
  }

  private applyPermissionRespond(req: RequestMsg): void {
    const request = typeof req.p?.['request'] === 'string' ? req.p['request'] : '';
    const decision = typeof req.p?.['decision'] === 'string' ? req.p['decision'] : '';

    if (request === '' || decision === '') {
      this.sendErr(req.id, 'bad_args', 'permission.respond requires a request and a decision');

      return;
    }

    const result = this.ctx.answerPermission(request, decision);

    switch (result) {
      case 'ok': {
        this.sendOk(req.id, {});

        return;
      }
      case 'already_answered': {
        this.sendErr(req.id, 'already_answered', `request '${request}' was already answered`);

        return;
      }
      case 'unsupported': {
        this.sendErr(req.id, 'unsupported', `request '${request}' is answered with keystrokes`);

        return;
      }
      case 'unknown': {
        this.sendErr(req.id, 'bad_args', `unknown permission request '${request}'`);
      }
    }
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
