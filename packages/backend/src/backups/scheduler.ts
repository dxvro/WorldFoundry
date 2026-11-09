import { silentLogger, type Logger } from '../lib/logger.js';
import type { BackupService } from './service.js';

const DEFAULT_CHECK_MS = 60_000;

// Looks once a minute for scheduled backups that are due. The schedule itself lives in the database
// (interval and the time of the last automatic backup), so it survives restarts of the application.
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly logger: Logger;

  constructor(
    private readonly service: BackupService,
    private readonly checkMs: number = DEFAULT_CHECK_MS,
    logger?: Logger,
  ) {
    this.logger = logger ?? silentLogger;
  }

  start(): void {
    if (this.timer !== null || this.checkMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.checkMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.service.runDue(now);
    } catch (error) {
      this.logger.error({ err: error }, 'Checking the scheduled backups failed');
      return 0;
    } finally {
      this.running = false;
    }
  }
}
