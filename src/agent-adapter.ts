import type { HookEvent } from './hooks';

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

  // Opaque handle the adapter can later pull a session name from.
  nameSource?: string;
}

export interface NameUpdate {
  name: string;
  namedBy?: 'agent';
}

/**
 * Everything specific to one agent CLI: how to spawn it, how to read its
 * hook payloads, where its session names come from, and how to resume a
 * session outside atc. The session core never sees past this interface.
 */
export interface AgentAdapter {
  readonly planSpawn: (opts: SpawnOptions) => SpawnPlan;
  readonly normalizeHook: (e: HookEvent) => AdapterEvent;
  readonly loadName: (
    source: string,
    namedBy: 'user' | 'auto' | 'agent',
  ) => Promise<NameUpdate | null>;
  readonly buildResumeCommand: (cwd: string, agentSessionID: string | undefined) => string | null;
}
