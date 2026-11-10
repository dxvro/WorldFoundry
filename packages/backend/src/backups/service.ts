import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { extractTarGz, writeTarGz, type TarSource } from '../archive/tar.js';
import type { BackupDto, BackupListResponse, BackupSchedule } from '../contract.js';
import { errorMsg } from '../http/errors.js';
import { joinMsgs, msg, parseRef, serializeRef, type MessageRef, type Msg, type Text } from '../messages.js';
import type { Db } from '../db/client.js';
import type { BackupKind } from '../db/enums.js';
import { backups, servers, type Backup, type Server } from '../db/schema.js';
import type { EventBus } from '../events/bus.js';
import { AppError } from '../http/errors.js';
import { assertFreeSpace, freeBytes, WORLD_COMPRESSION_ESTIMATE, type FreeSpaceReader } from '../lib/disk.js';
import { renameWithRetry } from '../lib/fs-retry.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { rethrowFsError } from '../mods/fs-errors.js';
import type { ProcessManager } from '../process/manager.js';
import { DEFAULT_SAVE_TIMINGS, SaveSession, type SaveTimings } from './save.js';
import { MANIFEST_NAME, collectLayout, hasLayoutData, minecraftLayout, newestChange, type BackupLayout } from './world.js';

export const BackupScheduleSchema = z
  .object({
    intervalHours: z.number().int().min(1).max(24 * 30).nullable(),
    keepLast: z.number().int().min(1).max(100),
    includeConfig: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No setting was provided.' });

export type BackupScheduleInput = z.infer<typeof BackupScheduleSchema>;

const ManifestSchema = z.object({
  format: z.literal(1),
  levelName: z.string().min(1),
  worlds: z.array(z.string().min(1)).max(10),
  configItems: z.array(z.string().min(1)).max(100),
});
type Manifest = z.infer<typeof ManifestSchema>;

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SAFE_ARCHIVE = /^[A-Za-z0-9._-]{1,200}\.tar\.gz$/;
const MIB = 1024 * 1024;
const COMPRESSION_ESTIMATE = WORLD_COMPRESSION_ESTIMATE;
const KEEP_FAILED_AUTO = 5;
const BUSY_STATES: ReadonlySet<string> = new Set(['preparing', 'starting', 'stopping']);

export interface BackupServiceOptions {
  db: Db;
  serversDir: string;
  backupsDir: string;
  lock: KeyedLock;
  bus: EventBus;
  manager: ProcessManager;
  logger?: Logger;
  freeSpace?: FreeSpaceReader;
  saveTimings?: SaveTimings;
  // the folders a backup of a server holds, per game; Minecraft when absent (tests)
  layoutOf?: (server: Server, serverDir: string) => Promise<BackupLayout>;
}

export interface RestoreResult {
  backup: BackupDto;
  safety: BackupDto | null;
  warnings: string[];
  warningRefs: Array<MessageRef | null>;
}

export type BackupDisposal = 'delete' | 'keep';

const notFound = (): AppError => new AppError(404, 'BACKUP_NOT_FOUND', 'The backup was not found.');
const serverNotFound = (): AppError => new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');

function parseWorlds(raw: string): string[] {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const toBackupDto = (row: Backup): BackupDto => {
  const { noteRef, errorRef, ...rest } = row;
  return { ...rest, worlds: parseWorlds(row.worlds), noteRef: parseRef(noteRef), errorRef: parseRef(errorRef) };
};

const failedPatch = (failure: Msg, finishedAt: Date): Partial<Backup> => ({
  status: 'failed',
  error: failure.text,
  errorRef: serializeRef(failure.ref),
  finishedAt,
});

const stamp = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');

export class BackupService {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly logger: Logger;
  private readonly freeSpace: FreeSpaceReader;
  private readonly timings: SaveTimings;
  private readonly abort = new AbortController();

  constructor(private readonly options: BackupServiceOptions) {
    this.logger = options.logger ?? silentLogger;
    this.freeSpace = options.freeSpace ?? freeBytes;
    this.timings = options.saveTimings ?? DEFAULT_SAVE_TIMINGS;
  }

  // ---- paths -------------------------------------------------------------------------------

  private serverDir(serverId: string): string {
    return path.join(this.options.serversDir, serverId);
  }

  // folder holding all backup archives (the import checks its free space for the safety backup)
  get directory(): string {
    return this.options.backupsDir;
  }

  private archiveDir(serverId: string): string {
    if (!SAFE_ID.test(serverId)) throw new AppError(400, 'VALIDATION_ERROR', 'The server ID is invalid.');
    return path.join(this.options.backupsDir, serverId);
  }

  // the only way to a backup file: names from the database are checked again before they touch the disk
  private async archiveFile(row: Pick<Backup, 'serverId' | 'fileName'>): Promise<string> {
    if (!SAFE_ARCHIVE.test(row.fileName)) throw new AppError(409, 'BACKUP_PATH_UNSAFE', 'The file name of the backup is invalid.');
    const dir = this.archiveDir(row.serverId);
    const file = path.join(dir, row.fileName);
    if (path.dirname(file) !== dir) throw new AppError(409, 'BACKUP_PATH_UNSAFE', 'The file name of the backup is invalid.');
    return file;
  }

  // ---- queries -----------------------------------------------------------------------------

  private layoutOf(server: Server): Promise<BackupLayout> {
    const dir = this.serverDir(server.id);
    return this.options.layoutOf === undefined ? minecraftLayout(dir) : this.options.layoutOf(server, dir);
  }

  private async serverRow(serverId: string): Promise<Server> {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw serverNotFound();
    return row;
  }

  private async backupRow(serverId: string, backupId: string): Promise<Backup> {
    const row = (await this.options.db.select().from(backups).where(and(eq(backups.id, backupId), eq(backups.serverId, serverId))))[0];
    if (row === undefined) throw notFound();
    return row;
  }

  schedule(server: Pick<Server, 'backupIntervalHours' | 'backupKeepLast' | 'backupIncludeConfig'>): BackupSchedule {
    return { intervalHours: server.backupIntervalHours, keepLast: server.backupKeepLast, includeConfig: server.backupIncludeConfig };
  }

  async list(serverId: string): Promise<BackupListResponse> {
    const server = await this.serverRow(serverId);
    const rows = await this.options.db.select().from(backups).where(eq(backups.serverId, serverId)).orderBy(desc(backups.createdAt));
    return {
      backups: rows.map(toBackupDto),
      schedule: this.schedule(server),
      totalBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
      freeBytes: await this.freeSpace(this.options.backupsDir),
      running: this.jobs.has(serverId),
    };
  }

  async summary(serverId: string): Promise<{ count: number; sizeBytes: number }> {
    const rows = await this.options.db.select().from(backups).where(eq(backups.serverId, serverId));
    return { count: rows.length, sizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0) };
  }

  isBusy(serverId: string): boolean {
    return this.jobs.has(serverId);
  }

  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.allSettled([...this.jobs.values()]);
  }

  async shutdown(timeoutMs = 15_000): Promise<void> {
    this.abort.abort();
    await Promise.race([this.idle(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  // a lookup for the download route: validated row and absolute file
  async locate(serverId: string, backupId: string): Promise<{ row: Backup; file: string; size: number }> {
    const row = await this.backupRow(serverId, backupId);
    if (row.status !== 'ok') throw new AppError(409, 'BACKUP_NOT_READY', 'This backup is not finished and cannot be downloaded.');
    const file = await this.archiveFile(row);
    const info = await lstat(file).catch(() => null);
    if (info === null || info.isSymbolicLink() || !info.isFile()) {
      throw new AppError(404, 'BACKUP_FILE_MISSING', 'The backup file is missing from the data folder.');
    }
    return { row, file, size: info.size };
  }

  openDownload(file: string): ReturnType<typeof createReadStream> {
    return createReadStream(file);
  }

  // ---- creating ----------------------------------------------------------------------------

  // Validates, records the backup as "running" and returns at once; the archive is written in the background
  async start(serverId: string, kind: Exclude<BackupKind, 'safety'>, includeConfig?: boolean): Promise<BackupDto> {
    if (this.abort.signal.aborted) throw new AppError(503, 'SHUTTING_DOWN', 'The application is shutting down.');
    if (this.jobs.has(serverId)) throw new AppError(409, 'BACKUP_IN_PROGRESS', 'A backup is already running for this server.');
    let release: () => void = () => undefined;
    const reservation = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.jobs.set(serverId, reservation);
    let queued = false;
    try {
      const server = await this.serverRow(serverId);
      if (BUSY_STATES.has(this.options.manager.status(serverId).state)) {
        throw new AppError(409, 'BACKUP_SERVER_BUSY', 'The server is starting or stopping. Please wait until it is running or stopped.');
      }
      const layout = await this.layoutOf(server);
      const withConfig = (includeConfig ?? server.backupIncludeConfig) && layout.configFiles.length + layout.configDirs.length > 0;
      const level = layout.levelName;
      if (!layout.live && this.options.manager.isRunning(serverId)) {
        throw new AppError(409, 'BACKUP_NEEDS_STOP', 'This game can only be backed up while the server is stopped. Please stop it first.');
      }
      if (!(await hasLayoutData(layout, level, withConfig))) {
        throw new AppError(
          409,
          'BACKUP_NOTHING_TO_SAVE',
          `There is no world data to back up yet (folder "${level}" is missing). The server must have been started once.`,
        );
      }
      const row = await this.insertRow(server, kind, withConfig, null);
      const job: Promise<void> = this.options.lock
        .run(serverId, () => this.process(row))
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (this.jobs.get(serverId) === job) this.jobs.delete(serverId);
          release();
        });
      this.jobs.set(serverId, job);
      queued = true;
      return toBackupDto(row);
    } finally {
      if (!queued) {
        this.jobs.delete(serverId);
        release();
      }
    }
  }

  // runs one backup to completion (scheduler)
  async startAndWait(serverId: string, kind: Exclude<BackupKind, 'safety'>): Promise<BackupDto> {
    const dto = await this.start(serverId, kind);
    await this.jobs.get(serverId);
    return toBackupDto(await this.backupRow(serverId, dto.id));
  }

  // A safety copy of the current world for another operation that is about to replace it (world import). The
  // caller holds the server's lock; null means there was nothing to save. Throws when the copy cannot be made.
  async safetyBackupLocked(serverId: string, note: Msg): Promise<BackupDto | null> {
    if (this.jobs.has(serverId)) throw new AppError(409, 'BACKUP_IN_PROGRESS', 'A backup is currently running for this server.');
    const server = await this.serverRow(serverId);
    const layout = await this.layoutOf(server);
    const current = await collectLayout(layout, layout.levelName, false);
    if (current.worlds.length === 0) return null;
    return toBackupDto(await this.process(await this.insertRow(server, 'safety', false, note)));
  }

  private async insertRow(server: Server, kind: BackupKind, includeConfig: boolean, note: Msg | null): Promise<Backup> {
    const level = (await this.layoutOf(server)).levelName;
    const now = new Date();
    const id = randomUUID();
    const row: Backup = {
      id,
      serverId: server.id,
      kind,
      status: 'running',
      fileName: `${stamp(now)}-${kind}-${id.slice(0, 8)}.tar.gz`,
      sizeBytes: 0,
      rawBytes: 0,
      includesConfig: includeConfig,
      levelName: level,
      worlds: '[]',
      note: note === null ? null : note.text,
      noteRef: note === null ? null : serializeRef(note.ref),
      error: null,
      errorRef: null,
      createdAt: now,
      finishedAt: null,
    };
    this.archiveDir(server.id);
    await this.options.db.transaction((tx) => tx.insert(backups).values(row));
    this.options.bus.emit({ type: 'backup.changed', serverId: server.id, backupId: id, kind, status: 'running', error: null, errorRef: null });
    return row;
  }

  private async settleRow(row: Backup, patch: Partial<Backup>): Promise<Backup> {
    const next = { ...row, ...patch };
    await this.options.db.transaction((tx) => tx.update(backups).set(patch).where(eq(backups.id, row.id)));
    this.options.bus.emit({ type: 'backup.changed', serverId: row.serverId, backupId: row.id, kind: row.kind, status: next.status, error: next.error, errorRef: parseRef(next.errorRef) });
    return next;
  }

  private checkpoint(serverId: string, live: boolean): () => void {
    return () => {
      if (this.abort.signal.aborted) throw new AppError(503, 'SHUTTING_DOWN', 'The backup was cancelled because the application is shutting down.');
      if (live && this.options.manager.status(serverId).state !== 'online') {
        throw new AppError(409, 'BACKUP_INTERRUPTED', 'The server was stopped during the backup. The incomplete backup was discarded.');
      }
    };
  }

  // Writes the archive for a row that is already recorded. Never leaves a half-written file behind and always
  // sends save-on again after a save-off, whatever happened in between.
  private async process(row: Backup): Promise<Backup> {
    const { manager } = this.options;
    const layout = await this.layoutOf(await this.serverRow(row.serverId));
    const dir = this.archiveDir(row.serverId);
    const final = path.join(dir, row.fileName);
    const part = `${final}.part`;
    let session: SaveSession | null = null;
    manager.announce(row.serverId, msg(row.kind === 'safety' ? 'BACKUP_ANNOUNCE_SAFETY' : 'BACKUP_ANNOUNCE'));
    try {
      await mkdir(dir, { recursive: true });
      const state = manager.status(row.serverId).state;
      const live = state === 'online';
      if (live && !layout.live) throw new AppError(409, 'BACKUP_NEEDS_STOP', 'This game can only be backed up while the server is stopped. Please stop it first.');
      if (!live && state !== 'offline' && state !== 'crashed') {
        throw new AppError(409, 'BACKUP_SERVER_BUSY', 'The server is starting or stopping. Please wait until it is running or stopped.');
      }
      let collected = await collectLayout(layout, row.levelName, row.includesConfig);
      if (collected.worlds.length === 0 && collected.configItems.length === 0) {
        throw new AppError(
          409,
          'BACKUP_NOTHING_TO_SAVE',
          `There is no world data to back up yet (folder "${row.levelName}" is missing). The server must have been started once.`,
        );
      }
      await assertFreeSpace(this.freeSpace, dir, Math.ceil(collected.rawBytes * COMPRESSION_ESTIMATE) + 64 * MIB, 'backup');

      let saveOnConfirmed = true;
      if (live) session = new SaveSession(manager, row.serverId, this.timings);
      try {
        if (session !== null) {
          await session.freeze();
          // chunks may have been created while the server flushed, so the list is built after the flush
          collected = await collectLayout(layout, row.levelName, row.includesConfig);
        }
        const manifest: Manifest & { createdAt: string; kind: BackupKind; serverId: string } = {
          format: 1,
          levelName: row.levelName,
          worlds: collected.worlds,
          configItems: collected.configItems,
          createdAt: row.createdAt.toISOString(),
          kind: row.kind,
          serverId: row.serverId,
        };
        const sources: TarSource[] = [
          { kind: 'bytes', name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2)), mtimeMs: row.createdAt.getTime(), mode: 0o644 },
          ...collected.sources,
        ];
        await writeTarGz(part, sources, { checkpoint: this.checkpoint(row.serverId, live) });
      } finally {
        if (session !== null) saveOnConfirmed = await session.resume();
      }
      await renameWithRetry(part, final);
      const size = (await stat(final)).size;
      const notes: Text[] = [];
      if (row.note !== null) notes.push(row.noteRef === null ? row.note : { text: row.note, ref: parseRef(row.noteRef) as NonNullable<ReturnType<typeof parseRef>> });
      if (collected.skipped.length > 0) notes.push(msg('BACKUP_NOTE_SYMLINKS', { count: collected.skipped.length }));
      if (!saveOnConfirmed) notes.push(msg('SAVE_ON_UNCONFIRMED'));
      const joined = joinMsgs(notes);
      let done: Backup;
      try {
        done = await this.settleRow(row, {
          status: 'ok',
          sizeBytes: size,
          rawBytes: collected.rawBytes,
          worlds: JSON.stringify(collected.worlds),
          note: joined === null ? null : joined.text,
          noteRef: joined === null ? null : serializeRef(joined.ref),
          finishedAt: new Date(),
        });
      } catch (error) {
        await rm(final, { force: true }).catch(() => undefined);
        throw error;
      }
      if (!saveOnConfirmed) this.logger.warn({ serverId: row.serverId }, 'save-on was not confirmed');
      manager.announce(row.serverId, msg('BACKUP_FINISHED'));
      return done;
    } catch (error) {
      await rm(part, { force: true }).catch(() => undefined);
      const failure = errorMsg(error, msg('BACKUP_UNEXPECTED'));
      if (!(error instanceof AppError)) this.logger.error({ err: error, serverId: row.serverId }, 'Backup failed');
      else this.logger.warn({ serverId: row.serverId, code: error.code }, `Backup failed: ${failure.text}`);
      manager.announce(row.serverId, msg('BACKUP_FAILED_REASON', { reason: failure }));
      await this.settleRow(row, failedPatch(failure, new Date())).catch((settleError: unknown) =>
        this.logger.error({ err: settleError, serverId: row.serverId }, 'The failure status of the backup could not be saved'),
      );
      throw error;
    } finally {
      session?.close();
    }
  }

  // ---- retention ---------------------------------------------------------------------------

  // only automatic backups are ever pruned here; manual and safety backups stay until the user deletes them
  async pruneAutomatic(serverId: string): Promise<number> {
    const server = await this.serverRow(serverId);
    const rows = await this.options.db
      .select()
      .from(backups)
      .where(and(eq(backups.serverId, serverId), eq(backups.kind, 'auto')))
      .orderBy(desc(backups.createdAt));
    const good = rows.filter((row) => row.status === 'ok');
    const failed = rows.filter((row) => row.status === 'failed');
    const doomed = [...good.slice(server.backupKeepLast), ...failed.slice(KEEP_FAILED_AUTO)];
    for (const row of doomed) await this.deleteRow(row);
    return doomed.length;
  }

  private async deleteRow(row: Backup): Promise<void> {
    try {
      await rm(await this.archiveFile(row), { force: true });
    } catch (error) {
      rethrowFsError(error, row.fileName);
    }
    await this.options.db.transaction((tx) => tx.delete(backups).where(eq(backups.id, row.id)));
    this.options.bus.emit({ type: 'backup.changed', serverId: row.serverId, backupId: row.id, kind: row.kind, status: 'deleted', error: null, errorRef: null });
  }

  remove(serverId: string, backupId: string): Promise<void> {
    return this.options.lock.run(serverId, async () => {
      const row = await this.backupRow(serverId, backupId);
      if (row.status === 'running') throw new AppError(409, 'BACKUP_IN_PROGRESS', 'This backup is currently being created and cannot be deleted.');
      await this.deleteRow(row);
    });
  }

  // ---- schedule ----------------------------------------------------------------------------

  async setSchedule(serverId: string, input: BackupScheduleInput): Promise<BackupSchedule> {
    const server = await this.serverRow(serverId);
    const intervalChanged = input.intervalHours !== undefined && input.intervalHours !== server.backupIntervalHours;
    await this.options.db.transaction((tx) =>
      tx
        .update(servers)
        .set({
          ...(input.intervalHours === undefined ? {} : { backupIntervalHours: input.intervalHours }),
          ...(input.keepLast === undefined ? {} : { backupKeepLast: input.keepLast }),
          ...(input.includeConfig === undefined ? {} : { backupIncludeConfig: input.includeConfig }),
          // the interval counts from the moment it was set
          ...(intervalChanged ? { backupScheduleSince: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(servers.id, serverId)),
    );
    this.options.bus.emit({ type: 'server.changed', serverId, reason: 'updated' });
    return this.schedule(await this.serverRow(serverId));
  }

  // One pass of the scheduler: starts every backup that is due, one after the other
  async runDue(now = Date.now()): Promise<number> {
    const rows = await this.options.db.select().from(servers);
    let started = 0;
    for (const server of rows) {
      if (this.abort.signal.aborted) break;
      if (server.backupIntervalHours === null || server.installState !== 'installed' || this.jobs.has(server.id)) continue;
      const last = (
        await this.options.db
          .select({ createdAt: backups.createdAt })
          .from(backups)
          .where(and(eq(backups.serverId, server.id), eq(backups.kind, 'auto')))
          .orderBy(desc(backups.createdAt))
          .limit(1)
      )[0];
      const anchor = Math.max(last?.createdAt.getTime() ?? 0, server.backupScheduleSince?.getTime() ?? 0);
      if (now < anchor + server.backupIntervalHours * 3_600_000) continue;
      const state = this.options.manager.status(server.id).state;
      if (BUSY_STATES.has(state)) continue;
      try {
        if (state !== 'online' && !(await this.changedSinceLastBackup(server))) {
          await this.options.db.transaction((tx) => tx.update(servers).set({ backupScheduleSince: new Date(now) }).where(eq(servers.id, server.id)));
          continue;
        }
        await this.startAndWait(server.id, 'auto');
        started++;
        await this.options.lock.run(server.id, () => this.pruneAutomatic(server.id));
      } catch (error) {
        // already recorded and announced by process(); a failure before that (nothing to save yet) is only logged
        this.logger.warn({ serverId: server.id, err: error }, 'Scheduled backup was not run');
        await this.options.db
          .transaction((tx) => tx.update(servers).set({ backupScheduleSince: new Date(now) }).where(eq(servers.id, server.id)))
          .catch(() => undefined);
      }
    }
    return started;
  }

  private async changedSinceLastBackup(server: Server): Promise<boolean> {
    const last = (
      await this.options.db
        .select({ createdAt: backups.createdAt })
        .from(backups)
        .where(and(eq(backups.serverId, server.id), eq(backups.status, 'ok')))
        .orderBy(desc(backups.createdAt))
        .limit(1)
    )[0];
    if (last === undefined) return true;
    const layout = await this.layoutOf(server).catch(() => null);
    if (layout === null) return true;
    return (await newestChange(layout.root, layout.levelName, layout.worlds)) > last.createdAt.getTime();
  }

  // ---- boot and removal --------------------------------------------------------------------

  // Backups that were running when the application ended are marked failed and their partial files removed
  async recoverInterrupted(): Promise<number> {
    const stuck = await this.options.db.select().from(backups).where(eq(backups.status, 'running'));
    for (const row of stuck) {
      await this.settleRow(row, failedPatch(msg('BACKUP_INTERRUPTED_SHUTDOWN'), new Date()));
    }
    let dirs: string[] = [];
    try {
      dirs = await readdir(this.options.backupsDir);
    } catch {
      return stuck.length;
    }
    for (const name of dirs) {
      const dir = path.join(this.options.backupsDir, name);
      for (const file of await readdir(dir).catch(() => [])) {
        if (file.endsWith('.part')) await rm(path.join(dir, file), { force: true }).catch(() => undefined);
      }
    }
    for (const server of await this.options.db.select({ id: servers.id }).from(servers)) {
      const serverDir = this.serverDir(server.id);
      for (const entry of await readdir(serverDir).catch(() => [])) {
        if (entry.startsWith('.restore-new-')) await rm(path.join(serverDir, entry), { recursive: true, force: true }).catch(() => undefined);
        else if (entry.startsWith('.restore-old-')) {
          this.logger.warn({ serverId: server.id, entry }, 'An interrupted restore left behind a folder with the old data. It is not deleted automatically.');
        }
      }
    }
    return stuck.length;
  }

  // What happens to the archives of a deleted server: removed, or kept with a note about whose they were
  async dispose(server: Pick<Server, 'id' | 'name' | 'loader' | 'mcVersion'>, mode: BackupDisposal): Promise<void> {
    const dir = this.archiveDir(server.id);
    try {
      if (mode === 'delete') {
        await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } else if ((await stat(dir).catch(() => null)) !== null) {
        const note = { id: server.id, name: server.name, loader: server.loader, mcVersion: server.mcVersion, removedAt: new Date().toISOString() };
        await writeFile(path.join(dir, 'server.json'), JSON.stringify(note, null, 2), 'utf8');
      }
    } catch (error) {
      this.logger.warn({ err: error, serverId: server.id }, 'The backups of a deleted server could not be processed');
    }
  }

  // ---- restoring ---------------------------------------------------------------------------

  async restore(serverId: string, backupId: string): Promise<RestoreResult> {
    this.assertStopped(serverId);
    await this.serverRow(serverId);
    if (this.jobs.has(serverId)) throw new AppError(409, 'BACKUP_IN_PROGRESS', 'A backup is currently running for this server.');
    return this.options.lock.run(serverId, async () => {
      this.assertStopped(serverId);
      const server = await this.serverRow(serverId);
      const row = await this.backupRow(serverId, backupId);
      if (row.status !== 'ok') throw new AppError(409, 'BACKUP_NOT_READY', 'This backup is not finished and cannot be restored.');
      const archive = await this.archiveFile(row);
      if ((await stat(archive).catch(() => null)) === null) {
        throw new AppError(404, 'BACKUP_FILE_MISSING', 'The backup file is missing from the data folder.');
      }
      const layout = await this.layoutOf(server);
      const serverDir = layout.root;
      await mkdir(serverDir, { recursive: true });
      const staging = path.join(serverDir, `.restore-new-${randomUUID()}`);
      const trash = path.join(serverDir, `.restore-old-${randomUUID()}`);
      const warnings: Msg[] = [];
      let swapped = false;
      this.options.manager.announce(serverId, msg('BACKUP_RESTORING'));
      try {
        await assertFreeSpace(this.freeSpace, serverDir, row.rawBytes + 64 * MIB, 'restore');
        await extractTarGz(archive, staging, { maxBytes: row.rawBytes + MIB, maxEntries: 5_000_000, checkpoint: this.checkpoint(serverId, false) });
        const manifest = await this.readManifest(staging, layout);

        // the safety copy of what is about to be replaced; a failure here stops the restore
        const currentLevel = layout.levelName;
        const current = await collectLayout(layout, currentLevel, row.includesConfig);
        let safety: BackupDto | null = null;
        if (current.worlds.length > 0 || current.configItems.length > 0) {
          const safetyRow = await this.insertRow(server, 'safety', row.includesConfig, msg('BACKUP_NOTE_BEFORE_RESTORE', { fileName: row.fileName }));
          safety = toBackupDto(await this.process(safetyRow));
        }

        await this.swap(serverDir, staging, trash, manifest, currentLevel, layout);
        swapped = true;
        const levelNow = await this.layoutOf(server).then((next) => next.levelName, () => manifest.levelName);
        if (levelNow !== manifest.levelName) {
          warnings.push(msg('RESTORE_LEVEL_MISMATCH', { restored: manifest.levelName, current: levelNow }));
        }
        this.options.manager.announce(serverId, msg('BACKUP_RESTORED'));
        return { backup: toBackupDto(row), safety, warnings: warnings.map((w) => w.text), warningRefs: warnings.map((w) => w.ref) };
      } catch (error) {
        this.options.manager.announce(serverId, msg('RESTORE_FAILED_REASON', { reason: errorMsg(error, msg('UNEXPECTED_ERROR')) }));
        throw error;
      } finally {
        await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
        // after a failed swap the folder may hold the only copy of the old data, so it is only removed after success
        if (swapped) {
          await rm(trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error: unknown) =>
            this.logger.warn({ err: error, serverId }, 'Old world data could not be removed after the restore'),
          );
        } else {
          // rmdir only succeeds on an empty folder, which is the case when everything was put back
          await rmdir(trash).catch(() => undefined);
        }
      }
    });
  }

  private assertStopped(serverId: string): void {
    if (this.options.manager.isRunning(serverId)) {
      throw new AppError(409, 'SERVER_RUNNING', 'The server is running. Please stop it first before restoring a backup.');
    }
  }

  private async readManifest(staging: string, layout: BackupLayout): Promise<Manifest> {
    let manifest: Manifest;
    try {
      manifest = ManifestSchema.parse(JSON.parse(await readFile(path.join(staging, MANIFEST_NAME), 'utf8')));
    } catch {
      throw new AppError(422, 'BACKUP_INVALID', 'The backup does not contain a valid description (worldfoundry-backup.json) and cannot be restored.');
    }
    const level = layout.validateLevel(manifest.levelName);
    const allowedWorlds = new Set(layout.worlds(level));
    const allowedConfig = new Set([...layout.configFiles, ...layout.configDirs]);
    const entries = (await readdir(staging)).filter((name) => name !== MANIFEST_NAME);
    const declared = new Set([...manifest.worlds, ...manifest.configItems]);
    const valid =
      manifest.worlds.every((name) => allowedWorlds.has(name)) &&
      manifest.configItems.every((name) => allowedConfig.has(name)) &&
      entries.every((name) => declared.has(name));
    if (!valid) throw new AppError(422, 'BACKUP_INVALID', 'The backup contains unexpected files and is not restored for security reasons.');
    return manifest;
  }

  // Moves what exists aside, moves the restored data in, and puts everything back if any step fails
  private async swap(serverDir: string, staging: string, trash: string, manifest: Manifest, currentLevel: string, layout: BackupLayout): Promise<void> {
    const incoming = [...manifest.worlds, ...manifest.configItems];
    const replaced = new Set([...incoming, ...layout.worlds(manifest.levelName), ...layout.worlds(currentLevel)]);
    const aside: Array<{ from: string; to: string }> = [];
    const placed: Array<{ from: string; to: string }> = [];
    const exists = (file: string): Promise<boolean> => lstat(file).then(() => true, () => false);
    try {
      await mkdir(trash, { recursive: true });
      for (const name of replaced) {
        const source = path.join(serverDir, name);
        // config items are only replaced when the backup brings them, worlds always (a stale Nether must not stay)
        const isConfig = layout.configFiles.includes(name) || layout.configDirs.includes(name);
        if (isConfig && !incoming.includes(name)) continue;
        if (!(await exists(source))) continue;
        const target = path.join(trash, name);
        await renameWithRetry(source, target);
        aside.push({ from: source, to: target });
      }
      for (const name of incoming) {
        const from = path.join(staging, name);
        const to = path.join(serverDir, name);
        await renameWithRetry(from, to);
        placed.push({ from, to });
      }
    } catch (error) {
      for (const move of [...placed].reverse()) await renameWithRetry(move.to, move.from).catch(() => undefined);
      for (const move of [...aside].reverse()) await renameWithRetry(move.to, move.from).catch(() => undefined);
      rethrowFsError(error, path.basename(serverDir));
    }
  }
}
