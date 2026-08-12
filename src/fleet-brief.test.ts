import { expect, test } from 'bun:test';
import { buildBriefInput } from './fleet-brief';

test('it reports an empty fleet without inventing sessions', () => {
  expect(buildBriefInput([])).toBe('No sessions are running.');
});

test('it renders one block per session with state and activity', () => {
  const input = buildBriefInput([
    {
      id: 's1',
      name: 'auth-bug',
      cwd: '/x',
      state: 'needs_you',
      unread: true,
      lastMsg: 'needs permission',
      lastDetail: 'May I edit auth.ts to fix the token check?',
      namedBy: 'auto',
      createdAt: Date.now() - 120_000,
      kind: 'pty',
      alive: true,
    },
    {
      id: 's2',
      name: 'refactor',
      cwd: '/y',
      state: 'done',
      unread: false,
      lastMsg: 'turn done',
      namedBy: 'auto',
      createdAt: Date.now(),
      kind: 'pty',
      alive: true,
    },
  ]);

  expect(input).toInclude('session: auth-bug');
  expect(input).toInclude('state: needs_you (unread)');
  expect(input).toInclude('last activity: May I edit auth.ts to fix the token check?');
  expect(input).toInclude('session: refactor');
  expect(input).toInclude('state: done');
  expect(input).toInclude('\n---\n');
});

test('it never emits an activity line for a session without one', () => {
  const input = buildBriefInput([
    {
      id: 's1',
      name: 'fresh',
      cwd: '/z',
      state: 'running',
      unread: false,
      lastMsg: 'started',
      namedBy: 'auto',
      createdAt: Date.now(),
      kind: 'pty',
      alive: true,
    },
  ]);

  expect(input).not.toInclude('last activity:');
});
