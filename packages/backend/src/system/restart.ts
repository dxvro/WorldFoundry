import type { RestartPlan } from '../contract.js';
import type { Db } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import { AppError } from '../http/errors.js';
import { msg } from '../messages.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import type { NetworkService } from '../network/service.js';
import type { ProcessManager } from '../process/manager.js';
import { SettingsStore } from '../settings/store.js';
import type { AutostartService } from '../autostart/service.js';
import type { UpdateService } from '../update/service.js';

// Exit code of a deliberate restart (EX_TEMPFAIL). systemd (Restart=on-failure) and WinSW (onfailure) treat every
// exit that is not a stop request as a failure and start the application again; portable and development runs
// have to be started by hand.
export const RESTART_EXIT_CODE = 75;
export const KEY_RESTART = 'restart.servers';
// a record older than this belongs to a restart that never finished; those servers are not started by surprise
const MAX_AGE_MS = 30 * 60_000;

interface RestartRecord {
  serverIds: string[];
  at: number;
}

export interface RestartServiceOptions {
  db: Db;
  manager: ProcessManager;
  bus: EventBus;
  network: NetworkService;
  update: UpdateService;
  autostart: AutostartService;
  // ends the process (index.ts: stops all servers cleanly first, then exits with this code); absent when embedded
  exit?: (code: number) => void;
  delayMs?: number;
  now?: () => number;
  logger?: Logger;
}

// "Restart now": remembers which servers run, lets the application shut down the normal way (which stops all
// Minecraft servers cleanly) and exits with RESTART_EXIT_CODE. After the next start the remembered servers are
// started again.
export class RestartService {
  private readonly store: SettingsStore;
  private readonly logger: Logger;
  private readonly now: () => number;
  private restarting = false;

  constructor(private readonly options: RestartServiceOptions) {
    this.store = new SettingsStore(options.db, options.now);
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  get supported(): boolean {
    return this.options.exit !== undefined;
  }

  async request(): Promise<RestartPlan> {
    const { exit, update, manager, network, bus } = this.options;
    if (exit === undefined) throw new AppError(501, 'RESTART_UNSUPPORTED', 'In this mode of operation a restart from the interface is not possible.');
    if (this.restarting) throw new AppError(409, 'RESTART_IN_PROGRESS', 'WorldFoundry is already restarting.');
    const blocker = update.restartBlocker();
    if (blocker !== null) throw new AppError(409, 'UPDATE_IN_PROGRESS', blocker.text, undefined, { reason: blocker.ref });
    const info = await network.state();
    const urls = await network.pendingUrls();
    const record: RestartRecord = { serverIds: manager.activeServerIds(), at: this.now() };
    await this.store.set(KEY_RESTART, JSON.stringify(record));
    this.restarting = true;
    this.logger.info({ servers: record.serverIds.length }, 'Restart requested');
    bus.emit({ type: 'system.restarting', urls });
    // the response goes out first; the shutdown stops the servers and then the process
    const timer = setTimeout(() => exit(RESTART_EXIT_CODE), this.options.delayMs ?? 400);
    timer.unref();
    return { restarting: true, urls, automatic: info.restart.automatic, note: info.restart.note, noteRef: info.restart.noteRef };
  }

  // Starts the servers that ran before the restart. The record is removed first, so a crash while starting can never
  // start the same servers again and again.
  async resumeServers(): Promise<{ started: string[]; failed: string[] }> {
    const record = await this.store.getJson<RestartRecord>(KEY_RESTART);
    if (record === null) return { started: [], failed: [] };
    await this.store.set(KEY_RESTART, null);
    if (!Array.isArray(record.serverIds) || this.now() - record.at > MAX_AGE_MS) return { started: [], failed: [] };
    const ids = record.serverIds.filter((id): id is string => typeof id === 'string');
    if (ids.length === 0) return { started: [], failed: [] };
    this.logger.info({ servers: ids.length }, 'Servers are started again after the restart');
    return this.options.autostart.startMany(ids, msg('START_AFTER_RESTART'));
  }
}
