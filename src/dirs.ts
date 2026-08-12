import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { stateDir } from './config';

const historyFile = join(stateDir, 'spawn-history.json');

function loadHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(historyFile, 'utf8'));

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((d): d is string => typeof d === 'string');
  } catch {
    return [];
  }
}

export function recordSpawn(dir: string) {
  const hist = [dir, ...loadHistory().filter((d) => d !== dir)].slice(0, 50);

  writeFileSync(historyFile, JSON.stringify(hist, null, 2));
}

// Spawn-history first (most recently used), then zoxide's frecency list.
export async function collectDirs(): Promise<string[]> {
  let zoxide: string[] = [];

  try {
    const proc = Bun.spawn(['zoxide', 'query', '-l'], { stdout: 'pipe', stderr: 'ignore' });

    const text = await new Response(proc.stdout).text();

    zoxide = text.split('\n').filter((line) => line !== '');
  } catch {}

  const seen = new Set<string>();

  const found: string[] = [];

  for (const d of [...loadHistory(), ...zoxide]) {
    if (!seen.has(d) && existsSync(d)) {
      seen.add(d);
      found.push(d);
    }
  }

  if (found.length === 0) {
    found.push(homedir());
  }

  return found;
}

export function pickMatches(items: readonly string[], filter: string): string[] {
  if (filter === '') {
    return [...items];
  }

  const f = filter.toLowerCase();

  const scored = items
    .map((item) => {
      const base = basename(item).toLowerCase();
      let score = -1;

      if (base.startsWith(f)) {
        score = 0;
      } else if (base.includes(f)) {
        score = 1;
      } else if (item.toLowerCase().includes(f)) {
        score = 2;
      }

      return { item, score };
    })
    .filter((x) => x.score >= 0);

  return scored.toSorted((a, b) => a.score - b.score).map((x) => x.item);
}

export function formatDir(d: string): string {
  const home = homedir();

  return d.startsWith(home) ? `~${d.slice(home.length)}` : d;
}
