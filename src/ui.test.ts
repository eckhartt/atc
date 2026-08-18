import { expect, test } from 'bun:test';
import { buildOverlayHint } from './ui';
import type { OverlaySessionView } from './ui';

const liveClaude: OverlaySessionView = {
  name: 'auth',
  cwd: '/x',
  state: 'running',
  unread: false,
  lastMsg: 'started',
  alive: true,
  kind: 'pty',
  resumable: true,
  agent: 'claude',
  pinned: false,
  repoRoot: '/x',
};

test('it includes headless on a live Claude row and omits it on Grok', () => {
  expect(buildOverlayHint(liveClaude)).toInclude('H headless');
  expect(buildOverlayHint({ ...liveClaude, agent: 'grok' })).not.toInclude('H');
});

test('it still names yank on a live Grok row', () => {
  expect(buildOverlayHint({ ...liveClaude, agent: 'grok' })).toInclude('y yank');
});
