import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  AdapterEvent,
  AgentAdapter,
  NameUpdate,
  SpawnOptions,
  SpawnPlan,
} from './agent-adapter';
import type { Config } from './config';
import { stateDir } from './config';
import type { HookEvent } from './hooks';
import { isRecord } from './report';

/**
 * The Claude Code adapter: spawn arguments, `--settings` instrumentation,
 * resume semantics, transcript name-pulling, and statusline chaining.
 */
export class ClaudeAdapter implements AgentAdapter {
  // Claude's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  private readonly config: Config;

  private readonly settingsFile: string;

  constructor(config: Config) {
    this.config = config;
    this.settingsFile = writeHookSettings();
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    return {
      bin: this.config.claudeBin,
      args: [
        ...this.config.claudeArgs,
        '--settings',
        this.settingsFile,
        ...(opts.resume === true ? ['--resume'] : []),
        ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
    };
  }

  normalizeHook(e: HookEvent): AdapterEvent {
    const sessionID = e.payload['session_id'];
    const transcript = e.payload['transcript_path'];

    const base: AdapterEvent = {
      kind: 'heartbeat',
      ...(typeof sessionID === 'string' ? { agentSessionID: sessionID } : {}),
    };

    const named: AdapterEvent = {
      ...base,
      ...(typeof transcript === 'string' ? { nameSource: transcript } : {}),
    };

    switch (e.event) {
      case 'SessionStart': {
        return { ...named, kind: 'started' };
      }
      case 'Notification': {
        const message = e.payload['message'];

        return {
          ...base,
          kind: 'needs-input',
          ...(typeof message === 'string' && message !== '' ? { message } : {}),
        };
      }
      case 'Stop': {
        return { ...named, kind: 'turn-done' };
      }
      case 'UserPromptSubmit': {
        const prompt = e.payload['prompt'];
        const preview = typeof prompt === 'string' ? prompt.slice(0, 80) : '';

        return {
          ...named,
          kind: 'prompt-submitted',
          ...(preview === '' ? {} : { message: preview }),
        };
      }
      case 'SessionEnd': {
        return { ...base, kind: 'ended' };
      }
      default: {
        return base;
      }
    }
  }

  // Claude is the naming authority: /rename writes custom-title lines to the
  // transcript, auto-summaries write summary lines. A custom title always
  // wins; a summary never overrides a user-typed name.
  async loadName(source: string, namedBy: 'user' | 'auto' | 'agent'): Promise<NameUpdate | null> {
    try {
      const proc = Bun.spawn(['grep', '-E', '"type":"(custom-title|summary)"', source], {
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

      if (title !== undefined && title !== '') {
        return { name: title, namedBy: 'agent' };
      }

      if (namedBy !== 'user' && summary !== undefined && summary !== '') {
        return { name: summary };
      }

      return null;
    } catch {
      return null;
    }
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(cwd: string, agentSessionID: string | undefined): string | null {
    const resume =
      agentSessionID === undefined ? 'claude --resume' : `claude --resume ${agentSessionID}`;

    const quoted = cwd.replaceAll("'", String.raw`'\''`);

    return `cd '${quoted}' && ${resume}`;
  }
}

// Settings file injected into wrangled sessions via `claude --settings`.
// The user's own settings are untouched; these hooks only exist in sessions
// atc spawns, and identify themselves via ATC_SESSION_ID in the env.
function writeHookSettings(): string {
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
