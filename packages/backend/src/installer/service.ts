import { eq } from 'drizzle-orm';
import { appendFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/client.js';
import type { InstallState } from '../db/enums.js';
import { servers, type Server } from '../db/schema.js';
import type { EventBus } from '../events/bus.js';
import { AppError, errorMsg } from '../http/errors.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import { msg, refOf, serializeRef, textOf, type Msg, type Text } from '../messages.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import type { ServerRuntimeGuard } from '../mods/runtime-guard.js';
import type { GameAdapters } from '../games/adapters.js';
import { INSTALL_LOG_FILE, countLogLines } from './install-log.js';

export { INSTALL_LOG_FILE };
const MAX_ERROR_LENGTH = 3000;

export interface InstallServiceOptions {
  db: Db;
  serversDir: string;
  lock: KeyedLock;
  bus: EventBus;
  games: GameAdapters;
  guard: ServerRuntimeGuard;
  logger?: Logger;
}

const notFound = (): AppError => new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');

// Appends to install.log and mirrors every physical line as an event carrying its line number, so a reader
// that loads the file and listens to events can merge both without duplicates or gaps.
class LogFile {
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly bus: EventBus,
    private readonly serverId: string,
    private seq: number,
  ) {}

  static async open(dir: string, bus: EventBus, serverId: string): Promise<LogFile> {
    return new LogFile(path.join(dir, INSTALL_LOG_FILE), bus, serverId, await countLogLines(dir));
  }

  write(line: string): void {
    for (const part of line.split(/\r?\n/)) {
      const time = Date.now();
      this.bus.emit({ type: 'install.log', serverId: this.serverId, line: part, seq: this.seq++, time });
      const text = `${new Date(time).toISOString()} ${part}\n`;
      this.chain = this.chain.then(() => appendFile(this.file, text, 'utf8')).catch(() => undefined);
    }
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

export class InstallService {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly logger: Logger;

  constructor(private readonly options: InstallServiceOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  isBusy(serverId: string): boolean {
    return this.jobs.has(serverId);
  }

  // resolves once every queued or running installation has ended
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.allSettled([...this.jobs.values()]);
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.abort.abort();
    await Promise.race([this.idle(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  // anything still marked "installing" at boot was cut off by a crash or restart
  async recoverInterrupted(): Promise<number> {
    const stuck = await this.options.db.select({ id: servers.id }).from(servers).where(eq(servers.installState, 'installing'));
    if (stuck.length === 0) return 0;
    await this.options.db.transaction((tx) =>
      tx
        .update(servers)
        .set({ installState: 'failed', installError: msg('INSTALL_INTERRUPTED_SHUTDOWN').text, installErrorRef: serializeRef(msg('INSTALL_INTERRUPTED_SHUTDOWN').ref), updatedAt: new Date() })
        .where(eq(servers.installState, 'installing')),
    );
    return stuck.length;
  }

  // Validates and queues the job; the installation itself runs in the background.
  async enqueue(serverId: string, options: { checkJava: boolean }): Promise<void> {
    if (this.jobs.has(serverId)) throw new AppError(409, 'INSTALL_IN_PROGRESS', 'The installation is already running.');
    // reserved before the first await, so a concurrent call cannot pass the same checks
    let release: () => void = () => undefined;
    this.jobs.set(
      serverId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let queued = false;
    try {
      await this.validate(serverId, options);
      const job: Promise<void> = this.options.lock
        .run(serverId, () => this.execute(serverId))
        .catch((error: unknown) => this.logger.error({ err: error, serverId }, 'Installation: unexpected error'))
        .finally(() => {
          if (this.jobs.get(serverId) === job) this.jobs.delete(serverId);
        });
      this.jobs.set(serverId, job);
      queued = true;
    } finally {
      if (!queued) this.jobs.delete(serverId);
      release();
    }
  }

  private async validate(serverId: string, options: { checkJava: boolean }): Promise<void> {
    const server = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (server === undefined) throw notFound();
    if (this.options.guard.isRunning(serverId)) {
      throw new AppError(409, 'SERVER_RUNNING', 'The server is running. Please stop it first before it is reinstalled.');
    }
    if (server.installState === 'installing') {
      throw new AppError(409, 'INSTALL_IN_PROGRESS', 'The installation is already running.');
    }
    if (server.installState === 'installed') {
      throw new AppError(409, 'ALREADY_INSTALLED', 'The server is already installed.');
    }
    await this.options.games.forServer(server).validateInstall(server, options);
  }

  private serverDir(serverId: string): string {
    return path.join(this.options.serversDir, serverId);
  }

  private async setState(serverId: string, installState: InstallState, failure: Msg | null, extra: Partial<Server> = {}): Promise<void> {
    const installError = failure === null ? null : failure.text;
    const installErrorRef = failure === null ? null : failure.ref;
    await this.options.db.transaction((tx) =>
      tx
        .update(servers)
        .set({ installState, installError, installErrorRef: serializeRef(installErrorRef), updatedAt: new Date(), ...extra })
        .where(eq(servers.id, serverId)),
    );
    this.options.bus.emit({ type: 'install.state', serverId, installState, installError, installErrorRef });
  }

  private progress(serverId: string, phase: string, percent: number | null, message: Text): void {
    this.options.bus.emit({ type: 'install.progress', serverId, phase, percent, message: textOf(message), messageRef: refOf(message) });
  }

  private async execute(serverId: string): Promise<void> {
    const server = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    // the state may have changed while the job waited for the lock
    if (server === undefined || server.installState === 'installed' || this.options.guard.isRunning(serverId)) return;
    const dir = this.serverDir(serverId);
    await mkdir(dir, { recursive: true });
    const log = await LogFile.open(dir, this.options.bus, serverId);
    const adapter = this.options.games.forServer(server);
    log.write(`=== Installation of ${adapter.installTitle(server)} started ===`);
    await this.setState(serverId, 'installing', null);
    try {
      const result = await adapter.install(server, {
        dir,
        signal: this.abort.signal,
        log: (line) => log.write(line),
        progress: (phase, percent, message) => this.progress(serverId, phase, percent, message),
      });
      await this.setState(serverId, 'installed', null, result);
      this.progress(serverId, 'done', 100, msg('INSTALL_DONE'));
      log.write('=== Installation finished ===');
    } catch (error) {
      const failure = this.describe(error);
      this.logger.error({ err: error, serverId }, 'Installation failed');
      log.write(`ERROR: ${failure.text}`);
      await this.setState(serverId, 'failed', failure).catch((stateError: unknown) =>
        this.logger.error({ err: stateError, serverId }, 'The failure status could not be saved'),
      );
    } finally {
      await rm(path.join(dir, '.tmp'), { recursive: true, force: true }).catch(() => undefined);
      await log.flush();
    }
  }

  private describe(error: unknown): Msg {
    const failure = errorMsg(error, msg('INSTALL_UNEXPECTED_ERROR'));
    return failure.text.length > MAX_ERROR_LENGTH ? { text: `${failure.text.slice(0, MAX_ERROR_LENGTH)} ...`, ref: failure.ref } : failure;
  }
}
