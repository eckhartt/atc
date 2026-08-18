import type { HookEvent } from './hooks';

export type AgentKind = 'claude' | 'grok';

/**
 * Missing, empty, and unknown values become Claude so a fleet written
 * before the agent column still restores as Claude.
 */
export function toAgentKind(raw: unknown): AgentKind {
  return raw === 'grok' ? 'grok' : 'claude';
}

export interface SpawnOptions {
  readonly prompt: string;

  // true opens the agent's own session picker; a string resumes that
  // specific agent session id.
  readonly resume: boolean | string;
}

export interface SpawnPlan {
  bin: string;
  args: string[];
}

export interface AdapterEvent {
  kind: 'started' | 'needs-input' | 'turn-done' | 'prompt-submitted' | 'ended' | 'heartbeat';
  agentSessionID?: string;
  message?: string;

  // Fuller activity text than message: what the agent last said or was
  // asked, for briefing. Bounded by the adapter.
  detail?: string;

  // Opaque handle the adapter can later pull a session name from.
  nameSource?: string;
}

export interface NameUpdate {
  name: string;
  namedBy?: 'agent';
}

type AttentionJudgment = 'needs-input' | 'working';

/**
 * The universal attention fallback for agents without a hook system: judges
 * the current serialized screen once output quiesces. null means no opinion
 * and the session's state stands.
 */
interface ScreenDetector {
  readonly detectAttention: (screen: string) => AttentionJudgment | null;
}

/**
 * Everything specific to one agent CLI: how to spawn it, how to read its
 * hook payloads, where its session names come from, and how to resume a
 * session outside atc. The session core never sees past this interface.
 */
export interface AgentAdapter {
  // The detector stack's screen tier; null when hooks are authoritative.
  readonly screenDetector: ScreenDetector | null;
  readonly planSpawn: (opts: SpawnOptions) => SpawnPlan;
  readonly normalizeHook: (e: HookEvent) => AdapterEvent;
  readonly loadName: (
    source: string,
    namedBy: 'user' | 'auto' | 'agent',
  ) => Promise<NameUpdate | null>;
  readonly buildResumeCommand: (cwd: string, agentSessionID: string | undefined) => string | null;
}
