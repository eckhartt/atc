import { expect, test } from 'bun:test';
import { formatOverlayAgentMark } from './format-overlay-agent-mark';

test('it marks a grok row with g and a claude row with a space', () => {
  expect(formatOverlayAgentMark('grok')).toBe('g');
  expect(formatOverlayAgentMark('claude')).toBe(' ');
});
