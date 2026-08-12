import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from './agent-adapter';
import { startDaemon } from './daemon';
import type { HeadlessRunner } from './daemon';
import { DaemonClient } from './daemon-client';
import type { EventMsg } from './protocol';
import { isRecord } from './report';

const sleepAdapter: AgentAdapter = {
  screenDetector: null,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  buildResumeCommand: () => null,
};

interface HeadlessContext {
  readonly client: DaemonClient;
  readonly events: EventMsg[];
  readonly runs: { opts: Record<string, unknown>; finish: (how: 'done' | 'stuck') => void }[];
}

async function setupHeadlessDaemon(withRunner = true): Promise<HeadlessContext> {
  const dir = mkdtempSync(join(tmpdir(), 'atc-headless-'));
  const runs: HeadlessContext['runs'] = [];

  const startFakeRun: HeadlessRunner = (opts, hooks) => {
    const entry = {
      opts: { ...opts },
      finish(how: 'done' | 'stuck') {
        if (how === 'done') {
          hooks.onDone('wrapped up cleanly');
        } else {
          hooks.onNeedsYou('stuck on a decision');
        }
      },
    };

    runs.push(entry);
    hooks.onOutput('HEADLESS LINE\r\n');

    return { stop() {} };
  };

  const daemon = startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: sleepAdapter,
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
    ...(withRunner ? { headlessRunner: startFakeRun } : {}),
  });

  const client = await DaemonClient.open(join(dir, 'daemon.sock'));

  const events: EventMsg[] = [];

  client.onEvent = (e) => {
    events.push(e);
  };

  onTestFinished(() => {
    client.stop();
    daemon.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  await client.sendHello('atc/test');

  return { client, events, runs };
}

type SendRequest = DaemonClient['sendRequest'];

async function spawnResumable(send: SendRequest): Promise<string> {
  const ok = await send('session.spawn', {
    cwd: '/tmp',
    name: 'handoff',
    resume: 'sess-123',
    cols: 80,
    rows: 24,
  });

  const spawned = ok['session'];

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  return spawned['id'];
}

async function waitForEvent(
  events: readonly EventMsg[],
  matches: (e: EventMsg) => boolean,
): Promise<EventMsg> {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const found = events.find((e) => matches(e));

    if (found !== undefined) {
      return found;
    }

    await Bun.sleep(20);
  }

  throw new Error(`no matching event; got ${JSON.stringify(events.map((e) => e.ev))}`);
}

test('it ejects a terminal session into a headless run with its agent id', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));
  const ok = await ctx.client.sendRequest('session.eject', { session: id, prompt: 'keep going' });

  expect(ok).toStrictEqual({});
  expect(ctx.runs).toHaveLength(1);

  expect(ctx.runs[0]?.opts).toStrictEqual({
    cwd: '/tmp',
    prompt: 'keep going',
    resume: 'sess-123',
    permissionMode: 'auto',
  });

  const list = await ctx.client.sendRequest('session.list');

  const sessions = list['sessions'];

  if (!Array.isArray(sessions)) {
    throw new TypeError('sessions is not an array');
  }

  expect(sessions[0]).toMatchObject({ kind: 'jsonl', alive: true, state: 'running' });
});

test('it reports a finished headless turn as done', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  ctx.runs[0]?.finish('done');

  const done = await waitForEvent(
    ctx.events,
    (e) => e.ev === 'session.state' && e['s'] === id && e['state'] === 'done',
  );

  expect(done['lastMsg']).toBe('wrapped up cleanly');
});

test('it reports a stuck headless turn as needs_you', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  ctx.runs[0]?.finish('stuck');

  const needy = await waitForEvent(
    ctx.events,
    (e) => e.ev === 'session.state' && e['s'] === id && e['state'] === 'needs_you',
  );

  expect(needy['lastMsg']).toBe('stuck on a decision');
});

test('it starts the next headless turn from session input once idle', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  ctx.runs[0]?.finish('done');

  await waitForEvent(ctx.events, (e) => e.ev === 'session.state' && e['state'] === 'done');

  const ok = await ctx.client.sendRequest('session.input', { session: id, d: 'next task\n' });

  expect(ok).toStrictEqual({});
  expect(ctx.runs).toHaveLength(2);
  expect(ctx.runs[1]?.opts).toMatchObject({ prompt: 'next task', resume: 'sess-123' });
});

test('it refuses input to a headless session mid-run', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  expect(
    ctx.client.sendRequest('session.input', { session: id, d: 'hasty\n' }),
  ).rejects.toMatchObject({ code: 'too_slow' });
});

test('it adopts a headless session back into a terminal', async () => {
  const ctx = await setupHeadlessDaemon();
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  await ctx.client.sendRequest('session.eject', { session: id });

  ctx.runs[0]?.finish('done');

  await waitForEvent(ctx.events, (e) => e.ev === 'session.state' && e['state'] === 'done');

  const ok = await ctx.client.sendRequest('session.adopt', { session: id, cols: 90, rows: 28 });

  expect(ok).toStrictEqual({});

  const list = await ctx.client.sendRequest('session.list');

  const sessions = list['sessions'];

  if (!Array.isArray(sessions)) {
    throw new TypeError('sessions is not an array');
  }

  expect(sessions[0]).toMatchObject({ kind: 'pty', alive: true, state: 'running' });
});

test('it refuses to eject a session that never reported an agent session id', async () => {
  const ctx = await setupHeadlessDaemon();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    name: 'no-id',
    cols: 80,
    rows: 24,
  });

  const spawned = ok['session'];

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  expect(ctx.client.sendRequest('session.eject', { session: spawned['id'] })).rejects.toMatchObject(
    { code: 'no_such_session' },
  );
});

test('it reports eject as unsupported without a headless runner', async () => {
  const ctx = await setupHeadlessDaemon(false);
  const id = await spawnResumable((m, p) => ctx.client.sendRequest(m, p));

  expect(ctx.client.sendRequest('session.eject', { session: id })).rejects.toMatchObject({
    code: 'unsupported',
  });
});
