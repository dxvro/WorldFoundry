import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desc, eq, sql } from 'drizzle-orm';
import type { AppConfig } from '../config/env.js';
import type { Db } from '../db/client.js';
import type { SelfUpdateResult } from '../db/enums.js';
import { appSettings, updateHistory } from '../db/schema.js';
import type { EventBus } from '../events/bus.js';
import { AppError, errorMsg } from '../http/errors.js';
import { msg, parseRef, refOf, serializeRef, textOf, type MessageRef, type Msg, type Text } from '../messages.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import type { ProcessManager } from '../process/manager.js';
import { detectInstallMode, installRootOf, readTestMarker, type ModeInfo } from './environment.js';
import { downloadFile, fetchSmallBuffer, UPDATE_ALLOWED_HOSTS, type UpdateHttpOptions } from './http.js';
import { TRUSTED_UPDATE_KEYS, type TrustedKey } from './keys.js';
import { clearRequestDir, isTerminalState, newRequest, readStatus, requestDirOf, submitRequest, type UpdaterStatus } from './protocol.js';
import { fetchReleases, findFiles, MAX_ASSET_BYTES, pickLatest, type FilesLookup, type Release } from './releases.js';
import { isNewerVersion } from './semver.js';
import { isBlockingPhase, isBusy, nextPhase, PHASE_LABELS, type UpdateEvent } from './state.js';
import type { InstallMode, LatestRelease, SystemUpdateState, UpdateHistoryEntry, UpdatePhase, UpdateProgress } from './types.js';
import { MAX_SIGNATURE_BYTES, MAX_SUMS_BYTES, SIGNATURE_NAME, SUMS_NAME, verifyRelease } from './verify.js';

const HOUR = 3_600_000;
const COUNTDOWN_MARKS = [60, 30, 10, 5, 4, 3, 2, 1];
const KEY_AUTO_CHECK = 'update.autoCheck';
const KEY_JOB = 'update.job';
const KEY_CHECK = 'update.check';
const HISTORY_LIMIT = 20;

export interface UpdateTimings {
  // first automatic check after the start of the application (plus up to bootJitterMs)
  bootDelayMs: number;
  bootJitterMs: number;
  intervalMs: number;
  httpTimeoutMs: number;
  statusPollMs: number;
  // the updater must react to a request within this time
  pickupTimeoutMs: number;
  // from the request until the new version reports back
  installTimeoutMs: number;
  // how long stopping the servers may take
  stopWaitMs: number;
  tickMs: number;
}

export interface UpdateServiceOptions {
  db: Db;
  config: AppConfig;
  bus: EventBus;
  manager: ProcessManager;
  currentVersion: string;
  logger?: Logger;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  // tests: replace what is normally derived from the installation
  installRoot?: string;
  codeRoot?: string;
  mode?: ModeInfo;
  keys?: readonly TrustedKey[];
  apiBase?: string;
  allowInsecureHttp?: boolean;
  timings?: Partial<UpdateTimings>;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // returns a reason when something prevents an update right now (running installation, backup, ...)
  preflight?: () => Promise<Msg | null>;
}

interface Job {
  id: string;
  fromVersion: string;
  toVersion: string;
  startedAt: number;
  serverIds: string[];
  // stopping: servers are being stopped; handed-over: the request was written
  step: 'prepared' | 'stopping' | 'handed-over';
}

interface StoredCheck {
  at: number | null;
  error: string | null;
  // optional: caches written before references existed have none
  errorRef?: MessageRef | null;
  release: Release | null;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class UpdateService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly timings: UpdateTimings;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly modeInfo: ModeInfo;
  private readonly keys: readonly TrustedKey[];
  private readonly http: UpdateHttpOptions;
  private readonly apiBase: string;
  private readonly testBuild: boolean;

