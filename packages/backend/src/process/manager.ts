import { eq } from 'drizzle-orm';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/client.js';
import { servers, type Server } from '../db/schema.js';
import type { EventBus } from '../events/bus.js';
import { AppError, errorMsg } from '../http/errors.js';
import { msg, refOf, refsOf, textOf, textsOf, type MessageRef, type Msg, type Text } from '../messages.js';
import type { GameAdapters } from '../games/adapters.js';
import type { GameAdapter, PreparationTask } from '../games/types.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import type { ServerRuntimeGuard } from '../mods/runtime-guard.js';
import { normalizeExitCode } from './exit-code.js';
import { LineAssembler, RingBuffer } from './lines.js';
import { MetricsSampler, type ProcessMetrics, type SampleReader } from './metrics.js';
import { probePort, type PortProbe } from './ports.js';
import type { ProcessSpawner, ServerProcess } from './spawner.js';
import { offlineStatus, type ConsoleLine, type ConsoleStream, type RuntimeStatus, type ServerState } from './types.js';

export const MAX_COMMAND_LENGTH = 1024;
const HISTORY_SIZE = 2000;
const CRASH_TAIL_LINES = 20;

const ACTIVE_STATES: ReadonlySet<ServerState> = new Set(['preparing', 'starting', 'online', 'stopping']);
const PROGRESS_STATUS_INTERVAL_MS = 500;

export interface ConsoleListener {
  onLine(line: ConsoleLine): void;
  onStatus(status: RuntimeStatus): void;
}

export interface ProcessManagerOptions {
  db: Db;
  serversDir: string;
  lock: KeyedLock;
  spawner: ProcessSpawner;
  games: GameAdapters;
  bus: EventBus;
  probePort?: PortProbe;
  platform?: NodeJS.Platform;
  stopTimeoutMs?: number;
  readinessIntervalMs?: number;
  startWarningMs?: number;
  closeGraceMs?: number;
  metricsIntervalMs?: number;
  readSamples?: SampleReader;
  logger?: Logger;
  onStarted?: (server: Server) => void;
}

export interface StartResult {
  status: RuntimeStatus;
  warnings: string[];
  // key and params per warning, same order (null where a warning has no key)
  warningRefs: Array<MessageRef | null>;
}

// Phase before the process exists: work of the game (a missing Java runtime) runs in the background
interface Preparation {
  task: PreparationTask;
  controller: AbortController;
}

class Instance {
  constructor(readonly serverId: string) {}

  preparation: Preparation | null = null;
  javaPath: string | null = null;
  // the adapter of the running process: console lines and the stop command
  game: GameAdapter | null = null;
  // the row and folder of the running server, for adapters that talk to it (RCON, HTTPS API)
  server: Server | null = null;
  dir = '';
  playerCount: number | null = null;
  playerTimer: NodeJS.Timeout | null = null;
  // never shown in the console (an admin password on the command line)
  redact: string[] = [];

  status: RuntimeStatus = offlineStatus();
  readonly buffer = new RingBuffer<ConsoleLine>(HISTORY_SIZE);
  readonly players = new Set<string>();
  readonly listeners = new Set<ConsoleListener>();
  readonly waiters: Array<() => void> = [];
  seq = 0;
  reservedPort: number | null = null;
  child: ServerProcess | null = null;
  expectedExit = false;
  wasOnline = false;
  stopTimer: NodeJS.Timeout | null = null;
  warnTimer: NodeJS.Timeout | null = null;
  closeTimer: NodeJS.Timeout | null = null;
  finalized = true;
  readonly assemblers: LineAssembler[] = [];

  get active(): boolean {
    return ACTIVE_STATES.has(this.status.state);
  }
}

// status.message together with its reference
const statusMessage = (value: Text | null): Pick<RuntimeStatus, 'message' | 'messageRef'> => ({
  message: value === null ? null : textOf(value),
  messageRef: refOf(value),
});

const notFound = (): AppError => new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
const notRunning = (): AppError => new AppError(409, 'SERVER_NOT_RUNNING', 'The server is not running.');

