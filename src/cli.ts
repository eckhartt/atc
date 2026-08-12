// atc CLI entry: no subcommand opens the client TUI; `hook-report` and
// `statusline` are the commands injected into wrangled sessions.
import { defineCommand, runMain } from 'citty';

const main = defineCommand({
  meta: {
    name: 'atc',
    description: 'Terminal control tower for Claude Code sessions',
  },
  subCommands: {
    'hook-report': () =>
      defineCommand({
        meta: {
          name: 'hook-report',
          description: 'Forward a hook event from a wrangled session to the atc socket',
          hidden: true,
        },
        async run() {
          const reporter = await import('./hook-report');

          await reporter.runHookReport();
        },
      }),
    statusline: () =>
      defineCommand({
        meta: {
          name: 'statusline',
          description: 'Render the chained statusline for a wrangled session',
          hidden: true,
        },
        async run() {
          const statusline = await import('./statusline');

          await statusline.runStatusline();
        },
      }),
  },
  async run(ctx) {
    if (ctx.subCommand !== undefined) {
      return;
    }

    await import('./index');
  },
});

await runMain(main);
