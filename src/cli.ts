// atc CLI entry: no subcommand opens the client TUI; `hook-report` and
// `statusline` are the commands injected into wrangled sessions.
const [subcommand] = process.argv.slice(2);

switch (subcommand) {
  case undefined: {
    await import('./index');

    break;
  }
  case 'hook-report': {
    const reporter = await import('./hook-report');

    await reporter.runHookReport();

    break;
  }
  case 'statusline': {
    const statusline = await import('./statusline');

    await statusline.runStatusline();

    break;
  }
  default: {
    console.error(`atc: unknown subcommand '${subcommand}'`);
    process.exit(1);
  }
}
