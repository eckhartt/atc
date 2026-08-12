import { statSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';

/**
 * The build identity used in the protocol handshake. The version alone
 * never changes between pulls, so the entry file's mtime (or the compiled
 * binary's) is folded in — a client and daemon from different checkouts of
 * the same version still read as different builds, which is what triggers
 * the stale-daemon restart.
 */
export function getBuild(): string {
  let stamp = 0;

  try {
    stamp = statSync(join(import.meta.dir, 'cli.ts')).mtimeMs;
  } catch {
    try {
      stamp = statSync(process.execPath).mtimeMs;
    } catch {}
  }

  return `atc/${pkg.version}+${Math.round(stamp).toString(36)}`;
}
