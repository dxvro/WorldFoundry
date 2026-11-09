import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { extractTarGz } from '../archive/tar.js';
import { extractZip } from '../archive/zip.js';
import type { AppEvent } from '../events/bus.js';
import { AppError, errorMsg } from '../http/errors.js';
import { msg, type MessageRef, type Msg } from '../messages.js';
import { assertFreeSpace, freeBytes, type FreeSpaceReader } from '../lib/disk.js';
import { renameWithRetry } from '../lib/fs-retry.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { downloadToTmp } from '../mods/downloader.js';
import { rethrowFsError } from '../mods/fs-errors.js';
import { ADOPTIUM_DOWNLOAD_HOSTS, AdoptiumApi, temurinTarget, type ImageType, type TemurinAsset } from './adoptium.js';
import { javaExecutable, probeJava, type JavaProbe } from './detect.js';
import { parseJavaVersion } from './parse.js';
import type { JavaRuntime } from './select.js';

export const MARKER_FILE = '.worldfoundry-runtime.json';
const TMP_PREFIX = '.tmp-';
const TRASH_PREFIX = '.removing-';
const MAX_EXTRACTED_BYTES = 3 * 1024 ** 3;
const MAX_ENTRIES = 100_000;
const PROGRESS_INTERVAL_MS = 250;

export type JavaInstallPhase = 'metadata' | 'download' | 'verify' | 'extract' | 'check' | 'finish';

export interface JavaInstallProgress {
  phase: JavaInstallPhase;
  percent: number | null;
  message: string;
  ref?: MessageRef;
}

export type ProgressListener = (progress: JavaInstallProgress) => void;
export type JavaInstallEvent = Extract<AppEvent, { type: 'java.install' }>;

const MarkerSchema = z.object({
  schema: z.literal(1),
  major: z.number().int().positive(),
  version: z.string().min(1),
  release: z.string().min(1),
  image: z.enum(['jre', 'jdk']),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.string().min(1),
  installedAt: z.number(),
  sizeBytes: z.number().int().nonnegative(),
  javaRelPath: z.string().min(1),
});

export interface ManagedRuntimeInfo {
  major: number;
  version: string;
  release: string;
  image: ImageType;
  sha256: string;
  url: string;
  installedAt: number;
  sizeBytes: number;
  javaPath: string;
  dir: string;
}

export interface ManagedRuntimesOptions {
  dir: string;
  fetch: typeof fetch;
  userAgent: string;
  lock: KeyedLock;
  platform?: NodeJS.Platform;
  arch?: string;
  probe?: JavaProbe;
  api?: AdoptiumApi;
  downloadTimeoutMs?: number;
  freeSpace?: FreeSpaceReader;
  logger?: Logger;
  now?: () => number;
}

interface Job {
  major: number;
  controller: AbortController;
  promise: Promise<ManagedRuntimeInfo>;
  waiters: number;
  listeners: Set<ProgressListener>;
  last: JavaInstallProgress | null;
}

export interface EnsureOptions {
  signal?: AbortSignal;
  onProgress?: ProgressListener;
}

export const abortedError = (): AppError => new AppError(409, 'JAVA_INSTALL_ABORTED', 'The Java installation was cancelled.');

const isFile = (file: string): Promise<boolean> =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  );

export function describeOriginMsg(info: Pick<ManagedRuntimeInfo, 'version' | 'image' | 'sha256' | 'installedAt'>): Msg {
  return msg('JAVA_ORIGIN_MANAGED', {
    date: new Date(info.installedAt).toISOString().slice(0, 10),
    version: info.version,
    image: info.image === 'jre' ? 'JRE' : 'JDK',
    sha: info.sha256.slice(0, 16),
  });
}

export const describeOrigin = (info: Pick<ManagedRuntimeInfo, 'version' | 'image' | 'sha256' | 'installedAt'>): string => describeOriginMsg(info).text;

// progress in the wire format of the events: the text plus its reference
const progressOf = (phase: JavaInstallPhase, percent: number | null, message: Msg): JavaInstallProgress => ({ phase, percent, message: message.text, ref: message.ref });

export class ManagedRuntimes {
  private readonly jobs = new Map<number, Job>();
  private readonly api: AdoptiumApi;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly probe: JavaProbe;
  private readonly logger: Logger;
  private readonly freeSpace: FreeSpaceReader;
  private readonly now: () => number;
  private readonly shutdownController = new AbortController();
  private readonly listeners = new Set<(event: JavaInstallEvent) => void>();

