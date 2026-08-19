<div align="center">
  <h1>atc documentation</h1>

  <p>Architecture and design docs for atc, the terminal control tower for Claude Code and Grok Build sessions.</p>
</div>

## Architecture

- [Overview](./architecture/overview.md) — what atc is, the current process model, the Claude
  integration contract, and the state files.
- [Daemon](./architecture/daemon.md) — the target daemon/client architecture: process model,
  listeners, screen model, surfaces and adapters, state.
- [Protocol](./architecture/protocol.md) — the daemon/client wire protocol: NDJSON envelope, methods
  and events, streaming, backpressure, permissions.

## Reference

- [Roadmap](./roadmap.md) — sequencing from the MVP to the daemon/client architecture, phase scope
  and status.
