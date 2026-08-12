import Anthropic from '@anthropic-ai/sdk';
import type { SessionDescriptor } from './sessions';

/**
 * Turns the fleet's descriptors into the model-facing briefing input: one
 * compact block per session carrying its state and last known activity.
 */
export function buildBriefInput(sessions: readonly SessionDescriptor[]): string {
  if (sessions.length === 0) {
    return 'No sessions are running.';
  }

  const now = Date.now();

  const blocks = sessions.map((s) => {
    const minutes = Math.max(0, Math.round((now - s.createdAt) / 60_000));

    return [
      `session: ${s.name}`,
      `state: ${s.state}${s.unread ? ' (unread)' : ''}`,
      `dir: ${s.cwd}`,
      `age: ${minutes}m`,
      `last update: ${s.lastMsg}`,
      ...(s.lastDetail === undefined ? [] : [`last activity: ${s.lastDetail}`]),
    ].join('\n');
  });

  return blocks.join('\n---\n');
}

/**
 * One Messages API call that turns the briefing input into a short
 * human-readable fleet brief. Credentials resolve from the daemon's
 * environment; a missing credential rejects like any other API failure.
 */
export async function loadFleetBrief(
  sessions: readonly SessionDescriptor[],
  model = 'claude-haiku-4-5',
): Promise<string> {
  const client = new Anthropic();

  const input = buildBriefInput(sessions);

  const response = await client.messages.create({
    model,
    max_tokens: 600,
    system:
      'You brief the operator of a fleet of coding agent sessions. From the session reports, write a tight plain-text brief: one line per session that matters, leading with sessions that need the operator and why, then finished work worth reviewing, then anything still running. Name sessions by their session name. No headers, no markdown, no filler; skip sessions with nothing to say.',
    messages: [{ role: 'user', content: input }],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (text === '') {
    throw new Error('the brief came back empty');
  }

  return text;
}
