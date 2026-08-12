/**
 * The process environment with any enclosing Claude Code session scrubbed
 * out. A claude spawned with those variables intact behaves as a child of
 * the enclosing session — its transcript lands inside the parent's instead
 * of its own project directory, which breaks resume and handoff.
 */
export function collectCleanEnv(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
      continue;
    }

    env[key] = value;
  }

  return { ...env, ...extra };
}
