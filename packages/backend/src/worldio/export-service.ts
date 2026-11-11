import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractTarGz, writeTarGz, type TarSource } from '../archive/tar.js';
import { writeZip } from '../archive/zip-writer.js';
import { collectLayout, collectSources, hasLayoutData, readLevelName, type BackupLayout, type Collected } from '../backups/world.js';
import { DEFAULT_SAVE_TIMINGS, SaveSession, type SaveTimings } from '../backups/save.js';
import type { BackupService } from '../backups/service.js';
import type { Db } from '../db/client.js';
import { mods as modsTable, servers, type Server } from '../db/schema.js';
import { AppError, errorMsg } from '../http/errors.js';
import { msg, type Msg } from '../messages.js';
import { getLoaderProfile } from '../mods/profile.js';
import { assertFreeSpace, freeBytes, WORLD_COMPRESSION_ESTIMATE, type FreeSpaceReader } from '../lib/disk.js';
import { renameWithRetry } from '../lib/fs-retry.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { listModFiles, mapLimit } from '../mods/files.js';
import type { ProcessManager } from '../process/manager.js';
import type { ExportFormat, ExportJobDto, ExportOptionsDto } from './dto.js';
import { styleForLoader } from './layout.js';
import { parseLevelDat } from './level-dat.js';
import { EXPORT_MANIFEST_FORMAT, EXPORT_MANIFEST_NAME, serializeManifest, type ExportManifest, type ManifestMod } from './manifest.js';
import { hashFileBoth, readJarMeta, type JarMeta } from './mod-meta.js';
import { GAME_EXPORT_MANIFEST_NAME, gameExportManifest } from './game-world.js';

const MIB = 1024 * 1024;
const COMPRESSION_ESTIMATE = WORLD_COMPRESSION_ESTIMATE;
const TTL_MS = 30 * 60_000;
const SWEEP_MS = 60_000;
const BUSY_STATES: ReadonlySet<string> = new Set(['preparing', 'starting', 'stopping']);

export interface ExportServiceOptions {
  db: Db;
  serversDir: string;
  tmpDir: string;
  lock: KeyedLock;
  manager: ProcessManager;
  backups: BackupService;
  version: string;
  logger?: Logger;
  freeSpace?: FreeSpaceReader;
  saveTimings?: SaveTimings;
  now?: () => number;
  // the folders of a server's world per game (games other than Minecraft); Minecraft only when absent (tests)
  layoutOf?: (server: Server, serverDir: string) => Promise<BackupLayout>;
}

interface Job {
  dto: ExportJobDto;
  file: string | null;
}

const asciiName = (text: string): string => {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug === '' ? 'server' : slug;
};

const dateStamp = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const OPTIONS_DEFAULT: ExportOptionsDto = { format: 'zip', mods: 'none', includeConfig: false };

