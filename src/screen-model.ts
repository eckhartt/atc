import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';

/**
 * A per-session vt state machine: consumes every PTY byte continuously and
 * renders the current screen as an ANSI replay string, so attaching a
 * client is an instant repaint instead of a resize jiggle. Scrollback is
 * capped aggressively — the model exists for the current screen, not
 * history; transcripts on disk are the durable copy.
 */
export class ScreenModel {
  private readonly term: Terminal;

  private readonly serializer: SerializeAddon;

  private flushed: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 300 });
    this.serializer = new SerializeAddon();

    this.term.loadAddon(this.serializer);
  }

  record(data: string): void {
    this.flushed = new Promise((resolve) => {
      this.term.write(data, () => {
        resolve();
      });
    });
  }

  // The terminal parses asynchronously; the replay waits for every recorded
  // byte to land in the buffer before serializing.
  async renderReplay(): Promise<string> {
    await this.flushed;

    return this.serializer.serialize();
  }

  updateDims(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  stop(): void {
    this.term.dispose();
  }
}
