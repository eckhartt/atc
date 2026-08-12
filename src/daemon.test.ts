import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from './daemon';
import { OutboundQueue } from './outbound-queue';

interface TestClient {
  readonly sendLine: (line: string) => void;
  readonly waitForLine: (count?: number) => Promise<string[]>;
  readonly waitForClose: () => Promise<void>;
}

async function setupClient(): Promise<TestClient> {
  const dir = mkdtempSync(join(tmpdir(), 'atc-daemon-'));
  const sockPath = join(dir, 'daemon.sock');
  const server = startDaemon({ socketPath: sockPath, build: 'atc/test-build' });
  const lines: string[] = [];
  let buffer = '';
  let queue: OutboundQueue | null = null;
  const closed = Promise.withResolvers<void>();

  const socket = await Bun.connect({
    unix: sockPath,
    socket: {
      data(_s, buf) {
        buffer += buf.toString();

        const parts = buffer.split('\n');

        buffer = parts.pop() ?? '';

        lines.push(...parts.filter((part) => part.trim() !== ''));
      },
      drain() {
        queue?.drain();
      },
      close() {
        closed.resolve();
      },
      error() {},
    },
  });

  queue = new OutboundQueue(socket, 8 * 1024 * 1024);

  onTestFinished(() => {
    socket.end();
    server.stop(true);

    rmSync(dir, { recursive: true, force: true });
  });

  return {
    sendLine(line: string) {
      queue?.send(`${line}\n`);
    },
    async waitForLine(count = 1) {
      const deadline = Date.now() + 5000;

      while (lines.length < count && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      if (lines.length < count) {
        throw new Error(`timed out waiting for ${count} lines; got ${JSON.stringify(lines)}`);
      }

      return lines;
    },
    waitForClose: () => closed.promise,
  };
}

test('it answers daemon.hello with the build and limits', async () => {
  const client = await setupClient();

  client.sendLine('{"v":1,"id":1,"m":"daemon.hello","p":{"client":"atc/test-build"}}');

  const [line] = await client.waitForLine();

  if (line === undefined) {
    throw new Error('no response line');
  }

  expect(JSON.parse(line)).toStrictEqual({
    v: 1,
    id: 1,
    ok: { daemon: 'atc/test-build', limits: { maxLine: 1_048_576, maxChunk: 65_536 } },
  });
});

test('it rejects a protocol version mismatch naming both builds', async () => {
  const client = await setupClient();

  client.sendLine('{"v":2,"id":1,"m":"daemon.hello","p":{"client":"atc/newer-build"}}');

  const [line] = await client.waitForLine();

  if (line === undefined) {
    throw new Error('no response line');
  }

  expect(JSON.parse(line)).toStrictEqual({
    v: 1,
    id: 1,
    err: {
      code: 'protocol_mismatch',
      msg: expect.toSatisfy(
        (msg: string) =>
          msg.includes('atc/newer-build') &&
          msg.includes('v2') &&
          msg.includes('v1') &&
          msg.includes('restart the daemon'),
      ) as string,
    },
  });

  await client.waitForClose();
});

test('it answers daemon.ping after the handshake', async () => {
  const client = await setupClient();

  client.sendLine('{"v":1,"id":1,"m":"daemon.hello","p":{"client":"atc/test-build"}}');
  client.sendLine('{"v":1,"id":2,"m":"daemon.ping"}');

  const lines = await client.waitForLine(2);

  expect(JSON.parse(lines[1] ?? '')).toStrictEqual({ v: 1, id: 2, ok: {} });
});

test('it refuses any request before daemon.hello and closes', async () => {
  const client = await setupClient();

  client.sendLine('{"v":1,"id":1,"m":"daemon.ping"}');

  const [line] = await client.waitForLine();

  if (line === undefined) {
    throw new Error('no response line');
  }

  expect(JSON.parse(line)).toStrictEqual({
    v: 1,
    id: 1,
    err: { code: 'unauthorized', msg: 'daemon.hello must be the first request' },
  });

  await client.waitForClose();
});

test('it answers an unknown method with unknown_method and stays connected', async () => {
  const client = await setupClient();

  client.sendLine('{"v":1,"id":1,"m":"daemon.hello","p":{"client":"atc/test-build"}}');
  client.sendLine('{"v":1,"id":2,"m":"session.levitate"}');
  client.sendLine('{"v":1,"id":3,"m":"daemon.ping"}');

  const lines = await client.waitForLine(3);

  expect(JSON.parse(lines[1] ?? '')).toStrictEqual({
    v: 1,
    id: 2,
    err: { code: 'unknown_method', msg: "unknown method 'session.levitate'" },
  });

  expect(JSON.parse(lines[2] ?? '')).toStrictEqual({ v: 1, id: 3, ok: {} });
});

test('it closes the connection on a malformed line', async () => {
  const client = await setupClient();

  client.sendLine('this is not json');

  const [line] = await client.waitForLine();

  if (line === undefined) {
    throw new Error('no response line');
  }

  expect(JSON.parse(line)).toStrictEqual({
    v: 1,
    id: 0,
    err: { code: 'bad_args', msg: 'malformed line: not valid JSON' },
  });

  await client.waitForClose();
});

test('it closes the connection on an oversized line', async () => {
  const client = await setupClient();

  client.sendLine(`{"v":1,"id":1,"m":"daemon.hello","p":{"pad":"${'x'.repeat(1_100_000)}"}}`);

  const [line] = await client.waitForLine();

  if (line === undefined) {
    throw new Error('no response line');
  }

  expect(JSON.parse(line)).toStrictEqual({
    v: 1,
    id: 0,
    err: { code: 'bad_args', msg: 'line exceeds 1048576 bytes' },
  });

  await client.waitForClose();
});

test('it connects nothing on a socket path with no daemon', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-daemon-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const attempt = Bun.connect({
    unix: join(dir, 'nobody-home.sock'),
    socket: { data() {}, error() {} },
  });

  expect(attempt).rejects.toMatchObject({ code: 'ENOENT' });
});
