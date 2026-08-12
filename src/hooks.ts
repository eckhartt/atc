import { appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { socketPath, stateDir } from './config';
import { isRecord } from './report';

export interface HookEvent {
  atcId: string;
  event: string;
  payload: Record<string, unknown>;
}

// Debug trail for state-machine issues: one JSON line per received hook event.
const eventLog = join(stateDir, 'events.log');

export function logEvent(e: HookEvent) {
  const line = {
    ts: new Date().toISOString(),
    atcId: e.atcId,
    event: e.event,
    message: e.payload['message'],
    session_id: e.payload['session_id'],
  };

  try {
    appendFileSync(eventLog, `${JSON.stringify(line)}\n`);
  } catch {}
}

export function startHookServer(onEvent: (e: HookEvent) => void, path: string = socketPath) {
  try {
    unlinkSync(path);
  } catch {}

  return Bun.listen<string>({
    unix: path,
    socket: {
      data(socket, buf) {
        const buffered = (socket.data ?? '') + buf.toString();
        const lines = buffered.split('\n');

        socket.data = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim() === '') {
            continue;
          }

          try {
            const parsed: unknown = JSON.parse(line);

            if (
              isRecord(parsed) &&
              typeof parsed['atcId'] === 'string' &&
              typeof parsed['event'] === 'string' &&
              isRecord(parsed['payload'])
            ) {
              onEvent({
                atcId: parsed['atcId'],
                event: parsed['event'],
                payload: parsed['payload'],
              });
            }
          } catch {}
        }
      },
      open(socket) {
        socket.data = '';
      },
      error() {},
    },
  });
}
