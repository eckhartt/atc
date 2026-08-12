import { unlinkSync } from 'node:fs';
import type { UnixSocketListener } from 'bun';
import { OutboundQueue } from './outbound-queue';
import type { SocketWriter } from './outbound-queue';
import { MAX_CHUNK, MAX_LINE, PROTOCOL_V, decodeMessage, encodeMessage } from './protocol';
import type { ErrorCode, RequestMsg } from './protocol';

export interface DaemonOptions {
  readonly socketPath: string;

  // Build string sent in the handshake and in mismatch errors, e.g. "atc/0.1.0".
  readonly build: string;
}

/**
 * The daemon's client-protocol listener: NDJSON requests over a unix socket,
 * one response per request. The first request on a connection must be
 * `daemon.hello`; an unknown method is an error, never a disconnect; a
 * malformed or oversized line is a disconnect, because transports guarantee
 * byte integrity and such a line means a buggy or hostile peer.
 */
export function startDaemon(opts: DaemonOptions): UnixSocketListener<Connection> {
  try {
    unlinkSync(opts.socketPath);
  } catch {}

  return Bun.listen<Connection>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        socket.data = new Connection(socket, opts);
      },
      data(socket, buf) {
        socket.data.applyChunk(buf.toString());
      },
      drain(socket) {
        socket.data.drain();
      },
      error() {},
    },
  });
}

interface PeerSocket extends SocketWriter {
  readonly end: () => void;
}

class Connection {
  private readonly peer: PeerSocket;

  private readonly opts: DaemonOptions;

  private readonly queue: OutboundQueue;

  private buffer = '';

  private helloed = false;

  constructor(peer: PeerSocket, opts: DaemonOptions) {
    this.peer = peer;
    this.opts = opts;

    this.queue = new OutboundQueue(peer);
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

    switch (req.m) {
      case 'daemon.ping': {
        this.sendOk(req.id, {});

        return true;
      }
      default: {
        this.sendErr(req.id, 'unknown_method', `unknown method '${req.m}'`);

        return true;
      }
    }
  }

  private applyHello(req: RequestMsg): boolean {
    const client = typeof req.p?.['client'] === 'string' ? req.p['client'] : 'unknown client';

    if (req.v !== PROTOCOL_V) {
      this.sendErr(
        req.id,
        'protocol_mismatch',
        `${client} speaks protocol v${req.v}, daemon ${this.opts.build} speaks v${PROTOCOL_V}; restart the daemon so both run the same build`,
      );

      return false;
    }

    this.helloed = true;

    this.sendOk(req.id, {
      daemon: this.opts.build,
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
