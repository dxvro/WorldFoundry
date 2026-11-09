import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { AppError, errorMsg } from '../http/errors.js';
import { msg, type Msg } from '../messages.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import type { ProcessManager } from '../process/manager.js';

export interface AutostartReport {
  started: string[];
  skipped: string[];
  failed: string[];
}

export interface AutostartOptions {
  db: Db;
  manager: ProcessManager;
  logger?: Logger;
}

// Starts the servers marked "auto_start" one after the other once the application is up. Whatever goes wrong
// with one server is logged and shown as that server's status; the others are not affected.
export class AutostartService {
  private readonly logger: Logger;

  constructor(private readonly options: AutostartOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  // Starts the given servers one after the other (after a deliberate restart). A server that cannot start is shown as
  // crashed with the reason; the others are not affected.
  async startMany(ids: string[], label: Msg): Promise<{ started: string[]; failed: string[] }> {
    const { manager } = this.options;
    const started: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const result = await manager.start(id);
        if (result.status.state === 'preparing') await manager.waitWhilePreparing(id);
        started.push(id);
      } catch (error) {
        if (error instanceof AppError && error.code === 'SERVER_ALREADY_RUNNING') continue;
        const reason = errorMsg(error, msg('START_UNEXPECTED_ERROR'));
        this.logger.error({ err: error, serverId: id }, `${label.text} failed: ${reason.text}`);
        manager.markStartFailed(id, msg('START_LABEL_FAILED', { label, reason }));
        failed.push(id);
      }
    }
    return { started, failed };
  }

  async run(): Promise<AutostartReport> {
    const { db, manager } = this.options;
    const report: AutostartReport = { started: [], skipped: [], failed: [] };
    const rows = await db.select().from(servers).where(eq(servers.autoStart, true)).orderBy(asc(servers.createdAt));
    for (const server of rows) {
      if (!server.eulaAccepted || server.installState !== 'installed') {
        this.logger.warn({ serverId: server.id }, msg('AUTOSTART_SKIPPED', { name: server.name, reason: server.eulaAccepted ? 'not-installed' : 'eula' }).text);
        report.skipped.push(server.id);
        continue;
      }
      try {
        const result = await manager.start(server.id);
        // a missing Java is installed first; the next server follows once this one has left that phase
        if (result.status.state === 'preparing') await manager.waitWhilePreparing(server.id);
        report.started.push(server.id);
      } catch (error) {
        if (error instanceof AppError && error.code === 'SERVER_ALREADY_RUNNING') {
          report.skipped.push(server.id);
          continue;
        }
        const reason = errorMsg(error, msg('START_UNEXPECTED_ERROR'));
        this.logger.error({ err: error, serverId: server.id }, msg('AUTOSTART_FAILED_NAMED', { name: server.name, reason }).text);
        manager.markStartFailed(server.id, msg('AUTOSTART_FAILED', { reason }));
        report.failed.push(server.id);
      }
    }
    return report;
  }
}
