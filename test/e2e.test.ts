import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'bun-pty';
import type { IPty } from 'bun-pty';

const repo = join(import.meta.dir, '..');
let home: string;
let p: IPty | null = null;
let out = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'atc-test-'));

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });

  const fakeClaude = join(home, 'fake-claude');

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | "${process.execPath}" "${join(repo, 'src', 'hook-report.ts')}"
sleep 0.3
printf '{"hook_event_name":"Notification","session_id":"fake-1","message":"needs permission"}' | "${process.execPath}" "${join(repo, 'src', 'hook-report.ts')}"
sleep 30
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({ claudeBin: fakeClaude, claudeArgs: [] }),
  );
});

afterEach(() => {
  p?.kill();
  p = null;
  out = '';

  rmSync(home, { recursive: true, force: true });
});

function collectEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
}

function boot(): IPty {
  const pty = spawn(process.execPath, [join(repo, 'src', 'index.ts')], {
    name: 'xterm-256color',
    cols: 110,
    rows: 30,
    cwd: repo,
    env: collectEnv({ HOME: home, XDG_RUNTIME_DIR: home, PATH: '/usr/sbin:/usr/bin:/bin' }),
  });

  pty.onData((d) => {
    out += d;
  });

  return pty;
}

async function waitFor(needle: string, ms = 4000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < ms) {
    if (out.includes(needle)) {
      return;
    }

    await Bun.sleep(50);
  }

  throw new Error(
    `timed out waiting for ${JSON.stringify(needle)}; tail: ${JSON.stringify(out.slice(-400))}`,
  );
}

async function spawnSession(pty: IPty, name: string) {
  pty.write('n');

  await waitFor('spawn: directory');

  pty.write('\r');

  await waitFor('spawn: name');

  out = '';

  pty.write(`${name}\r`);

  await waitFor('spawn: initial prompt');

  out = '';

  pty.write('\r');

  await waitFor('FAKE_CLAUDE_UP');
}

test('spawn, hook status, overlay, kill, quit', async () => {
  p = boot();

  await waitFor('atc — control tower');
  await spawnSession(p, 'testsess');

  expect(out).toContain('--settings');

  p.write('\u0000');

  await waitFor('NEEDS YOU');
  await waitFor('need you: testsess'); // overlay-mode status bar

  p.write('K');

  await waitFor('kill selected session?');

  p.write('y');

  await Bun.sleep(300);

  let exited = false;

  p.onExit(() => {
    exited = true;
  });

  p.write('q');

  await Bun.sleep(500);

  expect(exited).toBe(true);
});

test('attaching a needs-you session clears its need state', async () => {
  p = boot();

  await waitFor('atc — control tower');
  await spawnSession(p, 'needytest');

  p.write('\u0000');

  await waitFor('NEEDS YOU');

  p.write('\r'); // attach the selected (needs-you) session

  const statusPath = join(home, '.local', 'state', 'atc', 'status.json');
  const start = Date.now();
  let cleared = false;

  while (Date.now() - start < 3000) {
    const rawStatus = await Bun.file(statusPath)
      .text()
      .catch(() => '');

    if (rawStatus.includes('"needs_you":0')) {
      cleared = true;
      break;
    }

    await Bun.sleep(50);
  }

  expect(cleared).toBe(true);
});

test('overlay slash filter narrows the session list', async () => {
  p = boot();

  await waitFor('atc — control tower');
  await spawnSession(p, 'alpha');

  p.write('\u0000');

  await waitFor('NEEDS YOU');

  p.write('\r'); // attach alpha, clearing its needs-you state

  await Bun.sleep(200);

  out = '';

  p.write('\u0000');

  await waitFor('sessions');

  p.write('n'); // spawn second session from the overlay

  await waitFor('spawn: directory');

  p.write('\r');

  await waitFor('spawn: name');

  p.write('bravo\r');

  await waitFor('spawn: initial prompt');

  p.write('\r');

  await waitFor('FAKE_CLAUDE_UP');

  out = '';

  p.write('\u0000');

  await waitFor('bravo');

  p.write('/');

  await waitFor('type to filter');

  out = '';

  p.write('brav');

  await waitFor('/ brav');
  await waitFor('bravo');

  expect(out).not.toContain('alpha ');
});