  private phase: UpdatePhase = 'idle';
  private progress: UpdateProgress | null = null;
  private error: Text | null = null;
  private job: Job | null = null;
  private autoCheck = true;
  private check: StoredCheck = { at: null, error: null, release: null };
  private history: UpdateHistoryEntry[] = [];
  private checking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private cancelRequested = false;
  private stopping = false;
  private bypassGuard = false;
  private stopped = false;
  private lastProgressEmit = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly options: UpdateServiceOptions) {
    this.db = options.db;
    this.config = options.config;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? delay;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    const codeRootArg = options.codeRoot === undefined ? {} : { codeRoot: options.codeRoot };
    const root = options.installRoot ?? installRootOf(options.codeRoot);
    this.modeInfo = options.mode ?? detectInstallMode(this.config, codeRootArg.codeRoot, this.platform);

    // Test builds (marker file in the install folder) may talk to a local fake GitHub and trust an extra key.
    // Everywhere else UPDATE_API_BASE is ignored and only the keys compiled into the application count.
    const marker = readTestMarker(root);
    this.testBuild = marker !== null || options.apiBase !== undefined;
    const requestedBase = options.apiBase ?? (marker === null ? undefined : (this.config.updateApiBase ?? marker.apiBase));
    if (marker === null && this.config.updateApiBase !== undefined && options.apiBase === undefined) {
      this.logger.warn({}, 'UPDATE_API_BASE is ignored: only test packages may change the update source.');
    }
    this.apiBase = requestedBase ?? 'https://api.github.com';
    this.keys = options.keys ?? [...TRUSTED_UPDATE_KEYS, ...(marker?.trustedKeys ?? [])];
    const apiHost = new URL(this.apiBase).hostname;
    const insecure = options.allowInsecureHttp ?? (requestedBase !== undefined && this.apiBase.startsWith('http:'));
    this.timings = {
      bootDelayMs: 60_000,
      bootJitterMs: 30_000,
      intervalMs: 6 * HOUR,
      httpTimeoutMs: 20_000,
      statusPollMs: 2000,
      pickupTimeoutMs: 120_000,
      installTimeoutMs: 30 * 60_000,
      stopWaitMs: this.config.stopTimeoutMs + 30_000,
      tickMs: 1000,
      ...options.timings,
    };
    this.http = {
      fetch: options.fetch ?? fetch,
      allowedHosts: this.testBuild && requestedBase !== undefined ? [...UPDATE_ALLOWED_HOSTS, apiHost] : UPDATE_ALLOWED_HOSTS,
      timeoutMs: this.timings.httpTimeoutMs,
      userAgent: `WorldFoundry/${options.currentVersion}`,
      ...(insecure ? { allowInsecureHttp: true } : {}),
    };
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  // Loads the persisted state, settles an update that was running when the application went down, and schedules
  // the automatic checks. Called once the application is up.
  async start(): Promise<void> {
    await this.load();
    this.stopped = false;
    if (this.job !== null) {
      this.running = this.recover().catch((error: unknown) => this.logger.error({ err: error }, 'Finishing the update failed'));
    }
    void this.cleanupUpdatesDir();
    if (this.config.updateCheck) this.schedule(this.timings.bootDelayMs + Math.floor(this.random() * this.timings.bootJitterMs));
    this.emit();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
  }

  // resolves when a running update or recovery has ended (tests, shutdown)
  async idle(): Promise<void> {
    await this.running;
    await this.checking;
  }

  private schedule(afterMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runScheduledCheck();
    }, afterMs);
    this.timer.unref();
  }

  private async runScheduledCheck(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.autoCheck && !isBusy(this.phase)) await this.runCheck('auto');
    } catch {
      // already logged and stored by runCheck
    }
    if (!this.stopped) this.schedule(Math.round(this.timings.intervalMs * (0.9 + this.random() * 0.2)));
  }

  private async load(): Promise<void> {
    const autoCheck = await this.getSetting(KEY_AUTO_CHECK);
    this.autoCheck = autoCheck !== 'false';
    const stored = await this.getSetting(KEY_CHECK);
    if (stored !== null) {
      try {
        const parsed = JSON.parse(stored) as StoredCheck;
        this.check = { at: parsed.at ?? null, error: parsed.error ?? null, errorRef: parsed.errorRef ?? null, release: parsed.release ?? null };
      } catch {
        // an unreadable cache is just an empty cache
      }
    }
    const job = await this.getSetting(KEY_JOB);
    if (job !== null) {
      try {
        this.job = JSON.parse(job) as Job;
      } catch {
        await this.setSetting(KEY_JOB, null);
      }
    }
    await this.loadHistory();
  }

  // ---- state ----------------------------------------------------------------------------------

  private get latestRelease(): Release | null {
    return this.check.release;
  }

  private filesLookup(): FilesLookup | null {
    return this.latestRelease === null ? null : findFiles(this.latestRelease, this.platform, this.arch);
  }

  private updateAvailable(): boolean {
    return this.latestRelease !== null && isNewerVersion(this.latestRelease.version, this.options.currentVersion);
  }

  // the key of the install mode note (the text itself comes from detectInstallMode)
  private modeNoteRef(): MessageRef | null {
    return this.modeInfo.mode === 'dev' ? msg('UPDATE_NOTE_DEV').ref : this.modeInfo.mode === 'portable' ? msg('UPDATE_NOTE_PORTABLE').ref : null;
  }

  private applyBlockReason(): Text | null {
    if (!this.config.updateCheck) return msg('UPDATE_CHECKS_DISABLED');
    if (this.modeInfo.mode !== 'service') return this.modeInfo.note === null ? null : { text: this.modeInfo.note, ref: this.modeNoteRef() as MessageRef };
    if (isBusy(this.phase)) return msg('UPDATE_ALREADY_RUNNING');
    if (!this.updateAvailable()) return msg('UPDATE_NO_NEWER');
    const files = this.filesLookup();
    if (files !== null && !files.ok) return { text: files.reason, ref: files.reasonRef };
    return null;
  }

  snapshot(): SystemUpdateState {
    const release = this.latestRelease;
    const files = this.filesLookup();
    const reason = this.applyBlockReason();
    const latest: LatestRelease | null =
      release === null
        ? null
        : {
            version: release.version,
            name: release.name,
            notes: release.notes,
            publishedAt: release.publishedAt,
            htmlUrl: release.htmlUrl,
            prerelease: release.prerelease,
            assetSizeBytes: files !== null && files.ok ? files.files.asset.size : null,
          };
    return {
      currentVersion: this.options.currentVersion,
      installMode: this.modeInfo.mode,
      installModeNote: this.modeInfo.note,
      installModeNoteRef: this.modeInfo.note === null ? null : this.modeNoteRef(),
      checksEnabled: this.config.updateCheck,
      autoCheck: this.autoCheck,
      channel: this.config.updateChannel,
      repo: this.config.updateRepo,
      countdownSeconds: this.config.updateCountdownSeconds,
      checking: this.checking !== null,
      lastCheckAt: this.check.at,
      lastCheckError: this.check.error,
      lastCheckErrorRef: this.check.errorRef ?? null,
      latest,
      updateAvailable: this.updateAvailable(),
      canApply: reason === null,
      canApplyReason: reason === null ? null : textOf(reason),
      canApplyReasonRef: refOf(reason),
      phase: this.phase,
      progress: this.progress,
      error: this.error === null ? null : textOf(this.error),
      errorRef: refOf(this.error),
      job:
        this.job === null
          ? null
          : { id: this.job.id, fromVersion: this.job.fromVersion, toVersion: this.job.toVersion, startedAt: this.job.startedAt, servers: this.job.serverIds.length },
      history: this.history,
    };
  }

  private emit(): void {
    this.options.bus.emit({ type: 'update.state', state: this.snapshot() });
  }

  private move(event: UpdateEvent): void {
    this.phase = nextPhase(this.phase, event);
  }

  private setProgress(message: Text, percent: number | null = null, countdownRemaining: number | null = null): void {
    this.progress = { message: textOf(message), messageRef: refOf(message), percent, countdownRemaining };
    this.emit();
  }

  // blocks starting and changing servers while the update stops them and installs
  get blocking(): boolean {
    return !this.bypassGuard && isBlockingPhase(this.phase);
  }

  // why the application must not be restarted right now (an update is stopping servers or installing)
  restartBlocker(): Msg | null {
    return isBusy(this.phase) ? msg('UPDATE_RESTART_BLOCKED') : null;
  }

  startGuard(): AppError | null {
    if (!this.blocking) return null;
    return new AppError(409, 'UPDATE_IN_PROGRESS', `WorldFoundry is being updated (${PHASE_LABELS[this.phase]}). Servers can only be started or changed afterwards.`, undefined, { phase: this.phase });
  }

  // ---- settings and history ------------------------------------------------------------------

  private async getSetting(key: string): Promise<string | null> {
    const rows = await this.db.select().from(appSettings).where(eq(appSettings.key, key));
    return rows[0]?.value ?? null;
  }

  private async setSetting(key: string, value: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (value === null) {
        await tx.delete(appSettings).where(eq(appSettings.key, key));
      } else {
        await tx
          .insert(appSettings)
          .values({ key, value, updatedAt: new Date(this.now()) })
          .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date(this.now()) } });
      }
    });
  }

  private async loadHistory(): Promise<void> {
    const rows = await this.db.select().from(updateHistory).orderBy(desc(updateHistory.finishedAt), desc(updateHistory.id)).limit(HISTORY_LIMIT);
    this.history = rows.map((row) => ({
      id: row.id,
      fromVersion: row.fromVersion,
      toVersion: row.toVersion,
      result: row.result,
      message: row.message,
      messageRef: parseRef(row.messageRef),
      stoppedServers: row.stoppedServers,
      startedAt: row.startedAt.getTime(),
      finishedAt: row.finishedAt.getTime(),
    }));
  }

  private async addHistory(job: Job, result: SelfUpdateResult, message: Text | null): Promise<void> {
    await this.db.transaction((tx) =>
      tx.insert(updateHistory).values({
        fromVersion: job.fromVersion,
        toVersion: job.toVersion,
        result,
        message: message === null ? null : textOf(message),
        messageRef: serializeRef(refOf(message)),
        stoppedServers: job.serverIds.length,
        startedAt: new Date(job.startedAt),
        finishedAt: new Date(this.now()),
      }),
    );
    await this.loadHistory();
  }

  async setAutoCheck(value: boolean): Promise<SystemUpdateState> {
    this.autoCheck = value;
    await this.setSetting(KEY_AUTO_CHECK, value ? 'true' : 'false');
    this.emit();
    return this.snapshot();
  }

  // ---- checking -------------------------------------------------------------------------------

  async checkNow(): Promise<SystemUpdateState> {
    if (!this.config.updateCheck) {
      throw new AppError(409, 'UPDATE_DISABLED', 'Update checks are turned off in the configuration (UPDATE_CHECK=false).');
    }
    if (isBusy(this.phase)) throw new AppError(409, 'UPDATE_BUSY', 'An update is currently running. A new check is possible afterwards.');
    await this.runCheck('manual');
    return this.snapshot();
  }

  private runCheck(trigger: 'manual' | 'auto'): Promise<void> {
    if (this.checking !== null) return this.checking;
    const run = (async () => {
      try {
        const releases = await fetchReleases(this.apiBase, this.config.updateRepo, this.http);
        const latest = pickLatest(releases, this.config.updateChannel);
        this.check = { at: this.now(), error: null, release: latest };
        this.logger.info({ latest: latest?.version ?? null, current: this.options.currentVersion, trigger }, 'Update check finished');
      } catch (error) {
        const failure = errorMsg(error, msg('UPDATE_CHECK_FAILED_GENERIC'));
        const message = failure.text;
        this.check = { at: this.now(), error: message, errorRef: failure.ref, release: this.check.release };
        this.logger.warn({ err: error, trigger }, 'Update check failed');
        await this.persistCheck();
        throw error instanceof AppError ? error : new AppError(502, 'UPDATE_CHECK_FAILED', message);
      }
      await this.persistCheck();
    })();
    const tracked = run.finally(() => {
      this.checking = null;
      this.emit();
    });
    this.checking = tracked.catch(() => undefined);
    this.emit();
    return trigger === 'manual' ? tracked : this.checking;
  }

  private async persistCheck(): Promise<void> {
    try {
      await this.setSetting(KEY_CHECK, JSON.stringify(this.check));
    } catch (error) {
      this.logger.warn({ err: error }, 'The result of the update check could not be saved');
    }
  }

  // ---- applying -------------------------------------------------------------------------------

  async apply(input: { confirm: boolean; countdownSeconds?: number }): Promise<SystemUpdateState> {
    if (!input.confirm) {
      throw new AppError(422, 'UPDATE_CONFIRM_REQUIRED', 'The update must be explicitly confirmed: all running Minecraft servers will be stopped.');
    }
    const reason = this.applyBlockReason();
    const release = this.latestRelease;
    const files = this.filesLookup();
    if (reason !== null || release === null || files === null || !files.ok) {
      throw new AppError(409, 'UPDATE_NOT_POSSIBLE', reason === null ? 'No update is available.' : textOf(reason), undefined, reason === null ? undefined : refOf(reason) === null ? undefined : { reason: refOf(reason) as MessageRef });
    }
    const blocker = await this.options.preflight?.();
    if (blocker !== null && blocker !== undefined) throw new AppError(409, 'UPDATE_BLOCKED', blocker.text, undefined, { reason: blocker.ref });
    const countdown = Math.min(600, Math.max(0, Math.round(input.countdownSeconds ?? this.config.updateCountdownSeconds)));

    this.move('start');
    this.error = null;
    this.cancelRequested = false;
    this.stopping = false;
    this.abort = new AbortController();
    const job: Job = { id: randomUUID(), fromVersion: this.options.currentVersion, toVersion: release.version, startedAt: this.now(), serverIds: [], step: 'prepared' };
    this.job = job;
    this.setProgress(msg('UPDATE_PROGRESS_DOWNLOADING', { version: release.version }), 0);
    this.running = this.run(job, release, files.files, countdown).catch((error: unknown) => this.logger.error({ err: error }, 'Update aborted unexpectedly'));
    return this.snapshot();
  }

  async cancel(): Promise<SystemUpdateState> {
    if (this.phase === 'downloading' || this.phase === 'verifying' || (this.phase === 'waiting-for-servers' && !this.stopping)) {
      this.cancelRequested = true;
      this.abort?.abort();
      return this.snapshot();
    }
    throw new AppError(409, 'UPDATE_NOT_CANCELABLE', 'The update can no longer be cancelled at this step.');
  }

  dismiss(): SystemUpdateState {
    if (this.phase === 'done' || this.phase === 'failed') {
      this.move('dismiss');
      this.error = null;
      this.progress = null;
      this.emit();
    }
    return this.snapshot();
  }

  private throwIfCancelled(): void {
    if (this.cancelRequested) throw new AppError(499, 'UPDATE_CANCELLED', 'The update was cancelled.');
  }

  private async run(job: Job, release: Release, files: { asset: { name: string; size: number; url: string }; sums: { url: string }; signature: { url: string } }, countdown: number): Promise<void> {
    const dir = path.join(this.config.dataDir, 'updates', job.id);
    const signal = this.abort?.signal;
    const http: UpdateHttpOptions = { ...this.http, ...(signal === undefined ? {} : { signal }) };
    try {
      await mkdir(dir, { recursive: true });
      // 1. download, nothing is disturbed yet
      let lastPercent = -1;
      const downloaded = await downloadFile(files.asset.url, path.join(dir, files.asset.name), {
        ...http,
        maxBytes: MAX_ASSET_BYTES,
        expectedSize: files.asset.size,
        onProgress: (received, total) => {
          const percent = total === null || total === 0 ? null : Math.floor((received / total) * 100);
          const nowMs = this.now();
          if (percent !== lastPercent && nowMs - this.lastProgressEmit >= 250) {
            lastPercent = percent ?? -1;
            this.lastProgressEmit = nowMs;
            this.setProgress(msg('UPDATE_PROGRESS_DOWNLOADING', { version: release.version }), percent);
          }
        },
      });
      this.throwIfCancelled();
      const sums = await fetchSmallBuffer(files.sums.url, http, MAX_SUMS_BYTES);
      const signature = await fetchSmallBuffer(files.signature.url, http, MAX_SIGNATURE_BYTES);
      await writeFile(path.join(dir, SUMS_NAME), sums);
      await writeFile(path.join(dir, SIGNATURE_NAME), signature);
      this.move('downloaded');
      this.setProgress(msg('UPDATE_PROGRESS_VERIFYING'));

      // 2. signature, then hash
      this.throwIfCancelled();
      verifyRelease({ sums, signature: signature.toString('utf8'), keys: this.keys, assetName: files.asset.name, assetSha256: downloaded.sha256 });
      this.move('verified');

      // 3. warn players, stop servers cleanly
      await this.warnAndStop(job, countdown);

      // 4. hand over to the privileged updater
      await this.handOver(job, dir, files.asset.name);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await this.awaitUpdater(job);
    } catch (error) {
      await this.handleFailure(job, error, dir);
    }
  }

  private runningServerIds(): string[] {
    return this.options.manager.activeServerIds();
  }

  private async announce(message: string): Promise<void> {
    for (const { serverId, status } of this.options.manager.statuses()) {
      if (status.state !== 'online' && status.state !== 'starting') continue;
      try {
        await this.options.manager.sendCommand(serverId, `say [WorldFoundry] ${message}`);
      } catch {
        // a server that just went away needs no warning
      }
    }
  }

  private async warnAndStop(job: Job, countdown: number): Promise<void> {
    const initial = this.runningServerIds();
    if (initial.length === 0) {
      this.setProgress(msg('UPDATE_PROGRESS_NO_SERVERS'));
    } else if (countdown > 0) {
      for (let remaining = countdown; remaining > 0; remaining--) {
        this.throwIfCancelled();
        this.setProgress(msg('UPDATE_PROGRESS_COUNTDOWN', { seconds: remaining }), null, remaining);
        if (remaining === countdown || COUNTDOWN_MARKS.includes(remaining)) {
          await this.announce(`Software update: the server will be stopped in ${remaining} seconds and will start again automatically afterwards.`);
        }
        await this.sleep(this.timings.tickMs);
      }
      this.throwIfCancelled();
    }
    // the point of no return: from here on the update cannot be cancelled
    this.stopping = true;
    const ids = this.runningServerIds();
    job.serverIds = ids;
    job.step = 'stopping';
    await this.setSetting(KEY_JOB, JSON.stringify(job));
    if (ids.length > 0) {
      await this.announce('The server is being stopped now.');
      this.setProgress(msg('UPDATE_PROGRESS_STOPPING', { count: ids.length }));
      for (const id of ids) {
        try {
          await this.options.manager.stop(id);
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'SERVER_NOT_RUNNING')) throw error;
        }
      }
      const deadline = this.now() + this.timings.stopWaitMs;
      while (this.runningServerIds().length > 0) {
        if (this.now() > deadline) throw new AppError(504, 'UPDATE_STOP_TIMEOUT', 'Not all servers could be stopped in time. The update was not applied.');
        await this.sleep(Math.min(500, this.timings.tickMs));
      }
    }
    this.move('servers-stopped');
  }

  // Best effort copy of the database before a new version migrates it; a rollback restores the old program, not the data.
  private async snapshotDatabase(): Promise<void> {
    const file = path.join(this.config.dataDir, 'updates', 'db-before-update.db');
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await rm(file, { force: true });
      await this.db.run(sql`VACUUM INTO ${file}`);
    } catch (error) {
      this.logger.warn({ err: error }, 'Backing up the database before the update was not possible');
    }
  }

  private async handOver(job: Job, dir: string, assetName: string): Promise<void> {
    const updateDir = this.config.updateDir;
    if (updateDir === undefined) throw new AppError(409, 'UPDATE_NOT_POSSIBLE', 'The update service is not set up.');
    this.setProgress(msg('UPDATE_PROGRESS_DB_BACKUP'));
    await this.snapshotDatabase();
    const request = { ...newRequest(job.toVersion, job.fromVersion, assetName, this.now()), id: job.id };
    job.step = 'handed-over';
    await this.setSetting(KEY_JOB, JSON.stringify(job));
    this.setProgress(msg('UPDATE_PROGRESS_HANDOVER'));
    await submitRequest(requestDirOf(updateDir), request, {
      asset: path.join(dir, assetName),
      sums: path.join(dir, SUMS_NAME),
      signature: path.join(dir, SIGNATURE_NAME),
    });
    this.move('handed-over');
  }

  // Polls the status file of the updater. Usually this process is stopped by the installation before it ends.
  private async awaitUpdater(job: Job): Promise<void> {
    const updateDir = this.config.updateDir as string;
    const started = this.now();
    let seen = false;
    for (;;) {
      if (this.stopped) return;
      const status = await readStatus(updateDir);
      if (status !== null && status.id === job.id) {
        seen = true;
        if (status.state === 'failed' || status.state === 'rolled-back') {
          throw new UpdaterFailure(status);
        }
        if (status.state === 'done') {
          throw new AppError(500, 'UPDATE_NOT_APPLIED', 'The update service reports success, but WorldFoundry is still running the old version.');
        }
        if ((status.state === 'installing' || status.state === 'health-check') && this.phase === 'installing') {
          this.move('restarting');
          this.setProgress(msg('UPDATE_PROGRESS_RESTARTING'));
        } else if (this.phase === 'installing') {
          this.setProgress(status.message || msg('UPDATE_PROGRESS_CHECKING_PACKAGE'));
        }
      }
      const elapsed = this.now() - started;
      if (!seen && elapsed > this.timings.pickupTimeoutMs) {
        throw new AppError(504, 'UPDATE_NO_UPDATER', 'The update service did not accept the request. Is the "worldfoundry-update" / "worldfoundry-updater" service active?');
      }
      if (elapsed > this.timings.installTimeoutMs) {
        throw new AppError(504, 'UPDATE_TIMEOUT', 'The update was not finished in time.');
      }
      await this.sleep(this.timings.statusPollMs);
    }
  }

  private async handleFailure(job: Job, error: unknown, dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (this.config.updateDir !== undefined) await clearRequestDir(requestDirOf(this.config.updateDir)).catch(() => undefined);
    if (error instanceof AppError && error.code === 'UPDATE_CANCELLED') {
      this.move('cancelled');
      this.progress = null;
      this.job = null;
      await this.setSetting(KEY_JOB, null);
      await this.addHistory(job, 'cancelled', msg('UPDATE_CANCELLED_BY_ADMIN'));
      await this.announce('The software update was cancelled.');
      this.emit();
      return;
    }
    if (error instanceof AppError && error.code === 'UPDATE_ABORTED' && this.cancelRequested) {
      await this.handleFailure(job, new AppError(499, 'UPDATE_CANCELLED', 'The update was cancelled.'), dir);
      return;
    }
    let message: Text;
    let result: SelfUpdateResult = 'failed';
    if (error instanceof UpdaterFailure) {
      message = error.status.message || msg('UPDATE_REJECTED_BY_UPDATER');
      if (error.status.state === 'rolled-back') result = 'rolled_back';
    } else {
      if (!(error instanceof AppError)) this.logger.error({ err: error }, 'Update failed');
      message = errorMsg(error, msg('UPDATE_FAILED_UNEXPECTED'));
    }
    await this.finish(job, result, message);
  }

  // Writes the history, clears the persisted job, brings the stopped servers back
  private async finish(job: Job, result: SelfUpdateResult, message: Text | null): Promise<void> {
    this.logger.info({ result, message: message === null ? null : textOf(message), from: job.fromVersion, to: job.toVersion }, 'Update finished');
    try {
      await this.addHistory(job, result, message);
    } catch (error) {
      this.logger.error({ err: error }, 'The update history could not be saved');
    }
    this.job = null;
    await this.setSetting(KEY_JOB, null).catch(() => undefined);
    const ok = result === 'success';
    this.error = ok ? null : message;
    this.progress = null;
    if (isBusy(this.phase)) this.move(ok ? 'succeeded' : 'failed');
    this.emit();
    await this.restartServers(job.serverIds);
    this.emit();
  }

  private async restartServers(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    this.bypassGuard = true;
    try {
      for (const id of ids) {
        try {
          const result = await this.options.manager.start(id);
          if (result.status.state === 'preparing') await this.options.manager.waitWhilePreparing(id);
        } catch (error) {
          if (error instanceof AppError && error.code === 'SERVER_ALREADY_RUNNING') continue;
          const reason = errorMsg(error, msg('START_UNEXPECTED_ERROR'));
          this.logger.error({ err: error, serverId: id }, `Restart after the update failed: ${reason.text}`);
          this.options.manager.markStartFailed(id, msg('START_AFTER_UPDATE_FAILED', { reason }));
        }
      }
    } finally {
      this.bypassGuard = false;
    }
  }

  // ---- after a restart ------------------------------------------------------------------------

  // Decides how an update that was running when the application went down ended, from the version that runs now
  // and the report of the updater.
  private async recover(): Promise<void> {
    const job = this.job;
    if (job === null) return;
    this.phase = 'restarting';
    this.setProgress(msg('UPDATE_PROGRESS_FINISHING'));
    const updateDir = this.config.updateDir;
    const current = this.options.currentVersion;
    let status: UpdaterStatus | null = null;
    if (job.step === 'handed-over' && updateDir !== undefined) {
      const deadline = this.now() + this.timings.installTimeoutMs;
      for (;;) {
        status = await readStatus(updateDir);
        if (status !== null && status.id !== job.id) status = null;
        // a running updater may still roll back: wait for its verdict while the old version is what runs here
        if (current === job.toVersion || (status !== null && isTerminalState(status.state)) || this.now() > deadline || this.stopped) break;
        if (status === null && this.now() - job.startedAt > this.timings.installTimeoutMs) break;
        await this.sleep(this.timings.statusPollMs);
      }
    }
    if (this.stopped) return;
    if (current === job.toVersion) {
      await this.finish(job, 'success', msg('UPDATE_SUCCESS', { version: current }));
    } else if (status !== null && status.state === 'rolled-back') {
      await this.finish(job, 'rolled_back', status.message || msg('UPDATE_ROLLED_BACK_DEFAULT'));
    } else if (status !== null && status.state === 'failed') {
      await this.finish(job, 'failed', status.message || msg('UPDATE_FAILED_DEFAULT'));
    } else {
      await this.finish(job, 'failed', msg(job.step === 'handed-over' ? 'UPDATE_NO_REPORT' : 'UPDATE_INTERRUPTED_BEFORE_HANDOVER'));
    }
  }

  private async cleanupUpdatesDir(): Promise<void> {
    const base = path.join(this.config.dataDir, 'updates');
    try {
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === this.job?.id) continue;
        const info = await stat(path.join(base, entry.name));
        if (this.now() - info.mtimeMs > 6 * HOUR) await rm(path.join(base, entry.name), { recursive: true, force: true });
      }
    } catch {
      // no updates folder yet
    }
  }

  get mode(): InstallMode {
    return this.modeInfo.mode;
  }
}

class UpdaterFailure extends Error {
  constructor(readonly status: UpdaterStatus) {
    super(status.message);
    this.name = 'UpdaterFailure';
  }
}