  constructor(private readonly options: ManagedRuntimesOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.probe = options.probe ?? probeJava;
    this.logger = options.logger ?? silentLogger;
    this.freeSpace = options.freeSpace ?? freeBytes;
    this.now = options.now ?? Date.now;
    this.api = options.api ?? new AdoptiumApi({ fetch: options.fetch, userAgent: options.userAgent });
  }

  onEvent(listener: (event: JavaInstallEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(event: JavaInstallEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({ err: error }, 'A listener of the Java installation failed');
      }
    }
  }

  get dir(): string {
    return this.options.dir;
  }

  private dirOf(major: number): string {
    return path.join(this.options.dir, `temurin-${major}`);
  }

  // ---- queries -----------------------------------------------------------------------------

  async read(major: number): Promise<ManagedRuntimeInfo | null> {
    const dir = this.dirOf(major);
    let marker: z.infer<typeof MarkerSchema>;
    try {
      marker = MarkerSchema.parse(JSON.parse(await readFile(path.join(dir, MARKER_FILE), 'utf8')));
    } catch {
      return null;
    }
    const javaPath = path.join(dir, ...marker.javaRelPath.split('/'), 'bin', javaExecutable(this.platform));
    if (marker.major !== major || !(await isFile(javaPath))) return null;
    return { ...marker, javaPath, dir };
  }

