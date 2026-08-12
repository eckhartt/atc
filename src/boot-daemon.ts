import { spawn as spawnChild } from 'node:child_process';
import { basename, join } from 'node:path';
import { daemonSocketPath } from './config';
import { DaemonClient } from './daemon-client';

/**
 * Opens a handshaken client to the daemon, booting the daemon first when its
 * socket is absent — the first invocation on a machine brings the whole
 * stack up.
 */
export async function bootDaemonClient(build: string): Promise<DaemonClient> {
  let opened = await tryOpenDaemon();

  if (opened === null) {
    spawnDaemonDetached();

    const deadline = Date.now() + 5000;

    while (opened === null && Date.now() < deadline) {
      await Bun.sleep(100);

      opened = await tryOpenDaemon();
    }
  }

  if (opened === null) {
    throw new Error('the atc daemon did not come up; try `atc daemon` for its output');
  }

  await opened.sendHello(build);

  return opened;
}

async function tryOpenDaemon(): Promise<DaemonClient | null> {
  try {
    return await DaemonClient.open(daemonSocketPath);
  } catch {
    return null;
  }
}

function spawnDaemonDetached() {
  const exec = process.execPath;
  const isBun = basename(exec) === 'bun' || basename(exec) === 'bun.exe';
  const args = isBun ? [join(import.meta.dir, 'cli.ts'), 'daemon'] : ['daemon'];

  spawnChild(exec, args, { detached: true, stdio: 'ignore' }).unref();
}
