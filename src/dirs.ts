import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { stateDir } from "./config";

const historyFile = join(stateDir, "spawn-history.json");

export function loadHistory(): string[] {
  try {
    return JSON.parse(readFileSync(historyFile, "utf8"));
  } catch {
    return [];
  }
}

export function recordSpawn(dir: string) {
  const hist = [dir, ...loadHistory().filter((d) => d !== dir)].slice(0, 50);
  writeFileSync(historyFile, JSON.stringify(hist, null, 2));
}

// Spawn-history first (most recently used), then zoxide's frecency list.
export async function candidateDirs(): Promise<string[]> {
  let zoxide: string[] = [];
  try {
    const proc = Bun.spawn(["zoxide", "query", "-l"], { stdout: "pipe", stderr: "ignore" });
    zoxide = (await new Response(proc.stdout).text()).split("\n").filter(Boolean);
  } catch {}
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...loadHistory(), ...zoxide]) {
    if (!seen.has(d) && existsSync(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  if (out.length === 0) out.push(homedir());
  return out;
}

export function fuzzyFilter(dirs: string[], filter: string): string[] {
  if (!filter) return dirs;
  const f = filter.toLowerCase();
  const scored = dirs
    .map((d) => {
      const base = basename(d).toLowerCase();
      let score = -1;
      if (base.startsWith(f)) score = 0;
      else if (base.includes(f)) score = 1;
      else if (d.toLowerCase().includes(f)) score = 2;
      return { d, score };
    })
    .filter((x) => x.score >= 0);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.d);
}

export function displayDir(d: string): string {
  const home = homedir();
  return d.startsWith(home) ? "~" + d.slice(home.length) : d;
}