  async list(): Promise<ManagedRuntimeInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.options.dir);
    } catch {
      return [];
    }
    const found: ManagedRuntimeInfo[] = [];
    for (const name of names) {
      const major = /^temurin-(\d+)$/.exec(name)?.[1];
      if (major === undefined) continue;
      const info = await this.read(Number(major));
      if (info !== null) found.push(info);
    }
    return found.sort((a, b) => a.major - b.major);
  }

  async sources(): Promise<Array<{ javaPath: string; origin: string; originRef: MessageRef }>> {
    return (await this.list()).map((info) => ({ javaPath: info.javaPath, origin: describeOrigin(info), originRef: describeOriginMsg(info).ref }));
  }

  toRuntime(info: ManagedRuntimeInfo): JavaRuntime {
    return {
      path: info.javaPath,
      major: info.major,
      version: info.version,
      name: `Eclipse Temurin ${info.version} (${info.image === 'jre' ? 'JRE' : 'JDK'})`,
      source: 'managed',
      origin: describeOrigin(info),
      originRef: describeOriginMsg(info).ref,
    };
  }

  activeInstalls(): Array<{ major: number; progress: JavaInstallProgress | null }> {
    return [...this.jobs.values()].map((job) => ({ major: job.major, progress: job.last }));
  }

  isInstalling(major: number): boolean {
    return this.jobs.has(major);
  }

  // ---- maintenance -------------------------------------------------------------------------

  // Run at boot: whatever an interrupted install or removal left behind is deleted; nothing in the
  // runtimes folder is usable unless it carries a valid marker.
  async cleanup(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.options.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const stale = name.startsWith(TMP_PREFIX) || name.startsWith(TRASH_PREFIX);
      const broken = /^temurin-\d+$/.test(name) && (await this.read(Number(name.slice('temurin-'.length)))) === null;
      if (!stale && !broken) continue;
      try {
        await rm(path.join(this.options.dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed++;
      } catch (error) {
        this.logger.warn({ err: error, name }, 'Incomplete Java runtime could not be removed');
      }
    }
    return removed;
  }

  shutdown(): void {
    this.shutdownController.abort();
  }

  async remove(major: number): Promise<void> {
    await this.options.lock.run(`java:${major}`, async () => {
      if (this.jobs.has(major)) {
        throw new AppError(409, 'JAVA_INSTALL_RUNNING', `Java ${major} is currently being installed and cannot be removed.`, undefined, { major });
      }
      const dir = this.dirOf(major);
      if ((await stat(dir).catch(() => null)) === null) {
        throw new AppError(404, 'JAVA_RUNTIME_NOT_FOUND', `There is no Java runtime ${major} installed by WorldFoundry.`, undefined, { major });
      }
      const trash = path.join(this.options.dir, `${TRASH_PREFIX}${major}-${randomUUID()}`);
      try {
        await renameWithRetry(dir, trash);
        await rm(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        rethrowFsError(error, `temurin-${major}`);
      }
    });
  }

  // ---- installation ------------------------------------------------------------------------

  // One download per major: later callers join the running job and receive its progress. The job only
  // stops when every caller has given up (or the application shuts down).
  ensure(major: number, options: EnsureOptions = {}): Promise<ManagedRuntimeInfo> {
    // a job that is already being aborted (its last caller left) is not joined; a fresh one takes its place
    const running = this.jobs.get(major);
    const job = running === undefined || running.controller.signal.aborted ? this.startJob(major) : running;
    job.waiters++;
    if (options.onProgress !== undefined) {
      job.listeners.add(options.onProgress);
      if (job.last !== null) options.onProgress(job.last);
    }
    return new Promise<ManagedRuntimeInfo>((resolve, reject) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        if (options.onProgress !== undefined) job.listeners.delete(options.onProgress);
        job.waiters--;
        if (job.waiters === 0) job.controller.abort();
      };
      const { signal } = options;
      const onAbort = (): void => {
        release();
        reject(abortedError());
      };
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      job.promise.then(
        (info) => {
          signal?.removeEventListener('abort', onAbort);
          released = true;
          resolve(info);
        },
        (error: unknown) => {
          signal?.removeEventListener('abort', onAbort);
          released = true;
          reject(error);
        },
      );
    });
  }

  private startJob(major: number): Job {
    const controller = new AbortController();
    this.shutdownController.signal.addEventListener('abort', () => controller.abort(), { once: true });
    let lastEmit = 0;
    const job: Job = {
      major,
      controller,
      promise: Promise.resolve(null as never),
      waiters: 0,
      listeners: new Set(),
      last: null,
    };
    const report = (progress: JavaInstallProgress): void => {
      const previous = job.last;
      const now = this.now();
      const quiet = previous !== null && previous.phase === progress.phase && now - lastEmit < PROGRESS_INTERVAL_MS && progress.percent !== 100;
      job.last = progress;
      if (quiet) return;
      lastEmit = now;
      for (const listener of [...job.listeners]) listener(progress);
      this.publish({ type: 'java.install', major, state: 'running', phase: progress.phase, percent: progress.percent, message: progress.message, messageRef: progress.ref ?? null, error: null, errorRef: null });
    };
    job.promise = this.run(major, controller.signal, report)
      .then(
        (info) => {
          const done = msg('JAVA_INSTALLED', { major });
          this.publish({ type: 'java.install', major, state: 'done', phase: 'finish', percent: 100, message: done.text, messageRef: done.ref, error: null, errorRef: null });
          return info;
        },
        (error: unknown) => {
          const failure = controller.signal.aborted ? abortedError() : error;
          const failed = errorMsg(failure, msg('JAVA_INSTALL_FAILED', { major }));
          if (!(failure instanceof AppError)) this.logger.error({ err: error, major }, 'Java installation failed');
          this.publish({ type: 'java.install', major, state: 'failed', phase: job.last?.phase ?? 'metadata', percent: null, message: failed.text, messageRef: failed.ref, error: failed.text, errorRef: failed.ref });
          throw failure;
        },
      )
      .finally(() => {
        if (this.jobs.get(major) === job) this.jobs.delete(major);
      });
    job.promise.catch(() => undefined);
    this.jobs.set(major, job);
    return job;
  }

  private async findHome(extractDir: string): Promise<{ top: string; homeRel: string }> {
    const exe = javaExecutable(this.platform);
    const entries = await readdir(extractDir, { withFileTypes: true });
    const tops = [...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(extractDir, entry.name)), extractDir];
    for (const top of tops) {
      for (const homeRel of this.platform === 'darwin' ? ['Contents/Home', ''] : ['']) {
        if (await isFile(path.join(top, ...homeRel.split('/').filter(Boolean), 'bin', exe))) return { top, homeRel: homeRel === '' ? '.' : homeRel };
      }
    }
    throw new AppError(502, 'JAVA_INSTALL_INVALID', 'The downloaded archive does not contain a Java installation.');
  }

  private async run(major: number, signal: AbortSignal, report: (progress: JavaInstallProgress) => void): Promise<ManagedRuntimeInfo> {
    const existing = await this.read(major);
    if (existing !== null) return existing;
    const target = temurinTarget(this.platform, this.arch);
    report(progressOf('metadata', 1, msg('JAVA_STEP_METADATA', { major })));
    // a JRE image is enough for every loader and installer we run and is about a quarter of the JDK's size
    const asset: TemurinAsset | null = (await this.api.latest(major, target, 'jre', signal)) ?? (await this.api.latest(major, target, 'jdk', signal));
    if (asset === null) {
      throw new AppError(
        422,
        'JAVA_NOT_AVAILABLE',
        `Eclipse Temurin does not offer Java ${major} for ${target.label}. Please install Java ${major} manually and enter the path in the server settings.`,
        { major, platform: target.label },
      );
    }
    signal.throwIfAborted();
    await mkdir(this.options.dir, { recursive: true });
    await assertFreeSpace(this.freeSpace, this.options.dir, asset.size * 4, 'java', major);

    const staging = path.join(this.options.dir, `${TMP_PREFIX}${major}-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      const archive = await downloadToTmp(
        {
          url: asset.url,
          fileName: asset.fileName,
          hash: { algorithm: 'sha256', value: asset.sha256 },
          size: asset.size,
          allowedHosts: ADOPTIUM_DOWNLOAD_HOSTS,
          fileKind: 'archive',
          onProgress: (received, total) => {
            const fraction = total === null || total === 0 ? 0 : Math.min(1, received / total);
            const mb = (value: number): string => (value / (1024 * 1024)).toLocaleString('en-US', { maximumFractionDigits: 0 });
            report(progressOf('download', Math.round(3 + fraction * 60), msg('JAVA_STEP_DOWNLOAD', { major, receivedMb: mb(received), totalMb: total === null ? '?' : mb(total) })));
          },
        },
        staging,
        {
          fetch: this.options.fetch,
          allowedHosts: ADOPTIUM_DOWNLOAD_HOSTS,
          timeoutMs: this.options.downloadTimeoutMs ?? 10 * 60_000,
          headers: { 'User-Agent': this.options.userAgent },
          signal,
        },
      );
      report(progressOf('verify', 64, msg('JAVA_STEP_VERIFY', { major })));

      const extractDir = path.join(staging, 'extract');
      const estimate = Math.max(asset.size * 2, 1);
      const limits = {
        maxBytes: MAX_EXTRACTED_BYTES,
        maxEntries: MAX_ENTRIES,
        platform: this.platform,
        allowSymlinks: true,
        checkpoint: () => signal.throwIfAborted(),
        onProgress: (bytes: number) =>
          report(progressOf('extract', Math.round(65 + Math.min(1, bytes / estimate) * 30), msg('JAVA_STEP_EXTRACT', { major }))),
      };
      const extracted = await (target.archive === 'zip' ? extractZip(archive, extractDir, limits) : extractTarGz(archive, extractDir, limits));

      report(progressOf('check', 96, msg('JAVA_STEP_CHECK', { major })));
      const { top, homeRel } = await this.findHome(extractDir);
      const javaFile = path.join(top, ...homeRel.split('/').filter((part) => part !== '.'), 'bin', javaExecutable(this.platform));
      const output = await this.probe(javaFile);
      const parsed = output === null ? null : parseJavaVersion(output);
      if (parsed === null || parsed.major !== major) {
        throw new AppError(
          502,
          'JAVA_INSTALL_INVALID',
          parsed === null
            ? `The downloaded Java runtime does not respond to "java -version".`
            : `The downloaded Java runtime reports version ${parsed.major} instead of ${major}.`,
          undefined,
          { major, ...(parsed === null ? {} : { found: parsed.major }) },
        );
      }
      signal.throwIfAborted();
      const marker: z.infer<typeof MarkerSchema> = {
        schema: 1,
        major,
        version: asset.version,
        release: asset.release,
        image: asset.image,
        sha256: asset.sha256,
        url: asset.url,
        installedAt: this.now(),
        sizeBytes: extracted.bytes,
        javaRelPath: homeRel,
      };
      await writeFile(path.join(top, MARKER_FILE), JSON.stringify(marker, null, 2), 'utf8');

      await this.options.lock.run(`java:${major}`, async () => {
        const finalDir = this.dirOf(major);
        await rm(finalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        await renameWithRetry(top, finalDir);
      });
      report(progressOf('finish', 100, msg('JAVA_INSTALLED', { major })));
      const installed = await this.read(major);
      if (installed === null) throw new AppError(500, 'JAVA_INSTALL_INVALID', `Java ${major} was installed but is not readable.`, undefined, { major });
      return installed;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC') throw new AppError(507, 'DISK_FULL', 'There is not enough free disk space.');
      return rethrowFsError(error, `temurin-${major}`);
    } finally {
      await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    }
  }
}