export class ExportService {
  private readonly jobs = new Map<string, Job>();
  private readonly logger: Logger;
  private readonly freeSpace: FreeSpaceReader;
  private readonly timings: SaveTimings;
  private readonly abort = new AbortController();
  private readonly running = new Map<string, Promise<void>>();
  private sweeper: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ExportServiceOptions) {
    this.logger = options.logger ?? silentLogger;
    this.freeSpace = options.freeSpace ?? freeBytes;
    this.timings = options.saveTimings ?? DEFAULT_SAVE_TIMINGS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.sweeper !== null) return;
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.abort.abort();
    if (this.sweeper !== null) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.race([Promise.allSettled([...this.running.values()]), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  // files of exports that were running or waiting for download when the application ended
  async recoverInterrupted(): Promise<void> {
    await rm(this.options.tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }

  // an export is being written right now (an update must wait for it)
  get busy(): boolean {
    return [...this.jobs.values()].some((job) => job.dto.status === 'running');
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    for (const [id, job] of [...this.jobs]) {
      if (job.dto.status === 'running') continue;
      const expires = job.dto.expiresAt ?? 0;
      if (expires <= now) await this.discard(id);
    }
  }

  private async discard(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    this.jobs.delete(id);
    if (job.file !== null) await rm(job.file, { force: true }).catch(() => undefined);
  }

  get(id: string): ExportJobDto {
    const job = this.jobs.get(id);
    if (job === undefined) throw new AppError(404, 'EXPORT_NOT_FOUND', 'The export was not found or has expired.');
    return job.dto;
  }

  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    if (job.dto.status === 'running') throw new AppError(409, 'EXPORT_IN_PROGRESS', 'The export is still running.');
    await this.discard(id);
  }

  // validated lookup for the download route
  async locate(id: string): Promise<{ file: string; size: number; fileName: string; format: ExportFormat }> {
    const job = this.jobs.get(id);
    if (job === undefined) throw new AppError(404, 'EXPORT_NOT_FOUND', 'The export was not found or has expired.');
    if (job.dto.status !== 'ready' || job.file === null) throw new AppError(409, 'EXPORT_NOT_READY', 'The export is not finished yet.');
    const info = await lstat(job.file).catch(() => null);
    if (info === null || !info.isFile()) throw new AppError(404, 'EXPORT_NOT_FOUND', 'The export file is missing.');
    return { file: job.file, size: info.size, fileName: job.dto.fileName, format: job.dto.options.format };
  }

  openDownload(file: string): ReturnType<typeof createReadStream> {
    return createReadStream(file);
  }

  private async serverRow(serverId: string): Promise<Server> {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    return row;
  }

  private register(server: Server, source: 'server' | 'backup', options: ExportOptionsDto): Job {
    if (this.abort.signal.aborted) throw new AppError(503, 'SHUTTING_DOWN', 'The application is shutting down.');
    for (const job of this.jobs.values()) {
      if (job.dto.serverId === server.id && job.dto.status === 'running') {
        throw new AppError(409, 'EXPORT_IN_PROGRESS', 'An export is already running for this server.');
      }
    }
    const id = randomUUID();
    const created = this.now();
    const extension = options.format === 'zip' ? 'zip' : 'tar.gz';
    const job: Job = {
      file: null,
      dto: {
        id,
        serverId: server.id,
        source,
        status: 'running',
        options,
        fileName: `${asciiName(server.name)}-world-${dateStamp(created)}.${extension}`,
        sizeBytes: null,
        error: null,
        errorRef: null,
        warnings: [],
        warningRefs: [],
        createdAt: created,
        expiresAt: null,
      },
    };
    this.jobs.set(id, job);
    return job;
  }

  private launch(job: Job, work: () => Promise<void>): void {
    const promise = work()
      .then(
        () => undefined,
        (error: unknown) => {
          const failure = errorMsg(error, msg('EXPORT_UNEXPECTED'));
          if (!(error instanceof AppError)) this.logger.error({ err: error, serverId: job.dto.serverId }, 'Export failed');
          else this.logger.warn({ serverId: job.dto.serverId, code: error.code }, `Export failed: ${failure.text}`);
          job.dto.status = 'failed';
          job.dto.error = failure.text;
          job.dto.errorRef = failure.ref;
          job.dto.expiresAt = this.now() + TTL_MS;
          this.options.manager.announce(job.dto.serverId, msg('EXPORT_FAILED_REASON', { reason: failure }));
        },
      )
      .finally(() => {
        this.running.delete(job.dto.id);
      });
    this.running.set(job.dto.id, promise);
  }

  // ---- export of a server --------------------------------------------------------------------

  async startServerExport(serverId: string, options: ExportOptionsDto): Promise<ExportJobDto> {
    const server = await this.serverRow(serverId);
    if (server.game !== 'minecraft') return this.startGameExport(server, options);
    if (BUSY_STATES.has(this.options.manager.status(serverId).state)) {
      throw new AppError(409, 'EXPORT_SERVER_BUSY', 'The server is starting or stopping. Please wait until it is running or stopped.');
    }
    if (this.options.backups.isBusy(serverId)) {
      throw new AppError(409, 'BACKUP_IN_PROGRESS', 'A backup is currently running for this server. Please wait before the world is exported.');
    }
    const level = await readLevelName(path.join(this.options.serversDir, serverId));
    const effective: ExportOptionsDto = { ...options, mods: getLoaderProfile(server.loader) === null ? 'none' : options.mods };
    const dir = path.join(this.options.serversDir, serverId);
    if ((await lstat(path.join(dir, level)).catch(() => null)) === null) {
      throw new AppError(409, 'EXPORT_NOTHING', `There is no world data to export yet (folder "${level}" is missing). The server must have been started once.`, undefined, { levelName: level });
    }
    const job = this.register(server, 'server', effective);
    this.launch(job, () => this.options.lock.run(serverId, () => this.buildServerExport(job, server)));
    return job.dto;
  }

  private checkpoint(serverId: string, live: boolean): () => void {
    return () => {
      if (this.abort.signal.aborted) throw new AppError(503, 'SHUTTING_DOWN', 'The export was cancelled because the application is shutting down.');
      if (live && this.options.manager.status(serverId).state !== 'online') {
        throw new AppError(409, 'EXPORT_INTERRUPTED', 'The server was stopped during the export. The incomplete export was discarded.');
      }
    };
  }

  private async modEntries(server: Server, withJars: boolean): Promise<{ manifest: ManifestMod[]; sources: TarSource[] }> {
    const profile = getLoaderProfile(server.loader);
    if (profile === null) return { manifest: [], sources: [] };
    const dir = path.join(this.options.serversDir, server.id, profile.contentDir);
    const files = await listModFiles(dir);
    const rows = await this.options.db.select().from(modsTable).where(eq(modsTable.serverId, server.id));
    const bySha = new Map(rows.map((row) => [row.sha512, row]));
    const byName = new Map(rows.map((row) => [row.fileName, row]));
    const entries = await mapLimit(files, 4, async (file) => {
      const full = path.join(dir, file.diskName);
      const hashes = await hashFileBoth(full);
      let meta: JarMeta | null = null;
      try {
        meta = await readJarMeta(full);
      } catch {
        meta = null;
      }
      const row = bySha.get(hashes.sha512) ?? byName.get(file.fileName);
      const info = await stat(full);
      const entry: ManifestMod = {
        name: row?.name ?? meta?.name ?? meta?.modId ?? file.fileName.replace(/\.jar$/i, ''),
        fileName: file.fileName,
        enabled: file.enabled,
        sha1: hashes.sha1,
        sha512: hashes.sha512,
        sizeBytes: hashes.size,
        modId: meta?.modId ?? null,
        version: row?.versionNumber ?? meta?.version ?? null,
        projectId: row?.projectId ?? null,
        versionId: row?.versionId ?? null,
        source: row?.source === 'modrinth' && row.projectId !== null ? 'modrinth' : 'manual',
        side: meta?.side ?? 'unknown',
        dir: profile.contentDir,
        included: withJars,
      };
      const source: TarSource = { kind: 'file', name: `${profile.contentDir}/${file.diskName}`, file: full, size: info.size, mtimeMs: info.mtimeMs, mode: 0o644 };
      return { entry, source };
    });
    return { manifest: entries.map((item) => item.entry), sources: withJars ? entries.map((item) => item.source) : [] };
  }

  private manifestFor(server: Server, source: 'server' | 'backup', options: ExportOptionsDto, collected: Collected, level: string, dataVersion: number | null, mods: ManifestMod[]): ExportManifest {
    return {
      format: EXPORT_MANIFEST_FORMAT,
      kind: 'worldfoundry-world-export',
      appVersion: this.options.version,
      createdAt: new Date(this.now()).toISOString(),
      source,
      server: { name: server.name, mcVersion: server.mcVersion, loader: server.loader, loaderVersion: server.loaderVersion },
      world: { levelName: level, folders: collected.worlds, layout: styleForLoader(server.loader), dataVersion },
      includes: { config: options.includeConfig, mods: options.mods },
      mods: options.mods === 'none' ? [] : mods,
    };
  }

  private async finish(job: Job, part: string, final: string): Promise<void> {
    await renameWithRetry(part, final);
    const size = (await stat(final)).size;
    job.file = final;
    job.dto.sizeBytes = size;
    job.dto.status = 'ready';
    job.dto.expiresAt = this.now() + TTL_MS;
  }

  private async write(format: ExportFormat, part: string, sources: TarSource[], checkpoint: () => void): Promise<void> {
    if (format === 'zip') await writeZip(part, sources, { checkpoint });
    else await writeTarGz(part, sources, { checkpoint });
  }

  private async levelDataVersion(worldDir: string): Promise<number | null> {
    try {
      return parseLevelDat(await readFile(path.join(worldDir, 'level.dat'))).dataVersion;
    } catch {
      return null;
    }
  }

  private async buildServerExport(job: Job, server: Server): Promise<void> {
    const { manager } = this.options;
    const serverDir = path.join(this.options.serversDir, server.id);
    const options = job.dto.options;
    const state = manager.status(server.id).state;
    const live = state === 'online';
    if (!live && state !== 'offline' && state !== 'crashed') {
      throw new AppError(409, 'EXPORT_SERVER_BUSY', 'The server is starting or stopping. Please wait until it is running or stopped.');
    }
    const level = await readLevelName(serverDir);
    await mkdir(this.options.tmpDir, { recursive: true });
    const final = path.join(this.options.tmpDir, `${job.dto.id}.${options.format === 'zip' ? 'zip' : 'tar.gz'}`);
    const part = `${final}.part`;
    let session: SaveSession | null = null;
    manager.announce(server.id, msg('EXPORT_ANNOUNCE'));
    try {
      let collected = await collectSources(serverDir, level, options.includeConfig);
      if (collected.worlds.length === 0) {
        throw new AppError(409, 'EXPORT_NOTHING', `There is no world data to export yet (folder "${level}" is missing). The server must have been started once.`, undefined, { levelName: level });
      }
      // jars do not change while the server runs, so they are read before the world is frozen
      const modData = options.mods === 'none' ? { manifest: [], sources: [] } : await this.modEntries(server, options.mods === 'jars');
      const jarBytes = modData.sources.reduce((sum, source) => sum + (source.kind === 'file' ? source.size : 0), 0);
      await assertFreeSpace(this.freeSpace, this.options.tmpDir, Math.ceil((collected.rawBytes + jarBytes) * COMPRESSION_ESTIMATE) + 64 * MIB, 'export');

      if (live) session = new SaveSession(manager, server.id, this.timings);
      let saveOn = true;
      try {
        if (session !== null) {
          await session.freeze();
          // chunks may have been created while the server flushed
          collected = await collectSources(serverDir, level, options.includeConfig);
        }
        const dataVersion = await this.levelDataVersion(path.join(serverDir, level));
        const manifest = this.manifestFor(server, 'server', options, collected, level, dataVersion, modData.manifest);
        const sources: TarSource[] = [
          { kind: 'bytes', name: EXPORT_MANIFEST_NAME, data: serializeManifest(manifest), mtimeMs: this.now(), mode: 0o644 },
          ...collected.sources,
          ...modData.sources,
        ];
        await this.write(options.format, part, sources, this.checkpoint(server.id, live));
      } finally {
        if (session !== null) saveOn = await session.resume();
      }
      const warn = (warning: Msg): void => {
        job.dto.warnings.push(warning.text);
        job.dto.warningRefs.push(warning.ref);
      };
      if (!saveOn) warn(msg('SAVE_ON_UNCONFIRMED'));
      if (collected.skipped.length > 0) warn(msg('EXPORT_WARN_SYMLINKS', { count: collected.skipped.length }));
      await this.finish(job, part, final);
      manager.announce(server.id, msg('EXPORT_FINISHED'));
    } catch (error) {
      await rm(part, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      session?.close();
    }
  }

  // ---- export of an existing backup ----------------------------------------------------------

  async startBackupExport(serverId: string, backupId: string, format: ExportFormat): Promise<ExportJobDto> {
    const server = await this.serverRow(serverId);
    const { row, file } = await this.options.backups.locate(serverId, backupId);
    if (server.game !== 'minecraft') return this.startGameBackupExport(server, row, file, format);
    const options: ExportOptionsDto = { format, mods: 'none', includeConfig: row.includesConfig };
    const job = this.register(server, 'backup', options);
    this.launch(job, async () => {
      const staging = path.join(this.options.tmpDir, `${job.dto.id}.staging`);
      const final = path.join(this.options.tmpDir, `${job.dto.id}.${format === 'zip' ? 'zip' : 'tar.gz'}`);
      const part = `${final}.part`;
      try {
        await mkdir(this.options.tmpDir, { recursive: true });
        await assertFreeSpace(this.freeSpace, this.options.tmpDir, row.rawBytes + Math.ceil(row.rawBytes * COMPRESSION_ESTIMATE) + 128 * MIB, 'export');
        const check = this.checkpoint(serverId, false);
        await extractTarGz(file, staging, { maxBytes: row.rawBytes + MIB, maxEntries: 5_000_000, checkpoint: check });
        const collected = await collectSources(staging, row.levelName, row.includesConfig);
        if (collected.worlds.length === 0) throw new AppError(409, 'EXPORT_NOTHING', 'The backup does not contain a world.');
        const dataVersion = await this.levelDataVersion(path.join(staging, row.levelName));
        const manifest = this.manifestFor(server, 'backup', options, collected, row.levelName, dataVersion, []);
        const sources: TarSource[] = [{ kind: 'bytes', name: EXPORT_MANIFEST_NAME, data: serializeManifest(manifest), mtimeMs: this.now(), mode: 0o644 }, ...collected.sources];
        await this.write(format, part, sources, check);
        await this.finish(job, part, final);
      } catch (error) {
        await rm(part, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      }
    });
    return job.dto;
  }

  // ---- games other than Minecraft: the folders of the game's backup layout, while the server is stopped ----

  private async gameLayout(server: Server, root?: string): Promise<BackupLayout> {
    if (this.options.layoutOf === undefined) throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', 'This game has no world export.');
    const layout = await this.options.layoutOf(server, path.join(this.options.serversDir, server.id));
    return root === undefined ? layout : { ...layout, root };
  }

  private async startGameExport(server: Server, options: ExportOptionsDto): Promise<ExportJobDto> {
    const state = this.options.manager.status(server.id).state;
    if (state !== 'offline' && state !== 'crashed') {
      throw new AppError(409, 'EXPORT_NEEDS_STOP', 'This game can only be exported while the server is stopped. Please stop it first.');
    }
    if (this.options.backups.isBusy(server.id)) {
      throw new AppError(409, 'BACKUP_IN_PROGRESS', 'A backup is currently running for this server. Please wait before the world is exported.');
    }
    const layout = await this.gameLayout(server);
    if (!(await hasLayoutData(layout, layout.levelName, false))) {
      throw new AppError(409, 'EXPORT_NOTHING', 'There is no world data to export yet. The server must have been started once.', undefined, { levelName: layout.levelName });
    }
    const job = this.register(server, 'server', { format: options.format, mods: 'none', includeConfig: options.includeConfig });
    this.launch(job, () =>
      this.options.lock.run(server.id, async () => {
        if (this.options.manager.isRunning(server.id)) throw new AppError(409, 'EXPORT_NEEDS_STOP', 'This game can only be exported while the server is stopped. Please stop it first.');
        await this.writeGameArchive(job, server, 'server', layout, layout.levelName, () => {
          if (this.abort.signal.aborted) throw new AppError(503, 'SHUTTING_DOWN', 'The export was cancelled because the application is shutting down.');
          if (this.options.manager.isRunning(server.id)) throw new AppError(409, 'EXPORT_INTERRUPTED', 'The server was started during the export. The incomplete export was discarded.');
        });
      }),
    );
    return job.dto;
  }

  private startGameBackupExport(server: Server, row: { levelName: string; rawBytes: number; includesConfig: boolean }, file: string, format: ExportFormat): ExportJobDto {
    const job = this.register(server, 'backup', { format, mods: 'none', includeConfig: row.includesConfig });
    this.launch(job, async () => {
      const staging = path.join(this.options.tmpDir, `${job.dto.id}.staging`);
      try {
        await mkdir(this.options.tmpDir, { recursive: true });
        await assertFreeSpace(this.freeSpace, this.options.tmpDir, row.rawBytes + Math.ceil(row.rawBytes * COMPRESSION_ESTIMATE) + 128 * MIB, 'export');
        const check = this.checkpoint(server.id, false);
        await extractTarGz(file, staging, { maxBytes: row.rawBytes + MIB, maxEntries: 5_000_000, checkpoint: check });
        await this.writeGameArchive(job, server, 'backup', await this.gameLayout(server, staging), row.levelName, check);
      } finally {
        await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      }
    });
    return job.dto;
  }

  private async writeGameArchive(job: Job, server: Server, source: 'server' | 'backup', layout: BackupLayout, level: string, checkpoint: () => void): Promise<void> {
    const options = job.dto.options;
    const final = path.join(this.options.tmpDir, `${job.dto.id}.${options.format === 'zip' ? 'zip' : 'tar.gz'}`);
    const part = `${final}.part`;
    try {
      await mkdir(this.options.tmpDir, { recursive: true });
      const collected = await collectLayout(layout, level, options.includeConfig);
      if (collected.worlds.length === 0) throw new AppError(409, 'EXPORT_NOTHING', 'There is no world data to export yet. The server must have been started once.', undefined, { levelName: level });
      await assertFreeSpace(this.freeSpace, this.options.tmpDir, Math.ceil(collected.rawBytes * COMPRESSION_ESTIMATE) + 64 * MIB, 'export');
      const manifest = gameExportManifest({ server, source, appVersion: this.options.version, createdAt: this.now(), layout, levelName: level, worlds: collected.worlds, configItems: collected.configItems });
      const sources: TarSource[] = [{ kind: 'bytes', name: GAME_EXPORT_MANIFEST_NAME, data: manifest, mtimeMs: this.now(), mode: 0o644 }, ...collected.sources];
      await this.write(options.format, part, sources, checkpoint);
      if (collected.skipped.length > 0) {
        const warning = msg('EXPORT_WARN_SYMLINKS', { count: collected.skipped.length });
        job.dto.warnings.push(warning.text);
        job.dto.warningRefs.push(warning.ref);
      }
      await this.finish(job, part, final);
    } catch (error) {
      await rm(part, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
