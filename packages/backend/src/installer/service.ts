import { eq } from 'drizzle-orm';
import { appendFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/client.js';
import type { InstallState } from '../db/enums.js';
import { servers, type Server } from '../db/schema.js';
import type { EventBus } from '../events/bus.js';
import { AppError, errorMsg } from '../http/errors.js';
import type { JavaService } from '../java/service.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import { msg, refOf, serializeRef, textOf, type Msg, type Text } from '../messages.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { downloadToTmp } from '../mods/downloader.js';
import { removeQuietly } from '../mods/files.js';
import { rethrowFsError } from '../mods/fs-errors.js';
import type { ServerRuntimeGuard } from '../mods/runtime-guard.js';
import type { LoaderCatalog } from './catalog.js';
import { LOADER_INFO } from './catalog.js';
import { detectForgeLaunch } from './detect-launch.js';
import { INSTALL_LOG_FILE, countLogLines } from './install-log.js';
import { serializeLaunchSpec, type LaunchSpec } from './launch-spec.js';
import type { InstallerRunner } from './runner.js';
import type { ResolvedInstall } from './types.js';

export { INSTALL_LOG_FILE };
const INSTALLER_TIMEOUT_MS = 10 * 60_000;
const TAIL_LINES = 15;
const MAX_ERROR_LENGTH = 3000;
const PROGRESS_INTERVAL_MS = 250;

export interface InstallServiceOptions {
  db: Db;
  serversDir: string;
  lock: KeyedLock;
  bus: EventBus;
  catalog: LoaderCatalog;
  java: JavaService;
  runner: InstallerRunner;
  guard: ServerRuntimeGuard;
  logger?: Logger;
  installerTimeoutMs?: number;
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
    if (options.checkJava && LOADER_INFO[server.loader].requiresInstallerJava) {
      // a missing runtime is installed by the job itself when automatic installation is on; otherwise this throws
      await this.options.java.plan({
        javaPath: server.javaPath,
        loader: server.loader,
        mcVersion: server.mcVersion,
        requiredMajor: server.requiredJavaMajor,
      });
    }
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
    log.write(`=== Installation of ${server.loader} ${server.mcVersion}${server.loaderVersion === null ? '' : ` ${server.loaderVersion}`} started ===`);
    await this.setState(serverId, 'installing', null);
    try {
      const result = await this.install(server, dir, log);
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

  private async install(server: Server, dir: string, log: LogFile): Promise<Partial<Server>> {
    const { catalog, java } = this.options;
    const signal = this.abort.signal;
    const checkAborted = (): void => {
      if (signal.aborted) throw new AppError(500, 'INSTALL_ABORTED', 'The installation was interrupted (the application is shutting down).');
    };

    this.progress(server.id, 'resolve', null, msg('INSTALL_STEP_RESOLVE'));
    log.write('Querying the version at the source ...');
    const plan = await catalog.resolve(server.loader, server.mcVersion, server.loaderVersion);
    for (const note of plan.notes) log.write(`Note: ${note}`);
    log.write(`Source: ${plan.artifact.url}`);
    checkAborted();

    const needsJava = plan.mode.kind === 'installer';
    let javaPath = '';
    if (needsJava) {
      let javaStep = '';
      const selection = await java.acquire(
        {
          javaPath: server.javaPath,
          loader: server.loader,
          mcVersion: server.mcVersion,
          requiredMajor: plan.requiredJavaMajor,
        },
        {
          signal,
          onProgress: (step) => {
            this.progress(server.id, 'java', step.percent, step.ref === undefined ? step.message : { text: step.message, ref: step.ref });
            if (step.phase !== javaStep) log.write(step.message);
            javaStep = step.phase;
          },
        },
      );
      javaPath = selection.runtime.path;
      log.write(`Using Java ${selection.runtime.major} (${selection.runtime.path})`);
      for (const warning of selection.warnings) log.write(`Note: ${warning.text}`);
    }

    const tmpDir = path.join(dir, '.tmp');
    await rm(tmpDir, { recursive: true, force: true });
    let lastReport = 0;
    const part = await downloadToTmp(
      {
        url: plan.artifact.url,
        fileName: plan.artifact.fileName,
        ...(plan.artifact.hash === undefined ? {} : { hash: plan.artifact.hash }),
        ...(plan.artifact.size === undefined ? {} : { size: plan.artifact.size }),
        allowedHosts: plan.artifact.allowedHosts,
        requireZip: plan.artifact.requireZip,
        onProgress: (received, total) => {
          const now = Date.now();
          if (now - lastReport < PROGRESS_INTERVAL_MS && received !== total) return;
          lastReport = now;
          const percent = total === null || total === 0 ? null : Math.min(99, Math.floor((received / total) * 100));
          this.progress(server.id, 'download', percent, msg('INSTALL_STEP_DOWNLOAD', { fileName: plan.artifact.fileName, kib: Math.round(received / 1024) }));
        },
      },
      tmpDir,
      catalog.downloader,
    );
    log.write(`Download finished${plan.artifact.hash === undefined ? '' : ` (${plan.artifact.hash.algorithm} verified)`}`);
    const target = path.join(dir, plan.artifact.fileName);
    try {
      await rename(part, target);
    } catch (error) {
      await removeQuietly(part);
      rethrowFsError(error, plan.artifact.fileName);
    }
    checkAborted();

    let launch: LaunchSpec;
    if (plan.mode.kind === 'jar') {
      launch = { kind: 'jar', jar: plan.mode.launchJar };
    } else {
      try {
        launch = await this.runInstaller(server, plan, javaPath, dir, log);
      } finally {
        await rm(target, { force: true }).catch(() => undefined);
      }
    }
    log.write(`Start file: ${launch.kind === 'jar' ? launch.jar : launch.unixFile}`);
    return {
      launchSpec: serializeLaunchSpec(launch),
      requiredJavaMajor: plan.requiredJavaMajor,
      loaderVersion: plan.loaderVersion,
    };
  }

  private async runInstaller(server: Server, plan: ResolvedInstall, javaPath: string, dir: string, log: LogFile): Promise<LaunchSpec> {
    if (plan.mode.kind !== 'installer') throw new AppError(500, 'INTERNAL_ERROR', 'Invalid installation mode.');
    this.progress(server.id, 'install', null, msg('INSTALL_STEP_INSTALLER'));
    log.write(`Running installer: java -jar ${plan.artifact.fileName} ${plan.mode.arguments.join(' ')}`);
    const tail: string[] = [];
    const timeoutMs = this.options.installerTimeoutMs ?? INSTALLER_TIMEOUT_MS;
    let result;
    try {
      result = await this.options.runner({
        javaPath,
        args: ['-jar', plan.artifact.fileName, ...plan.mode.arguments],
        cwd: dir,
        timeoutMs,
        signal: this.abort.signal,
        onLine: (line) => {
          log.write(line);
          tail.push(line);
          if (tail.length > TAIL_LINES) tail.shift();
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, 'The installer could not be started');
      throw new AppError(500, 'INSTALLER_FAILED', 'The installer could not be started. Is the Java file valid?', undefined, { reason: 'not-started' });
    }
    const output = tail.length === 0 ? '' : `\nLast output:\n${tail.join('\n')}`;
    if (result.aborted) throw new AppError(500, 'INSTALL_ABORTED', 'The installation was interrupted (the application is shutting down).');
    if (result.timedOut) {
      throw new AppError(500, 'INSTALLER_TIMEOUT', `The installer was cancelled after ${Math.round(timeoutMs / 60_000)} minutes.${output}`, undefined, {
        minutes: Math.round(timeoutMs / 60_000),
        output: tail.join('\n'),
      });
    }
    if (result.exitCode !== 0) {
      throw new AppError(500, 'INSTALLER_FAILED', `The installer failed with exit code ${result.exitCode ?? 'unknown'}.${output}`, undefined, {
        reason: 'exit',
        exitCode: result.exitCode ?? 'unknown',
        output: tail.join('\n'),
      });
    }
    if (server.loader !== 'forge' && server.loader !== 'neoforge') {
      throw new AppError(500, 'INTERNAL_ERROR', 'Invalid installation mode.');
    }
    return detectForgeLaunch(dir, server.loader, server.mcVersion, plan.loaderVersion);
  }
}
