import { AppError } from '../http/errors.js';
import type { ProcessManager } from '../process/manager.js';
import { classifySaveLine, type SaveEvent } from '../process/patterns.js';

// 'gone': the server stopped while the backup waited for it
export type SaveOutcome = 'ok' | 'failed' | 'unsupported' | 'timeout' | 'gone';

export interface SaveTimings {
  saveOffMs: number;
  flushMs: number;
  saveOnMs: number;
}

export const DEFAULT_SAVE_TIMINGS: SaveTimings = { saveOffMs: 30_000, flushMs: 300_000, saveOnMs: 30_000 };

interface Waiter {
  wanted: SaveEvent;
  resolve: (outcome: SaveOutcome) => void;
  timer: NodeJS.Timeout;
}

// Talks to a running server through its console: sends save commands and waits for the line that proves
// each one took effect. A waiter is registered before the command is sent, so a fast reply is never missed.
export class SaveSession {
  private readonly waiters = new Set<Waiter>();
  private readonly unsubscribe: () => void;
  private saveOffIssued = false;

  constructor(
    private readonly manager: ProcessManager,
    private readonly serverId: string,
    private readonly timings: SaveTimings,
  ) {
    this.unsubscribe = manager.subscribe(serverId, {
      onLine: (line) => {
        if (line.stream === 'stdout' || line.stream === 'stderr') this.observe(classifySaveLine(line.text));
      },
      onStatus: (status) => {
        if (status.state === 'online' || status.state === 'starting') return;
        for (const waiter of [...this.waiters]) this.settle(waiter, 'gone');
      },
    });
  }

  private observe(event: SaveEvent | null): void {
    if (event === null) return;
    for (const waiter of [...this.waiters]) {
      if (waiter.wanted === event) this.settle(waiter, 'ok');
      else if (event === 'failed' || event === 'unsupported') this.settle(waiter, event);
    }
  }

  private settle(waiter: Waiter, outcome: SaveOutcome): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(outcome);
  }

  private expect(wanted: SaveEvent, timeoutMs: number): Promise<SaveOutcome> {
    return new Promise((resolve) => {
      const waiter: Waiter = { wanted, resolve, timer: setTimeout(() => this.settle(waiter, 'timeout'), timeoutMs) };
      this.waiters.add(waiter);
    });
  }

  private async command(text: string, wanted: SaveEvent, timeoutMs: number): Promise<SaveOutcome> {
    const reply = this.expect(wanted, timeoutMs);
    try {
      await this.manager.sendCommand(this.serverId, text);
    } catch (error) {
      for (const waiter of [...this.waiters]) this.settle(waiter, 'gone');
      await reply;
      throw error;
    }
    return reply;
  }

  private assertAlive(outcome: SaveOutcome): void {
    if (outcome === 'gone') {
      throw new AppError(409, 'BACKUP_INTERRUPTED', 'The server was stopped during the backup. The incomplete backup was discarded.');
    }
  }

  private fail(message: string, code: string): AppError {
    return new AppError(502, code, message);
  }

  // save-off, then flush everything to disk; throws when the server does not confirm in time
  async freeze(): Promise<void> {
    this.saveOffIssued = true;
    const off = await this.command('save-off', 'off', this.timings.saveOffMs);
    this.assertAlive(off);
    if (off !== 'ok') throw this.fail('The server did not confirm turning off automatic saving (save-off).', 'BACKUP_SAVE_TIMEOUT');
    let flushed = await this.command('save-all flush', 'flushed', this.timings.flushMs);
    // very old servers know no "flush" argument
    if (flushed === 'unsupported') flushed = await this.command('save-all', 'flushed', this.timings.flushMs);
    this.assertAlive(flushed);
    if (flushed === 'failed') {
      throw this.fail('The server could not save the world (save-all). Is there enough free disk space?', 'BACKUP_SAVE_FAILED');
    }
    if (flushed !== 'ok') throw this.fail('The server did not confirm saving the world (save-all flush) in time.', 'BACKUP_SAVE_TIMEOUT');
  }

  // always called after freeze(), also when it or the archiving failed; true when the server confirmed
  async resume(): Promise<boolean> {
    if (!this.saveOffIssued) return true;
    try {
      return (await this.command('save-on', 'on', this.timings.saveOnMs)) === 'ok';
    } catch {
      // the server is gone, there is nothing left to switch on
      return true;
    }
  }

  close(): void {
    this.unsubscribe();
    for (const waiter of [...this.waiters]) this.settle(waiter, 'timeout');
  }
}
