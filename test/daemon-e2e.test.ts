import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import { DaemonClient } from '../src/daemon-client';
import type { EventMsg } from '../src/protocol';
import { isRecord } from '../src/report';

const repo = dirname(import.meta.dir);

function getRecord(value: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  const inner = value[key];

  if (!isRecord(inner)) {
    throw new TypeError(`${key} is not an object`);
  }

  return inner;
}

function getString(value: Readonly<Record<string, unknown>>, key: string): string {
  const inner = value[key];

  if (typeof inner !== 'string') {
    throw new TypeError(`${key} is not a string`);
  }

  return inner;
}

function getRecords(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown>[] {
  const inner = value[key];

  if (!Array.isArray(inner)) {
    throw new TypeError(`${key} is not an array`);
  }

  return inner.filter((item) => isRecord(item));
}

interface DaemonContext {
  readonly home: string;
  readonly daemonSock: string;
  readonly proc: Subprocess;
  readonly openClient: () => Promise<DaemonClient>;
}

function collectEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
}

function setupDaemonProc(home?: string): DaemonContext {
  const freshHome = home ?? mkdtempSync(join(tmpdir(), 'atc-daemon-e2e-'));

  if (home === undefined) {
    mkdirSync(join(freshHome, '.config', 'atc'), { recursive: true });
    mkdirSync(join(freshHome, '.local', 'state', 'atc'), { recursive: true });

    const fakeClaude = join(freshHome, 'fake-claude');

    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env bash
echo "FAKE_CLAUDE_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
sleep 0.3
printf '{"hook_event_name":"Notification","session_id":"fake-1","message":"needs permission"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
sleep 30
`,
      { mode: 0o755 },
    );

    writeFileSync(
      join(freshHome, '.config', 'atc', 'config.json'),
      JSON.stringify({ claudeBin: fakeClaude, claudeArgs: [] }),
    );
  }

  const proc = Bun.spawn([process.execPath, join(repo, 'src', 'cli.ts'), 'daemon'], {
    env: collectEnv({
      HOME: freshHome,
      XDG_RUNTIME_DIR: freshHome,
      PATH: '/usr/sbin:/usr/bin:/bin',
    }),
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const daemonSock = join(freshHome, 'atc-daemon.sock');
  const clients: DaemonClient[] = [];

  const openClient = async () => {
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      try {
        const client = await DaemonClient.open(daemonSock);

        clients.push(client);

        return client;
      } catch {
        await Bun.sleep(50);
      }
    }

    throw new Error('daemon socket never came up');
  };

  onTestFinished(() => {
    for (const client of clients) {
      client.stop();
    }

    proc.kill();

    if (home === undefined) {
      rmSync(freshHome, { recursive: true, force: true });
    }
  });

  return { home: freshHome, daemonSock, proc, openClient };
}

async function waitForEvent(
  events: readonly EventMsg[],
  matches: (e: EventMsg) => boolean,
  ms = 5000,
): Promise<EventMsg> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    const found = events.find((e) => matches(e));

    if (found !== undefined) {
      return found;
    }

    await Bun.sleep(20);
  }

  throw new Error(`no matching event; got ${JSON.stringify(events.map((e) => e.ev))}`);
}

test('it spawns a session and broadcasts session.added to every client', async () => {
  const ctx = setupDaemonProc();

  const watcher = await ctx.openClient();

  const events: EventMsg[] = [];

  watcher.onEvent = (e) => {
    events.push(e);
  };

  await watcher.sendHello('atc/test');

  const actor = await ctx.openClient();

  await actor.sendHello('atc/test');

  const ok = await actor.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  expect(ok).toStrictEqual({
    session: expect.toSatisfy(
      (s: Readonly<Record<string, unknown>>) => s['kind'] === 'pty' && s['alive'] === true,
    ),
  });

  const added = await waitForEvent(events, (e) => e.ev === 'session.added');

  expect(added['session']).toMatchObject({ cwd: ctx.home, state: 'running' });
});

test('it turns hook notifications into session.state broadcasts', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['state'] === 'needs_you');

  const list = await client.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions).toHaveLength(1);

  expect(sessions[0]).toMatchObject({
    state: 'needs_you',
    lastMsg: 'needs permission',
    claudeId: 'fake-1',
  });
});

test('it kills a live session to exited and a dead one to removed', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['lastMsg'] === 'killed');

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(events, (e) => e.ev === 'session.removed' && e['s'] === id);

  const list = await client.sendRequest('session.list');

  expect(list).toStrictEqual({ sessions: [] });
});

test('it builds a resume command once the claude id is captured', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const spawned = getRecord(ok, 'session');
  const id = getString(spawned, 'id');

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['state'] === 'needs_you');

  const answer = await client.sendRequest('session.resumeCommand', { session: id });

  const command = getString(answer, 'command');

  expect(command).toInclude('claude --resume fake-1');
  expect(command).toStartWith("cd '");
});

test('it restores the fleet cold after a daemon crash', async () => {
  const ctx = setupDaemonProc();

  const client = await ctx.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  await waitForEvent(events, (e) => e.ev === 'session.state' && e['state'] === 'needs_you');

  ctx.proc.kill(9);

  await ctx.proc.exited;

  const revived = setupDaemonProc(ctx.home);

  const client2 = await revived.openClient();

  await client2.sendHello('atc/test');

  const restored = await client2.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(restored).toStrictEqual({ restored: 1 });

  const list = await client2.sendRequest('session.list');

  const sessions = getRecords(list, 'sessions');

  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ claudeId: 'fake-1', alive: true });
});
