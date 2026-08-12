import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from './report';

export interface Config {
  claudeBin: string;
  claudeArgs: string[];
}

const DEFAULTS: Config = {
  claudeBin: 'claude',
  claudeArgs: [],
};

const configDir = join(homedir(), '.config', 'atc');

export const stateDir = join(homedir(), '.local', 'state', 'atc');
export const socketPath = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc.sock');
export const daemonSocketPath = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc-daemon.sock');
export const statusFile = join(stateDir, 'status.json');

export function loadConfig(): Config {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const file = join(configDir, 'config.json');

  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`);

    return { ...DEFAULTS };
  }

  try {
    const raw = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!isRecord(parsed)) {
      return { ...DEFAULTS };
    }

    const claudeBin =
      typeof parsed['claudeBin'] === 'string' ? parsed['claudeBin'] : DEFAULTS.claudeBin;

    const claudeArgs = Array.isArray(parsed['claudeArgs'])
      ? parsed['claudeArgs'].filter((a): a is string => typeof a === 'string')
      : DEFAULTS.claudeArgs;

    return { claudeBin, claudeArgs };
  } catch {
    return { ...DEFAULTS };
  }
}
