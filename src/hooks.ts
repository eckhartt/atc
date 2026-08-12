import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { socketPath, stateDir } from './config';
import { isRecord } from './report';

export interface HookEvent {
  atcId: string;
  event: string;
  payload: Record<string, unknown>;
}

// Settings file injected into wrangled sessions via `claude --settings`.
// The user's own settings are untouched; these hooks only exist in sessions
// atc spawns, and identify themselves via ATC_SESSION_ID in the env.
export function writeHookSettings(): string {
  const cmd = buildCLICommand('hook-report');
  const entry = [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }];

  const settings = {
    hooks: {
      // SessionStart carries the session id at spawn/resume time, before any
      // interaction — without it a session only enters the fleet file after
      // its first prompt/notification.
      SessionStart: entry,
      Notification: entry,
      Stop: entry,
      UserPromptSubmit: entry,
      SessionEnd: entry,
    },
  };

  // Fleet status renders inside Claude Code's own status line; the injected
  // command chains the user's configured statusline first, so mirror their
  // padding.
  let padding = 0;

  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const raw = readFileSync(settingsPath, 'utf8');
    const user: unknown = JSON.parse(raw);
    const statusLine = isRecord(user) ? user['statusLine'] : undefined;
    const userPadding = isRecord(statusLine) ? statusLine['padding'] : undefined;

    if (typeof userPadding === 'number') {
      padding = userPadding;
    }
  } catch {}

  const statusline = {
    type: 'command',
    command: buildCLICommand('statusline'),
    padding,
  };

  const file = join(stateDir, 'hook-settings.json');

  writeFileSync(file, JSON.stringify({ ...settings, statusLine: statusline }, null, 2));

  return file;
}

// Wrangled sessions invoke atc subcommands: under bun the CLI entry path is
// part of the command; a compiled binary is itself the entry.
function buildCLICommand(subcommand: string): string {
  const exec = process.execPath;

  if (basename(exec) === 'bun' || basename(exec) === 'bun.exe') {
    return `"${exec}" "${join(import.meta.dir, 'cli.ts')}" ${subcommand}`;
  }

  return `"${exec}" ${subcommand}`;
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

export function startHookServer(onEvent: (e: HookEvent) => void) {
  try {
    unlinkSync(socketPath);
  } catch {}

  return Bun.listen<string>({
    unix: socketPath,
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
