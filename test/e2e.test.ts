import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'bun-pty';
import type { IPty } from 'bun-pty';

const repo = join(import.meta.dir, '..');
const CTRL_SPACE = String.fromCodePoint(0);
const BEL = String.fromCodePoint(7);

function collectEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
}

interface TestContext {
  home: string;
  boot: () => IPty;
  read: () => string;
  reset: () => void;
  waitFor: (needle: string, ms?: number) => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

function setupTest(): TestContext {
  const home = mkdtempSync(join(tmpdir(), 'atc-test-'));

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

  let pty: IPty | null = null;
  let out = '';

  return {
    home,

    boot() {
      pty = spawn(process.execPath, [join(repo, 'src', 'index.ts')], {
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
    },

    read() {
      return out;
    },

    reset() {
      out = '';
    },

    async waitFor(needle: string, ms = 4000) {
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
    },

    [Symbol.asyncDispose]() {
      pty?.kill();
      rmSync(home, { recursive: true, force: true });

      return Promise.resolve();
    },
  };
}

async function spawnSession(ctx: TestContext, pty: IPty, name: string) {
  pty.write('n');

  await ctx.waitFor('spawn: directory');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  ctx.reset();
  pty.write(`${name}\r`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP');
}

test('it surfaces a needs-you session in the overlay and kills it on confirm', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'testsess');

  expect(ctx.read()).toInclude('--settings');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');
  await ctx.waitFor('need you: testsess');

  pty.write('K');

  await ctx.waitFor('kill selected session?');

  pty.write('y');

  await Bun.sleep(300); // the kill has no on-screen marker to wait for before quitting

  let exited = false;

  pty.onExit(() => {
    exited = true;
  });

  pty.write('q');

  await Bun.sleep(500); // quit tears the process down; only the exit event observes it

  expect(exited).toBe(true);
});

test('it clears the need state when attaching a needy session', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'needytest');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('\r');

  const statusPath = join(ctx.home, '.local', 'state', 'atc', 'status.json');
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

test('it narrows the overlay to sessions matching the slash filter', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'alpha');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('\r'); // attach alpha so it stops being the urgent session in the status bar

  await Bun.sleep(200); // the attach repaint has no unique marker to wait for

  ctx.reset();
  pty.write(CTRL_SPACE);

  await ctx.waitFor('sessions');

  pty.write('n');

  await ctx.waitFor('spawn: directory');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  pty.write('bravo\r');

  await ctx.waitFor('spawn: initial prompt');

  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  pty.write(CTRL_SPACE);

  await ctx.waitFor('bravo');

  pty.write('/');

  await ctx.waitFor('type to filter');

  ctx.reset();
  pty.write('brav');

  await ctx.waitFor('/ brav');
  await ctx.waitFor('bravo');

  expect(ctx.read()).not.toInclude('alpha ');
});

test('it adopts a session with --resume and yanks its resume command', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('adopt an existing session');

  pty.write('r');

  await ctx.waitFor('adopt: directory');

  pty.write('\r');

  await ctx.waitFor('adopt: name');

  ctx.reset();
  pty.write('adopted\r');

  await ctx.waitFor('FAKE_CLAUDE_UP');

  expect(ctx.read()).toInclude('--resume');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('need you: adopted');
  await ctx.waitFor('y yank');

  ctx.reset();
  pty.write('y');

  await ctx.waitFor('resume cmd copied');

  const b64 = ctx.read().split(']52;c;')[1]?.split(BEL)[0];

  if (b64 === undefined) {
    throw new Error('no OSC52 sequence in output');
  }

  const cmd = Buffer.from(b64, 'base64').toString();

  expect(cmd).toInclude('claude --resume fake-1');
  expect(cmd).toStartWith("cd '");
});

test('it chains the user statusline and appends the fleet segment', async () => {
  await using ctx = setupTest();

  mkdirSync(join(ctx.home, '.claude'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo CHAINED-SEGMENT' } }),
  );

  mkdirSync(join(ctx.home, '.local', 'state', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.local', 'state', 'atc', 'status.json'),
    JSON.stringify({ needs_you: 2, running: 1, done: 0, exited: 0, urgent: 'auth-bug' }),
  );

  const proc = Bun.spawn([process.execPath, join(repo, 'src', 'statusline.ts')], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'sl-1' })),
    env: collectEnv({ HOME: ctx.home, PATH: '/usr/sbin:/usr/bin:/bin' }),
    stdout: 'pipe',
  });

  const line = await new Response(proc.stdout).text();

  expect(line).toInclude('CHAINED-SEGMENT');
  expect(line).toInclude('2 need you: auth-bug');
  expect(line).toInclude('◐ 1');
});

test('it renames a session from the claude transcript custom-title', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    `${JSON.stringify({
      type: 'custom-title',
      customTitle: 'claude-named',
      sessionId: 'fake-1',
    })}\n`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'typedname');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('claude-named');
});

test('it restores the fleet from disk after a crash', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'fleettest');

  const fleetFile = Bun.file(join(ctx.home, '.local', 'state', 'atc', 'fleet.json'));
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

  pty.kill(); // simulate an atc crash; fleet.json must survive it

  await Bun.sleep(300); // let the killed process release its pty before rebooting

  expect(fleet).toStrictEqual([{ name: 'fleettest', cwd: ctx.home, claudeId: 'fake-1' }]);

  ctx.reset();

  const rebooted = ctx.boot();

  await ctx.waitFor('restore last fleet (1 sessions)');

  ctx.reset();
  rebooted.write('R');

  await ctx.waitFor('FAKE_CLAUDE_UP');
  await ctx.waitFor('--resume fake-1');
});