export class ProcessManager implements ServerRuntimeGuard {
  private readonly instances = new Map<string, Instance>();
  private readonly sampler: MetricsSampler;
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly stopTimeoutMs: number;
  private readonly readinessIntervalMs: number;
  private readonly playerIntervalMs: number;
  private readonly startWarningMs: number;
  private readonly closeGraceMs: number;
  private readonly probe: PortProbe;
  private shuttingDown = false;
  private startGuard: (() => AppError | null) | null = null;

  constructor(private readonly options: ProcessManagerOptions) {
    this.logger = options.logger ?? silentLogger;
    this.platform = options.platform ?? process.platform;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 60_000;
    this.readinessIntervalMs = options.readinessIntervalMs ?? 2_000;
    this.playerIntervalMs = options.readinessIntervalMs === undefined ? 15_000 : options.readinessIntervalMs * 4;
    this.startWarningMs = options.startWarningMs ?? 5 * 60_000;
    this.closeGraceMs = options.closeGraceMs ?? 1500;
    this.probe = options.probePort ?? probePort;
    this.sampler = new MetricsSampler(
      () => this.activePids(),
      (metrics) => this.applyMetrics(metrics),
      {
        ...(options.readSamples === undefined ? {} : { read: options.readSamples }),
        ...(options.metricsIntervalMs === undefined ? {} : { intervalMs: options.metricsIntervalMs }),
        log: (error) => this.logger.warn({ err: error }, 'Measuring CPU and memory failed'),
      },
    );
  }

  // lets the self-update veto new starts while it stops and replaces the application
  setStartGuard(guard: (() => AppError | null) | null): void {
    this.startGuard = guard;
  }

  // ---- queries -----------------------------------------------------------------------------

  isRunning(serverId: string): boolean {
    return this.instances.get(serverId)?.active ?? false;
  }

  status(serverId: string): RuntimeStatus {
    const instance = this.instances.get(serverId);
    return instance === undefined ? offlineStatus() : this.snapshot(instance);
  }

  statuses(): Array<{ serverId: string; status: RuntimeStatus }> {
    return [...this.instances].map(([serverId, instance]) => ({ serverId, status: this.snapshot(instance) }));
  }

  history(serverId: string, limit = HISTORY_SIZE): ConsoleLine[] {
    return this.instances.get(serverId)?.buffer.last(limit) ?? [];
  }

  activeServerIds(): string[] {
    return [...this.instances].filter(([, instance]) => instance.active).map(([id]) => id);
  }

  listenerCount(serverId: string): number {
    return this.instances.get(serverId)?.listeners.size ?? 0;
  }

  get metricsActive(): boolean {
    return this.sampler.active;
  }

  subscribe(serverId: string, listener: ConsoleListener): () => void {
    const instance = this.instanceOf(serverId);
    instance.listeners.add(listener);
    return () => {
      instance.listeners.delete(listener);
    };
  }

