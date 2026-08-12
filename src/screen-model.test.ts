import { expect, onTestFinished, test } from 'bun:test';
import { ScreenModel } from './screen-model';

interface ModelContext {
  readonly model: ScreenModel;
  readonly waitForReplay: (needle: string) => Promise<string>;
}

function setupModel(cols = 40, rows = 10): ModelContext {
  const model = new ScreenModel(cols, rows);

  onTestFinished(() => {
    model.stop();
  });

  const waitForReplay = async (needle: string): Promise<string> => {
    const deadline = Date.now() + 2000;

    while (Date.now() < deadline) {
      const replay = await model.renderReplay();

      if (replay.includes(needle)) {
        return replay;
      }

      await Bun.sleep(10);
    }

    throw new Error(`replay never contained ${JSON.stringify(needle)}`);
  };

  return { model, waitForReplay };
}

test('it replays text written to the screen', async () => {
  const ctx = setupModel();

  ctx.model.record('hello fleet');

  const replay = await ctx.waitForReplay('hello fleet');

  expect(replay).toInclude('hello fleet');
});

test('it drops cleared content from the replay', async () => {
  const ctx = setupModel();

  ctx.model.record('stale screen\r\n');

  await ctx.waitForReplay('stale screen');

  ctx.model.record('[2J[Hfresh screen');

  const replay = await ctx.waitForReplay('fresh screen');

  expect(replay).not.toInclude('stale screen');
});

test('it preserves colors and cursor positioning in the replay', async () => {
  const ctx = setupModel();

  ctx.model.record('[5;10H[1;31malert[0m');

  const replay = await ctx.waitForReplay('alert');

  expect(replay).toInclude('[');
});

test('it keeps replaying after a resize', async () => {
  const ctx = setupModel();

  ctx.model.record('before resize\r\n');

  await ctx.waitForReplay('before resize');

  ctx.model.updateDims(30, 8);
  ctx.model.record('after resize');

  const replay = await ctx.waitForReplay('after resize');

  expect(replay).toInclude('after resize');
});