test('adopt passes --resume and yank copies resume command', async () => {
  p = boot();

  await waitFor('adopt an existing session');

  p.write('r');

  await waitFor('adopt: directory');

  p.write('\r');

  await waitFor('adopt: name');

  out = '';

  p.write('adopted\r');

  await waitFor('FAKE_CLAUDE_UP');

  expect(out).toContain('--resume');

  p.write('\u0000');

  await waitFor('need you: adopted');
  await waitFor('y yank');

  out = '';

  p.write('y');

  await waitFor('resume cmd copied');

  const b64 = out.split(']52;c;')[1]?.split('\u0007')[0];

  if (b64 === undefined) {
    throw new Error('no OSC52 sequence in output');
  }

  const cmd = Buffer.from(b64, 'base64').toString();

  expect(cmd).toContain('claude --resume fake-1');
  expect(cmd.startsWith("cd '")).toBe(true);
});

test('statusline chains user command and appends fleet segment', async () => {
  mkdirSync(join(home, '.claude'), { recursive: true });

  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo CHAINED-SEGMENT' } }),
  );

  mkdirSync(join(home, '.local', 'state', 'atc'), { recursive: true });

  writeFileSync(
    join(home, '.local', 'state', 'atc', 'status.json'),
    JSON.stringify({ needs_you: 2, running: 1, done: 0, exited: 0, urgent: 'auth-bug' }),
  );

  const proc = Bun.spawn([process.execPath, join(repo, 'src', 'statusline.ts')], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'sl-1' })),
    env: collectEnv({ HOME: home, PATH: '/usr/sbin:/usr/bin:/bin' }),
    stdout: 'pipe',
  });

  const line = await new Response(proc.stdout).text();

  expect(line).toContain('CHAINED-SEGMENT');
  expect(line).toContain('2 need you: auth-bug');
  expect(line).toContain('◐ 1');
});

test('session name pulled from claude transcript custom-title', async () => {
  writeFileSync(
    join(home, 'fake-transcript.jsonl'),
    `${JSON.stringify({
      type: 'custom-title',
      customTitle: 'claude-named',
      sessionId: 'fake-1',
    })}\n`,
  );

  p = boot();

  await waitFor('atc — control tower');
  await spawnSession(p, 'typedname');

  p.write('\u0000');

  await waitFor('claude-named'); // /rename in claude overrides even a typed atc name
});

test('fleet survives crash and restores with recorded id', async () => {
  p = boot();

  await waitFor('atc — control tower');
  await spawnSession(p, 'fleettest');

  // SessionStart alone must be enough to enter the fleet — no interaction,
  // no notification required.
  const fleetFile = Bun.file(join(home, '.local', 'state', 'atc', 'fleet.json'));
  const start = Date.now();
  let fleet: unknown[] = [];

  while (Date.now() - start < 3000) {
    const rawFleet = await fleetFile.text().catch(() => '[]');

    let parsed: unknown = [];

    try {
      parsed = JSON.parse(rawFleet);
    } catch {}

    fleet = Array.isArray(parsed) ? parsed : [];

    if (fleet.length > 0) {
      break;
    }

    await Bun.sleep(50);
  }

  p.kill(); // simulate atc crash

  await Bun.sleep(300);

  expect(fleet).toEqual([{ name: 'fleettest', cwd: home, claudeId: 'fake-1' }]);

  out = '';
  p = boot();

  await waitFor('restore last fleet (1 sessions)');

  out = '';

  p.write('R');

  await waitFor('FAKE_CLAUDE_UP');
  await waitFor('--resume fake-1');
});