  forget(serverId: string): void {
    const instance = this.instances.get(serverId);
    if (instance !== undefined && !instance.active) this.instances.delete(serverId);
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  async start(serverId: string): Promise<StartResult> {
    if (this.shuttingDown) throw new AppError(503, 'SHUTTING_DOWN', 'The application is shutting down.');
    const blocked = this.startGuard?.() ?? null;
    if (blocked !== null) throw blocked;
    if (this.isRunning(serverId)) throw this.alreadyRunning();
    // answered before queueing on the lock, so a running installation gives an immediate error instead of a wait
    this.assertInstalled(await this.loadServer(serverId));
    return this.options.lock.run(serverId, () => this.startLocked(serverId, null));
  }

  async stop(serverId: string): Promise<RuntimeStatus> {
    const instance = this.instances.get(serverId);
    if (instance === undefined || !instance.active) throw notRunning();
    this.requestStop(instance, msg('SERVER_STOPPING'));
    return this.snapshot(instance);
  }

  async restart(serverId: string): Promise<StartResult> {
    const instance = this.instances.get(serverId);
    if (instance?.active === true) {
      this.requestStop(instance, msg('SERVER_RESTARTING'));
      await this.waitForExit(instance);
    }
    return this.start(serverId);
  }

  async kill(serverId: string): Promise<RuntimeStatus> {
    const instance = this.instances.get(serverId);
    if (instance === undefined || !instance.active) throw notRunning();
    this.pushSystem(instance, msg('SERVER_KILLING'));
    await this.forceKill(instance);
    return this.snapshot(instance);
  }

  async sendCommand(serverId: string, command: string): Promise<void> {
    const instance = this.instances.get(serverId);
    if (instance === undefined || (instance.status.state !== 'starting' && instance.status.state !== 'online')) {
      throw notRunning();
    }
    if (command.trim() === '') throw new AppError(422, 'INVALID_COMMAND', 'The command must not be empty.');
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new AppError(422, 'INVALID_COMMAND', `The command is too long (at most ${MAX_COMMAND_LENGTH} characters).`, undefined, { max: MAX_COMMAND_LENGTH });
    }
    if (/[\r\n\u0000]/.test(command)) {
      throw new AppError(422, 'INVALID_COMMAND', 'The command must not contain line breaks.');
    }
    const adapter = instance.game;
    if (adapter?.sendCommand !== undefined && instance.server !== null) {
      this.pushLine(instance, 'input', command);
      let answer: string[];
      try {
        answer = await adapter.sendCommand(instance.server, instance.dir, command);
      } catch (error) {
        throw error instanceof AppError ? error : new AppError(502, 'COMMAND_FAILED', 'The server did not take the command.');
      }
      for (const line of answer) this.handleLine(instance, 'stdout', line);
      return;
    }
    const child = instance.child;
    if (child === null || !child.stdin.writable) throw notRunning();
    child.stdin.write(`${command}\n`);
    this.pushLine(instance, 'input', command);
    if (/^\/?stop$/i.test(command.trim())) this.markStopping(instance);
  }

  // Graceful stop of everything, force kill of whatever is left. Safe to call more than once.
  async shutdown(timeoutMs: number): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.instances.values()].filter((instance) => instance.active);
    for (const instance of active) this.requestStop(instance, msg('SERVER_STOPPING_APP_SHUTDOWN'));
    const settled = Promise.all(active.map((instance) => this.waitForExit(instance)));
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([settled.then(() => 'done' as const), timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      const leftovers = active.filter((instance) => instance.active);
      await Promise.all(leftovers.map((instance) => this.forceKill(instance)));
      await Promise.race([Promise.all(leftovers.map((instance) => this.waitForExit(instance))), delay(5000)]);
    }
    this.sampler.stop();
  }

  // ---- start -------------------------------------------------------------------------------

  private alreadyRunning(): AppError {
    return new AppError(409, 'SERVER_ALREADY_RUNNING', 'The server is already running or starting.');
  }

  private instanceOf(serverId: string): Instance {
    let instance = this.instances.get(serverId);
    if (instance === undefined) {
      instance = new Instance(serverId);
      this.instances.set(serverId, instance);
    }
    return instance;
  }

  private async loadServer(serverId: string): Promise<Server> {
    const server = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (server === undefined) throw notFound();
    return server;
  }

  private assertInstalled(server: Server): void {
    if (server.installState === 'installed') return;
    const reason: Record<Server['installState'], string> = {
      pending: 'The server is not installed yet.',
      installing: 'The installation is still running. Please wait until it has finished.',
      failed: 'The installation failed. Please start the installation again.',
      installed: '',
    };
    throw new AppError(409, 'SERVER_NOT_INSTALLED', reason[server.installState]);
  }

  private async startLocked(serverId: string, resume: Preparation | null): Promise<StartResult> {
    const { db, serversDir } = this.options;
    if (resume === null) {
      if (this.isRunning(serverId)) throw this.alreadyRunning();
    } else if (this.instances.get(serverId)?.preparation !== resume) {
      throw this.cancelled();
    }
    const server = await this.loadServer(serverId);
    this.assertInstalled(server);
    const serverDir = path.join(serversDir, server.id);
    const adapter = this.options.games.forServer(server);
    const start = await adapter.planStart(server, serverDir, { resumed: resume !== null });
    if (start.kind === 'prepare') {
      if (resume !== null) throw start.task.stillMissing();
      return this.beginPreparation(serverId, start.port, start.task, start.notes);
    }
    const { plan } = start;
    const port = plan.port;
    const instance = this.instanceOf(serverId);
    // reserved until the process runs, so two starts racing for one port cannot both pass the check
    instance.reservedPort = port;
    try {
      await this.assertPortFree(serverId, port);
      await plan.beforeSpawn();
      if (resume !== null && (resume.controller.signal.aborted || instance.preparation !== resume)) throw this.cancelled();
      instance.preparation = null;
      this.resetInstance(instance, port);
      instance.javaPath = plan.javaPath;
      instance.game = adapter;
      instance.server = server;
      instance.dir = serverDir;
      instance.redact = plan.redact ?? [];
      this.pushSystem(instance, plan.startLine);
      for (const warning of plan.notes) this.pushSystem(instance, msg('START_NOTE', { note: warning }));
      await this.spawnServer(instance, plan.command, plan.args, plan.cwd ?? serverDir, port, plan.env);
      if (plan.readiness !== undefined) this.pollReadiness(instance, plan.readiness);
    } finally {
      instance.reservedPort = null;
    }

    await db
      .transaction((tx) => tx.update(servers).set({ lastStartedAt: new Date(), updatedAt: new Date() }).where(eq(servers.id, serverId)))
      .catch((error: unknown) => this.logger.error({ err: error, serverId }, 'Start time could not be saved'));
    this.armStartWarning(instance);
    this.sampler.start();
    try {
      this.options.onStarted?.(server);
    } catch (error) {
      this.logger.error({ err: error, serverId }, 'Post-start processing after the server start failed');
    }
    return { status: this.snapshot(instance), warnings: textsOf(plan.notes), warningRefs: refsOf(plan.notes) };
  }

  private async spawnServer(instance: Instance, command: string, args: string[], cwd: string, port: number, env?: Record<string, string>): Promise<void> {
    let child: ServerProcess;
    try {
      child = this.options.spawner.spawn({ command, args, cwd, ...(env === undefined ? {} : { env }) });
    } catch (error) {
      this.failStart(instance, error);
      throw this.startError(error);
    }
    this.attach(instance, child);
    this.update(instance, { state: 'starting', pid: child.pid ?? null, startedAt: Date.now(), port });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      this.failStart(instance, error);
      throw this.startError(error);
    }
    this.update(instance, { pid: child.pid ?? null });
  }


  private async assertPortFree(serverId: string, port: number): Promise<void> {
    for (const [otherId, other] of this.instances) {
      const holdsPort = other.active ? other.status.port === port : other.reservedPort === port;
      if (otherId === serverId || !holdsPort) continue;
      const row = (await this.options.db.select({ name: servers.name }).from(servers).where(eq(servers.id, otherId)))[0];
      const name = row?.name ?? otherId;
      throw new AppError(
        409,
        'PORT_IN_USE',
        `Port ${port} is already used by the running server "${name}". Please set a different port in the server properties.`,
        { port, serverId: otherId, serverName: name },
      );
    }
    const state = await this.probe(port);
    if (state === 'in-use') {
      throw new AppError(
        409,
        'PORT_IN_USE',
        `Port ${port} is already in use by another program. Please quit the program or set a different port in the server properties.`,
        { port },
      );
    }
    if (state === 'denied') {
      throw new AppError(409, 'PORT_IN_USE', `Listening on port ${port} is not allowed (missing permission). Please choose a different port.`, {
        port,
      });
    }
  }

  private startError(error: unknown): AppError {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = code === 'ENOENT' ? 'The Java file was not found.' : code === 'EACCES' ? 'Access to the Java file was denied.' : 'The process could not be created.';
    return new AppError(500, 'START_FAILED', `The server could not be started. ${detail}`, undefined, {
      reason: code === 'ENOENT' ? 'java-not-found' : code === 'EACCES' ? 'java-denied' : 'spawn-failed',
    });
  }

  private failStart(instance: Instance, error: unknown): void {
    this.logger.error({ err: error }, 'The server process could not be started');
    const failure = errorMsg(this.startError(error), msg('START_UNEXPECTED_ERROR'));
    this.clearTimers(instance);
    instance.child = null;
    instance.finalized = true;
    this.pushSystem(instance, failure);
    this.update(instance, { state: 'crashed', pid: null, ...statusMessage(failure), exitCode: null });
    this.settle(instance);
  }

  // ---- preparation: installing a missing Java runtime -------------------------------------------
  //
  // start() must answer quickly, so a missing runtime does not block the request. The instance moves to
  // "preparing", the install runs in the background without holding the server lock (other operations on
  // the server stay possible, and are refused anyway because the server counts as running), and once the
  // runtime exists the normal start path runs again under the lock. stop, kill, restart and shutdown cancel
  // the preparation; a failure ends in "crashed" with a readable message.

  private cancelled(): AppError {
    return new AppError(409, 'START_CANCELLED', 'The start was cancelled.');
  }

  private beginPreparation(serverId: string, port: number, task: PreparationTask, warnings: Msg[]): StartResult {
    const instance = this.instanceOf(serverId);
    this.resetInstance(instance, null);
    instance.finalized = true;
    const preparation: Preparation = { task, controller: new AbortController() };
    instance.preparation = preparation;
    this.pushSystem(instance, task.notice);
    this.update(instance, { state: 'preparing', startedAt: Date.now(), port, ...statusMessage(task.status(null)) });
    void this.runPreparation(instance, preparation);
    return { status: this.snapshot(instance), warnings: textsOf(warnings), warningRefs: refsOf(warnings) };
  }

  private async runPreparation(instance: Instance, preparation: Preparation): Promise<void> {
    const { task, controller } = preparation;
    let lastStatus = 0;
    let lastPhase = '';
    let lastStep = -1;
    try {
      await task.run(controller.signal, (progress) => {
        if (instance.preparation !== preparation) return;
        const step = Math.floor((progress.percent ?? 0) / 25);
        if (progress.phase !== lastPhase || (progress.phase === 'download' && step !== lastStep)) {
          this.pushSystem(instance, progress.text);
          lastPhase = progress.phase;
          lastStep = step;
        }
        const now = Date.now();
        if (now - lastStatus < PROGRESS_STATUS_INTERVAL_MS) return;
        lastStatus = now;
        this.update(instance, statusMessage(task.status(progress.percent)));
      });
      if (instance.preparation !== preparation) return;
      this.pushSystem(instance, task.done);
      await this.options.lock.run(instance.serverId, async () => {
        if (instance.preparation !== preparation) return;
        await this.startLocked(instance.serverId, preparation);
      });
    } catch (error) {
      if (instance.preparation !== preparation) return;
      const failure = errorMsg(error, task.failed);
      if (!(error instanceof AppError)) this.logger.error({ err: error, serverId: instance.serverId }, 'The preparation before the server start failed');
      this.failPreparation(instance, failure);
    }
  }

  private failPreparation(instance: Instance, failure: Msg): void {
    instance.preparation = null;
    this.pushSystem(instance, msg('START_FAILED_REASON', { reason: failure }));
    this.update(instance, { state: 'crashed', pid: null, exitCode: null, ...statusMessage(failure), cpuPercent: null, rssBytes: null });
    this.settle(instance);
  }

  private cancelPreparation(instance: Instance, notice: Text): void {
    const preparation = instance.preparation;
    if (preparation === null) return;
    instance.preparation = null;
    preparation.controller.abort();
    this.pushSystem(instance, notice);
    this.update(instance, { state: 'offline', pid: null, startedAt: null, ...statusMessage(null) });
    this.settle(instance);
  }

  // Autostart and other background starters: shows a failure that happened before a process existed
  markStartFailed(serverId: string, reason: Text): void {
    const instance = this.instanceOf(serverId);
    if (instance.active) return;
    const failure = typeof reason === 'string' ? { text: reason, ref: null } : reason;
    this.pushSystem(instance, failure.ref === null ? `The server could not be started: ${failure.text}` : msg('START_FAILED_REASON', { reason: failure as Msg }));
    this.update(instance, { state: 'crashed', pid: null, exitCode: null, ...statusMessage(reason) });
  }

  announce(serverId: string, text: Text): void {
    const instance = this.instances.get(serverId);
    if (instance !== undefined) this.pushSystem(instance, text);
  }

  waitWhilePreparing(serverId: string): Promise<void> {
    if (this.instances.get(serverId)?.status.state !== 'preparing') return Promise.resolve();
    return new Promise((resolve) => {
      const unsubscribe = this.options.bus.subscribe((event) => {
        if (event.type !== 'server.status' || event.serverId !== serverId || event.status.state === 'preparing') return;
        unsubscribe();
        resolve();
      });
    });
  }

  // which running or preparing servers depend on which Java, for refusing the removal of a managed runtime
  javaUsage(): Array<{ serverId: string; javaPath: string | null; preparingMajor: number | null }> {
    return [...this.instances.values()]
      .filter((instance) => instance.active)
      .map((instance) => ({ serverId: instance.serverId, javaPath: instance.javaPath, preparingMajor: instance.preparation?.task.javaMajor ?? null }));
  }

  private resetInstance(instance: Instance, port: number | null): void {
    instance.players.clear();
    instance.playerCount = null;
    if (instance.playerTimer !== null) clearTimeout(instance.playerTimer);
    instance.playerTimer = null;
    instance.expectedExit = false;
    instance.wasOnline = false;
    instance.finalized = false;
    instance.child = null;
    instance.status = { ...offlineStatus(), port };
  }

  // ---- process wiring ----------------------------------------------------------------------

  private attach(instance: Instance, child: ServerProcess): void {
    instance.child = child;
    instance.assemblers.length = 0;
    const out = new LineAssembler((line) => this.handleLine(instance, 'stdout', line));
    const err = new LineAssembler((line) => this.handleLine(instance, 'stderr', line));
    instance.assemblers.push(out, err);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    // a write after the process died must not surface as an unhandled stream error
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.on('error', (error) => {
      if (instance.child === child && !instance.finalized) {
        this.logger.warn({ err: error }, 'Server process error');
      }
    });
    child.once('exit', (code, signal) => {
      instance.closeTimer = setTimeout(() => this.finalize(instance, child, code, signal), this.closeGraceMs);
    });
    child.once('close', (code, signal) => this.finalize(instance, child, code, signal));
  }

  private handleLine(instance: Instance, stream: ConsoleStream, raw: string): void {
    let text = raw;
    for (const secret of instance.redact) if (secret !== '') text = text.split(secret).join('[hidden]');
    this.pushLine(instance, stream, text);
    const event = instance.game?.classifyLine(text) ?? null;
    if (event === null) return;
    if (event.type === 'done') {
      this.markOnline(instance);
    } else if (event.type === 'join') {
      instance.players.add(event.name);
      this.update(instance, {});
    } else if (instance.players.delete(event.name)) {
      this.update(instance, {});
    }
  }

  private finalize(instance: Instance, child: ServerProcess, rawCode: number | null, signal: NodeJS.Signals | null): void {
    if (instance.child !== child || instance.finalized) return;
    const code = normalizeExitCode(rawCode);
    instance.finalized = true;
    this.clearTimers(instance);
    for (const assembler of instance.assemblers) assembler.flush();
    const expected = instance.expectedExit || this.shuttingDown;
    const cleanExit = code === 0 && instance.wasOnline;
    const crashed = !expected && !cleanExit;
    const exitParams = signal !== null ? { signal } : code !== null ? { code } : {};
    const exitMsg = msg(crashed ? 'SERVER_EXITED_UNEXPECTEDLY' : 'SERVER_STOPPED', exitParams);
    this.pushSystem(instance, exitMsg);
    instance.players.clear();
    instance.child = null;
    const tail = instance.buffer.last(CRASH_TAIL_LINES);
    const lastLines = tail.map((line) => line.text);
    const lastLinesRefs = tail.map((line) => line.textRef ?? null);
    this.update(instance, {
      state: crashed ? 'crashed' : 'offline',
      pid: null,
      exitCode: code,
      ...statusMessage(crashed ? exitMsg : null),
      cpuPercent: null,
      rssBytes: null,
    });
    if (crashed) {
      this.options.bus.emit({ type: 'server.crashed', serverId: instance.serverId, exitCode: code, lastLines, lastLinesRefs });
    }
    const serverId = instance.serverId;
    void this.options.db
      .transaction((tx) => tx.update(servers).set({ lastExitCode: code, updatedAt: new Date() }).where(eq(servers.id, serverId)))
      .catch((error: unknown) => this.logger.error({ err: error, serverId }, 'Exit code could not be saved'))
      .finally(() => {
        this.settle(instance);
        if (this.activeServerIds().length === 0) this.sampler.stop();
      });
  }

  private settle(instance: Instance): void {
    for (const resolve of instance.waiters.splice(0)) resolve();
  }

  private waitForExit(instance: Instance): Promise<void> {
    if (!instance.active) return Promise.resolve();
    return new Promise((resolve) => instance.waiters.push(resolve));
  }

  // ---- stopping ----------------------------------------------------------------------------

  private markStopping(instance: Instance): void {
    instance.expectedExit = true;
    if (instance.status.state !== 'stopping') this.update(instance, { state: 'stopping' });
    if (instance.stopTimer === null) {
      instance.stopTimer = setTimeout(() => {
        this.pushSystem(instance, msg('SERVER_STOP_TIMEOUT', { seconds: Math.round(this.stopTimeoutMs / 1000) }));
        void this.forceKill(instance);
      }, this.stopTimeoutMs);
    }
  }

  private requestStop(instance: Instance, notice: Text): void {
    if (instance.status.state === 'stopping') return;
    if (instance.preparation !== null) {
      this.cancelPreparation(instance, instance.preparation.task.cancelled);
      return;
    }
    this.pushSystem(instance, notice);
    this.markStopping(instance);
    const child = instance.child;
    const adapter = instance.game;
    const fallback = (): void => {
      if (instance.child !== child || child === null || child.exitCode !== null) return;
      const command = adapter?.stopCommand ?? null;
      if (command !== null && child.stdin.writable) child.stdin.write(`${command}\n`);
      else if (command === null) child.kill(adapter?.stopSignal ?? 'SIGTERM');
      else void this.forceKill(instance);
    };
    if (child === null) {
      void this.forceKill(instance);
      return;
    }
    if (adapter?.stop !== undefined && instance.server !== null) {
      adapter.stop(instance.server, instance.dir).catch((error: unknown) => {
        this.logger.warn({ err: error, serverId: instance.serverId }, 'The clean stop of the game failed; stopping the process instead');
        fallback();
      });
      return;
    }
    fallback();
  }

  private async forceKill(instance: Instance): Promise<void> {
    if (instance.preparation !== null) {
      this.cancelPreparation(instance, instance.preparation.task.cancelled);
      return;
    }
    instance.expectedExit = true;
    if (instance.status.state !== 'stopping' && instance.active) this.update(instance, { state: 'stopping' });
    const child = instance.child;
    if (child === null) return;
    try {
      await this.options.spawner.killTree(child);
    } catch (error) {
      this.logger.error({ err: error }, 'The server process could not be stopped');
    }
  }

  // ---- state + output ----------------------------------------------------------------------

  private snapshot(instance: Instance): RuntimeStatus {
    return { ...instance.status, players: [...instance.players], playerCount: instance.playerCount };
  }

  private update(instance: Instance, patch: Partial<RuntimeStatus>): void {
    instance.status = { ...instance.status, ...patch };
    const status = this.snapshot(instance);
    this.options.bus.emit({ type: 'server.status', serverId: instance.serverId, status });
    for (const listener of [...instance.listeners]) {
      try {
        listener.onStatus(status);
      } catch (error) {
        this.logger.error({ err: error }, 'Console listener failed');
      }
    }
  }

  private pushSystem(instance: Instance, text: Text): void {
    this.pushLine(instance, 'system', text);
  }

  private pushLine(instance: Instance, stream: ConsoleStream, content: Text): void {
    const ref = refOf(content);
    const line: ConsoleLine = { seq: ++instance.seq, time: Date.now(), stream, text: textOf(content), ...(ref === null ? {} : { textRef: ref }) };
    instance.buffer.push(line);
    for (const listener of [...instance.listeners]) {
      try {
        listener.onLine(line);
      } catch (error) {
        this.logger.error({ err: error }, 'Console listener failed');
      }
    }
  }

  private markOnline(instance: Instance): void {
    if (instance.status.state !== 'starting') return;
    instance.wasOnline = true;
    this.clearTimer(instance, 'warnTimer');
    this.update(instance, { state: 'online', ...statusMessage(null) });
    this.pollPlayers(instance);
  }

  // Games that report players only when asked (RCON, HTTPS API)
  private pollPlayers(instance: Instance): void {
    const adapter = instance.game;
    const server = instance.server;
    if (adapter?.playerList === undefined || server === null) return;
    const child = instance.child;
    const tick = (): void => {
      instance.playerTimer = null;
      if (instance.child !== child || instance.status.state !== 'online') return;
      adapter
        .playerList?.(server, instance.dir)
        .then((result) => {
          if (instance.child !== child) return;
          if (result.names !== null) {
            instance.players.clear();
            for (const name of result.names) instance.players.add(name);
          }
          instance.playerCount = result.count;
          this.update(instance, {});
        })
        .catch(() => undefined)
        .finally(() => {
          if (instance.child === child && instance.status.state === 'online') instance.playerTimer = setTimeout(tick, this.playerIntervalMs);
        });
    };
    tick();
  }

  // For games without a ready line: asks the game itself until it answers, as long as this process is starting
  private pollReadiness(instance: Instance, ready: () => Promise<boolean>): void {
    const child = instance.child;
    const tick = (): void => {
      if (instance.child !== child || instance.status.state !== 'starting') return;
      ready()
        .catch(() => false)
        .then((ok) => {
          if (instance.child !== child) return;
          if (ok) this.markOnline(instance);
          else if (instance.status.state === 'starting') setTimeout(tick, this.readinessIntervalMs).unref();
        });
    };
    setTimeout(tick, this.readinessIntervalMs).unref();
  }

  private armStartWarning(instance: Instance): void {
    instance.warnTimer = setTimeout(() => {
      if (instance.status.state !== 'starting') return;
      const notice = msg('SERVER_NOT_REPORTED_STARTED');
      this.pushSystem(instance, notice);
      this.update(instance, statusMessage(notice));
    }, this.startWarningMs);
  }

  private clearTimer(instance: Instance, name: 'stopTimer' | 'warnTimer' | 'closeTimer'): void {
    const timer = instance[name];
    if (timer !== null) clearTimeout(timer);
    instance[name] = null;
  }

  private clearTimers(instance: Instance): void {
    if (instance.playerTimer !== null) clearTimeout(instance.playerTimer);
    instance.playerTimer = null;
    this.clearTimer(instance, 'stopTimer');
    this.clearTimer(instance, 'warnTimer');
    this.clearTimer(instance, 'closeTimer');
  }

  // ---- metrics -----------------------------------------------------------------------------

  private activePids(): number[] {
    const pids: number[] = [];
    for (const instance of this.instances.values()) {
      if (instance.active && instance.status.pid !== null) pids.push(instance.status.pid);
    }
    return pids;
  }

  private applyMetrics(metrics: Map<number, ProcessMetrics>): void {
    for (const [serverId, instance] of this.instances) {
      const pid = instance.status.pid;
      const sample = pid === null ? undefined : metrics.get(pid);
      if (!instance.active || sample === undefined) continue;
      instance.status = { ...instance.status, cpuPercent: sample.cpuPercent, rssBytes: sample.rssBytes };
      this.options.bus.emit({ type: 'server.metrics', serverId, cpuPercent: sample.cpuPercent, rssBytes: sample.rssBytes });
    }
  }
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
