import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, readdir, rmdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { DEFAULT_LEVEL, readLevelName, worldNames } from '../backups/world.js';
import type { BackupService } from '../backups/service.js';
import type { ServerDto } from '../contract.js';
import { msg, type Msg } from '../messages.js';
import type { Db } from '../db/client.js';
import type { Loader } from '../db/enums.js';
import { mods as modsTable, servers, type Server } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import type { LoaderCatalog } from '../installer/catalog.js';
import { assertFreeSpace, freeBytes, sameVolume, sizeText, WORLD_COMPRESSION_ESTIMATE, type FreeSpaceReader } from '../lib/disk.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { sanitizeJarName } from '../mods/downloader.js';
import { DISABLED_SUFFIX } from '../mods/files.js';
import { getLoaderProfile } from '../mods/profile.js';
import type { ModService } from '../mods/service.js';
import type { ModrinthApi } from '../modrinth/types.js';
import type { ProcessManager } from '../process/manager.js';
import { loadProperties, saveProperties } from '../properties/store.js';
import type { CreateServerInput } from '../servers/schemas.js';
import type { ServerService } from '../servers/service.js';
import { errorMsg } from '../http/errors.js';
import { buildAnalysis, gatherFacts, proposeLoader, type FactMod, type ImportFacts } from './analyze.js';
import type { ImportAnalysisDto, ImportJobDto, ImportNotice, ImportResultDto, ImportReviewDto } from './dto.js';
import { buildOutput, convertSingleplayerPlayer, moveDir, styleForLoader } from './layout.js';
import { evaluateNotices, matchMods, notice as notice_, missingMods, missingNotice, type ModSelection, type ReviewTarget } from './review.js';
import { stageArchive, type StageLimits } from './staging.js';
import { swapWorlds } from './swap.js';

const MIB = 1024 * 1024;

// job.message together with its reference
const setMessage = (job: { dto: ImportJobDto }, value: Msg | null): void => {
  job.dto.message = value === null ? null : value.text;
  job.dto.messageRef = value === null ? null : value.ref;
};
const TTL_OPEN_MS = 2 * 60 * 60_000;
const TTL_FINISHED_MS = 15 * 60_000;
const SWEEP_MS = 60_000;
const MAX_OPEN_JOBS = 3;
const MAX_ENTRIES = 1_000_000;
const MAX_RATIO = 200;
const UNPACK_FACTOR = 4;

export interface ImportServiceOptions {
  db: Db;
  serversDir: string;
  tmpDir: string;
  lock: KeyedLock;
  catalog: LoaderCatalog;
  modrinth: ModrinthApi;
  servers: ServerService;
  mods: ModService;
  backups: BackupService;
  manager: ProcessManager;
  logger?: Logger;
  freeSpace?: FreeSpaceReader;
  maxUploadBytes: number;
  now?: () => number;
}

interface Job {
  dto: ImportJobDto;
  dir: string;
  facts: ImportFacts | null;
}

export interface CreateFromImportInput {
  server: Pick<CreateServerInput, 'name' | 'loader' | 'mcVersion'> & Partial<CreateServerInput>;
  importConfig: boolean;
  selection: ModSelection;
  acknowledged: readonly string[];
}

export interface ReplaceInput {
  acknowledged: readonly string[];
}

const notFound = (): AppError => new AppError(404, 'IMPORT_NOT_FOUND', 'The import was not found or has expired. Please upload the archive again.');
const normalise = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

export class ImportService {
  private readonly jobs = new Map<string, Job>();
  private readonly logger: Logger;
  private readonly freeSpace: FreeSpaceReader;
  private readonly abort = new AbortController();
  private readonly background = new Set<Promise<void>>();
  private sweeper: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ImportServiceOptions) {
    this.logger = options.logger ?? silentLogger;
    this.freeSpace = options.freeSpace ?? freeBytes;
    this.now = options.now ?? Date.now;
  }

  get maxUploadBytes(): number {
    return this.options.maxUploadBytes;
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
    await Promise.race([Promise.allSettled([...this.background]), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }

  // an upload, analysis or world swap is working right now (an update must wait for it)
  get busy(): boolean {
    return [...this.jobs.values()].some((job) => job.dto.status === 'uploading' || job.dto.status === 'analyzing' || job.dto.status === 'applying');
  }

  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // leftovers of imports that were running when the application ended
  async recoverInterrupted(): Promise<void> {
    await rm(this.options.tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    for (const server of await this.options.db.select({ id: servers.id }).from(servers)) {
      const serverDir = path.join(this.options.serversDir, server.id);
      for (const entry of await readdir(serverDir).catch(() => [])) {
        if (entry.startsWith('.import-new-')) await rm(path.join(serverDir, entry), { recursive: true, force: true }).catch(() => undefined);
        else if (entry.startsWith('.import-old-')) {
          this.logger.warn({ serverId: server.id, entry }, 'An interrupted world import left behind a folder with the old data. It is not deleted automatically.');
        }
      }
    }
  }

  private limits(): StageLimits {
    return { maxBytes: this.options.maxUploadBytes * UNPACK_FACTOR, maxEntries: MAX_ENTRIES, maxRatio: MAX_RATIO };
  }

  // ---- bookkeeping ---------------------------------------------------------------------------

  private snapshot(job: Job): ImportJobDto {
    return { ...job.dto };
  }

  private touch(job: Job): void {
    const finished = job.dto.status === 'done' || job.dto.status === 'failed';
    job.dto.expiresAt = this.now() + (finished ? TTL_FINISHED_MS : TTL_OPEN_MS);
  }

  private find(id: string): Job {
    const job = this.jobs.get(id);
    if (job === undefined) throw notFound();
    return job;
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    for (const [id, job] of [...this.jobs]) {
      if (job.dto.status === 'applying' || job.dto.status === 'uploading' || job.dto.status === 'analyzing') continue;
      if (job.dto.expiresAt <= now) await this.drop(id);
    }
  }

  private async drop(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    this.jobs.delete(id);
    await rm(job.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }

  get(id: string): ImportJobDto {
    const job = this.find(id);
    if (job.dto.status === 'staged') this.touch(job);
    return this.snapshot(job);
  }

  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    if (job.dto.status === 'applying' || job.dto.status === 'uploading') {
      throw new AppError(409, 'IMPORT_IN_PROGRESS', 'The import is currently running and cannot be cancelled.');
    }
    await this.drop(id);
  }

  private launch(job: Job, work: () => Promise<void>): void {
    const promise = work()
      .catch(async (error: unknown) => {
        const failure = errorMsg(error, msg('IMPORT_UNEXPECTED'));
        if (error instanceof AppError) this.logger.warn({ importId: job.dto.id, code: error.code }, `Import failed: ${failure.text}`);
        else this.logger.error({ err: error, importId: job.dto.id }, 'Import failed');
        // the files go first: a client that sees "failed" can rely on the staging area being gone
        await rm(job.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
        job.dto.status = 'failed';
        job.dto.error = failure.text;
        job.dto.errorRef = failure.ref;
        job.dto.phase = null;
        this.touch(job);
      })
      .finally(() => {
        this.background.delete(promise);
      });
    this.background.add(promise);
  }

  private checkpoint(): void {
    if (this.abort.signal.aborted) throw new AppError(503, 'SHUTTING_DOWN', 'The import was cancelled because the application is shutting down.');
  }

  // ---- upload and analysis -------------------------------------------------------------------

  private async makeRoom(): Promise<void> {
    const open = [...this.jobs.values()].filter((job) => job.dto.status !== 'done' && job.dto.status !== 'failed');
    if (open.length < MAX_OPEN_JOBS) return;
    const staged = open.filter((job) => job.dto.status === 'staged').sort((a, b) => a.dto.createdAt - b.dto.createdAt);
    if (staged[0] === undefined) {
      throw new AppError(409, 'IMPORT_BUSY', 'Several imports are already running. Please wait until one has finished.');
    }
    await this.drop(staged[0].dto.id);
  }

  async upload(stream: Readable, input: { contentLength: number | null; serverId: string | null }): Promise<ImportJobDto> {
    const max = this.options.maxUploadBytes;
    const maxText = sizeText(max);
    if (input.contentLength !== null && input.contentLength > max) {
      throw new AppError(413, 'IMPORT_TOO_LARGE', `The file is too large (at most ${maxText}). The limit can be adjusted with IMPORT_MAX_MB.`, undefined, { max: maxText });
    }
    if (input.serverId !== null) {
      await this.serverRow(input.serverId);
      this.assertStopped(input.serverId);
    }
    await this.makeRoom();
    await mkdir(this.options.tmpDir, { recursive: true });
    await assertFreeSpace(this.freeSpace, this.options.tmpDir, (input.contentLength ?? 64 * MIB) * 2 + 128 * MIB, 'upload');

    const id = randomUUID();
    const dir = path.join(this.options.tmpDir, id);
    const created = this.now();
    const job: Job = {
      dir,
      facts: null,
      dto: {
        id,
        mode: input.serverId === null ? 'new' : 'replace',
        serverId: input.serverId,
        status: 'uploading',
        phase: 'upload',
        message: msg('IMPORT_STEP_UPLOAD').text,
        messageRef: msg('IMPORT_STEP_UPLOAD').ref,
        error: null,
        errorRef: null,
        analysis: null,
        result: null,
        createdAt: created,
        expiresAt: created + TTL_OPEN_MS,
      },
    };
    this.jobs.set(id, job);
    const file = path.join(dir, 'upload.bin');
    try {
      await mkdir(dir, { recursive: true });
      let received = 0;
      // Not stream.pipeline: on an error that would destroy the request, and with it the connection the 413 is sent on.
      const tooLarge = (): AppError => new AppError(413, 'IMPORT_TOO_LARGE', `The file is too large (at most ${maxText}). The limit can be adjusted with IMPORT_MAX_MB.`, undefined, { max: maxText });
      try {
        await new Promise<void>((resolve, reject) => {
          const out = createWriteStream(file, { flags: 'wx' });
          let settled = false;
          const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            stream.pause();
            stream.removeListener('data', onData);
            out.destroy();
            reject(error);
          };
          const onData = (chunk: Buffer): void => {
            received += chunk.length;
            if (received > max) {
              fail(tooLarge());
              return;
            }
            if (!out.write(chunk)) {
              stream.pause();
              out.once('drain', () => stream.resume());
            }
          };
          stream.on('data', onData);
          stream.on('end', () => {
            if (settled) return;
            settled = true;
            out.end(() => resolve());
          });
          stream.on('error', fail);
          stream.on('close', () => {
            if (!(stream as { readableEnded?: boolean }).readableEnded) fail(Object.assign(new Error('closed'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
          });
          out.on('error', fail);
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOSPC') throw new AppError(507, 'DISK_FULL', 'There is not enough free disk space.');
        if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'ABORT_ERR') {
          throw new AppError(400, 'UPLOAD_ABORTED', 'The upload was cancelled.');
        }
        throw error;
      }
      if (received === 0) throw new AppError(400, 'UPLOAD_EMPTY', 'No file was transferred.');
    } catch (error) {
      this.jobs.delete(id);
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      throw error;
    }
    job.dto.status = 'analyzing';
    job.dto.phase = 'analyze';
    setMessage(job, msg('IMPORT_STEP_CHECK'));
    this.launch(job, () => this.analyze(job, file));
    return this.snapshot(job);
  }

  private async analyze(job: Job, file: string): Promise<void> {
    const content = path.join(job.dir, 'content');
    const report = await stageArchive(file, content, this.limits(), this.freeSpace, () => this.checkpoint());
    await rm(file, { force: true });
    setMessage(job, msg('IMPORT_STEP_ANALYZE'));
    const facts = await gatherFacts(content);
    const proposal = await this.proposal(facts);
    const notices = this.staticNotices(facts, proposal.notice);
    job.facts = facts;
    job.dto.analysis = buildAnalysis(
      facts,
      { format: report.format, sizeBytes: report.archiveBytes, entries: report.entries, uncompressedBytes: report.bytes },
      proposal.value,
      notices,
    );
    job.dto.status = 'staged';
    job.dto.phase = null;
    setMessage(job, null);
    this.touch(job);
  }

  private staticNotices(facts: ImportFacts, extra: ImportNotice | null): ImportNotice[] {
    const out: ImportNotice[] = [];
    if (facts.level.preOneNine) {
      out.push(notice_('WORLD_PRE_1_9', 'warn', false, msg('WORLD_PRE_1_9_UPLOAD')));
    } else if (facts.level.mcVersionApprox && facts.level.mcVersion !== null) {
      out.push(notice_('VERSION_APPROX', 'info', false, msg('VERSION_APPROX', { dataVersion: String(facts.level.dataVersion ?? ''), mcVersion: facts.level.mcVersion })));
    }
    if (facts.unreadableJars.length > 0) {
      out.push(notice_('JARS_UNREADABLE', 'warn', false, msg('JARS_UNREADABLE', { names: facts.unreadableJars.slice(0, 5).join(', ') })));
    }
    if (facts.world.otherWorlds.length > 0) {
      out.push(notice_('OTHER_WORLDS', 'info', false, msg('OTHER_WORLDS_UPLOAD', { names: facts.world.otherWorlds.join(', '), more: 0 })));
    }
    if (extra !== null) out.push(extra);
    return out;
  }

  private async proposal(facts: ImportFacts): Promise<{ value: ImportAnalysisDto['proposal']; notice: ImportNotice | null }> {
    const chosen = proposeLoader(facts);
    const mcVersion = facts.manifest?.server.mcVersion ?? facts.level.mcVersion;
    let loaderVersion: string | null = null;
    let notice: ImportNotice | null = null;
    if (chosen.loader !== 'vanilla' && mcVersion !== null) {
      try {
        const versions = await this.options.catalog.versions(chosen.loader, mcVersion);
        const hint = chosen.versionHint;
        const pick =
          (hint === null ? undefined : versions.find((entry) => entry.version === hint || entry.version.endsWith(`-${hint}`) || entry.version.endsWith(hint))) ??
          versions.find((entry) => entry.recommended) ??
          versions.find((entry) => entry.stable) ??
          versions[0];
        loaderVersion = pick?.version ?? null;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        notice = notice_('LOADER_VERSION_UNAVAILABLE', 'warn', false, msg('LOADER_VERSION_UNAVAILABLE', { mcVersion, reason: errorMsg(error, msg('IMPORT_UNEXPECTED')) }));
      }
    }
    return { value: { loader: chosen.loader, loaderVersion, mcVersion, evidence: chosen.evidence, evidenceRefs: chosen.evidenceRefs }, notice };
  }

  // ---- review --------------------------------------------------------------------------------

  private async serverRow(serverId: string): Promise<Server> {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    return row;
  }

  private assertStopped(serverId: string): void {
    if (this.options.manager.isRunning(serverId)) {
      throw new AppError(409, 'SERVER_RUNNING', 'The server is running. Please stop it first before its world is replaced.');
    }
  }

  private staged(id: string): Job & { facts: ImportFacts } {
    const job = this.find(id);
    if (job.dto.status !== 'staged' || job.facts === null) {
      throw new AppError(409, 'IMPORT_NOT_READY', job.dto.status === 'failed' ? (job.dto.error ?? 'The import failed.') : 'The import is not ready yet.', undefined, job.dto.status === 'failed' ? { reason: job.dto.errorRef ?? msg('IMPORT_FAILED_GENERIC').ref } : undefined);
    }
    this.touch(job);
    return job as Job & { facts: ImportFacts };
  }

  // mods of the archive that the (replace-mode) server already has
  private async coveredByServer(serverId: string, facts: ImportFacts): Promise<string[]> {
    const rows = await this.options.db.select().from(modsTable).where(eq(modsTable.serverId, serverId));
    return facts.mods
      .filter((mod) =>
        rows.some(
          (row) =>
            (mod.sha512 !== null && row.sha512 === mod.sha512) ||
            (mod.fileName !== null && row.fileName === mod.fileName) ||
            (mod.modId !== null && (normalise(row.name) === normalise(mod.modId) || normalise(row.fileName).includes(normalise(mod.modId)))),
        ),
      )
      .map((mod) => mod.key);
  }

  async review(id: string, requested: ReviewTarget | null): Promise<ImportReviewDto> {
    const job = this.staged(id);
    const { facts } = job;
    let target: ReviewTarget;
    let covered: string[] = [];
    if (job.dto.mode === 'replace' && job.dto.serverId !== null) {
      const server = await this.serverRow(job.dto.serverId);
      target = { loader: server.loader, mcVersion: server.mcVersion };
      covered = await this.coveredByServer(server.id, facts);
    } else {
      if (requested === null) throw new AppError(400, 'VALIDATION_ERROR', 'Loader and Minecraft version are missing.');
      target = requested;
    }
    const proposed = job.dto.analysis?.proposal.loader ?? 'vanilla';
    const modded = job.dto.analysis?.modded ?? false;
    const notices = evaluateNotices(facts, target, proposed, job.dto.mode, modded);
    if (job.dto.mode === 'replace') {
      const missing = modded ? missingNotice(missingMods(facts, { jars: [], install: covered.map((key) => ({ key, projectId: '' })) })) : null;
      if (missing !== null) notices.push(missing);
      return { notices, matches: [], modrinthAvailable: true };
    }
    const result = facts.mods.length === 0 ? { matches: [], modrinthAvailable: true } : await matchMods(facts, { modrinth: this.options.modrinth, target });
    return { notices, matches: result.matches, modrinthAvailable: result.modrinthAvailable };
  }

  private assertAcknowledged(notices: readonly ImportNotice[], acknowledged: readonly string[]): void {
    const error = notices.find((entry) => entry.level === 'error');
    if (error !== undefined) throw new AppError(409, error.code, error.text);
    const pending = notices.filter((entry) => entry.needsConfirm && !acknowledged.includes(entry.code));
    if (pending.length > 0) {
      throw new AppError(409, 'CONFIRMATION_REQUIRED', 'Please confirm the import notices.', { codes: pending.map((entry) => entry.code), notices: pending });
    }
  }

  private validateSelection(facts: ImportFacts, loader: Loader, selection: ModSelection): void {
    const keys = new Map(facts.mods.map((mod) => [mod.key, mod]));
    const used = new Set<string>();
    for (const key of selection.jars) {
      const mod = keys.get(key);
      if (mod === undefined || mod.origin !== 'jar' || mod.path === null) {
        throw new AppError(422, 'IMPORT_SELECTION_INVALID', 'The selection contains a mod file that is not in the archive.');
      }
      if (used.has(key)) throw new AppError(422, 'IMPORT_SELECTION_INVALID', 'A mod file was selected twice.');
      used.add(key);
    }
    for (const entry of selection.install) {
      if (!keys.has(entry.key)) throw new AppError(422, 'IMPORT_SELECTION_INVALID', 'The selection contains an unknown mod.');
      if (used.has(entry.key)) throw new AppError(422, 'IMPORT_SELECTION_INVALID', 'A mod was selected both as a file and from Modrinth.');
      used.add(entry.key);
    }
    if (getLoaderProfile(loader) === null && used.size > 0) {
      throw new AppError(422, 'MODS_NOT_SUPPORTED', 'Vanilla servers do not support mods or plugins.');
    }
  }

  // ---- new server from a world ---------------------------------------------------------------

  async createServer(id: string, input: CreateFromImportInput): Promise<{ server: ServerDto; job: ImportJobDto }> {
    const job = this.staged(id);
    if (job.dto.mode !== 'new') throw new AppError(409, 'IMPORT_MODE', 'This upload is meant for replacing a world.');
    const { facts } = job;
    const { server: spec } = input;
    this.validateSelection(facts, spec.loader, input.selection);
    const target: ReviewTarget = { loader: spec.loader, mcVersion: spec.mcVersion };
    const notices = evaluateNotices(facts, target, job.dto.analysis?.proposal.loader ?? 'vanilla', 'new', job.dto.analysis?.modded ?? false);
    const missing = job.dto.analysis?.modded === true && getLoaderProfile(spec.loader) !== null ? missingNotice(missingMods(facts, input.selection)) : null;
    if (missing !== null) notices.push(missing);
    this.assertAcknowledged(notices, input.acknowledged);

    job.dto.status = 'applying';
    job.dto.phase = 'create';
    setMessage(job, msg('IMPORT_STEP_CREATE'));
    let server: ServerDto;
    try {
      server = await this.options.servers.create({ ...spec, eulaAccepted: spec.eulaAccepted ?? false } as CreateServerInput);
    } catch (error) {
      job.dto.status = 'staged';
      job.dto.phase = null;
      setMessage(job, null);
      throw error;
    }
    job.dto.serverId = server.id;
    this.launch(job, () => this.finishNew(job, facts, server, input));
    return { server, job: this.snapshot(job) };
  }

  private async finishNew(job: Job, facts: ImportFacts, server: ServerDto, input: CreateFromImportInput): Promise<void> {
    const serverDir = path.join(this.options.serversDir, server.id);
    const result: ImportResultDto = { serverId: server.id, folders: [], jarsPlaced: [], modsInstalled: [], modsFailed: [], safetyBackupId: null, warnings: [], warningRefs: [] };
    const warn = (warning: Msg): void => {
      result.warnings.push(warning.text);
      result.warningRefs.push(warning.ref);
    };
    try {
      job.dto.phase = 'world';
      setMessage(job, msg('IMPORT_STEP_WORLD'));
      const out = path.join(job.dir, 'out');
      const built = await buildOutput(facts.world, styleForLoader(server.loader), DEFAULT_LEVEL, out);
      const player = await convertSingleplayerPlayer(path.join(out, DEFAULT_LEVEL), facts.level).catch(() => null);
      if (player !== null) warn(msg('IMPORT_WARN_SINGLEPLAYER'));
      this.checkpoint();
      for (const folder of built.folders) {
        const target = path.join(serverDir, folder);
        await rm(target, { recursive: true, force: true });
        await moveDir(path.join(out, folder), target);
        result.folders.push(folder);
      }
      if (input.importConfig) await this.copyConfig(facts, serverDir, server.port, result, warn);

      const profile = getLoaderProfile(server.loader);
      if (profile !== null && input.selection.jars.length > 0) {
        job.dto.phase = 'mods';
        setMessage(job, msg('IMPORT_STEP_MOD_FILES'));
        const targetDir = path.join(serverDir, profile.contentDir);
        await mkdir(targetDir, { recursive: true });
        for (const key of input.selection.jars) {
          const mod = facts.mods.find((entry) => entry.key === key) as FactMod;
          try {
            const name = sanitizeJarName(mod.fileName ?? '');
            const diskName = mod.enabled ? name : `${name}${DISABLED_SUFFIX}`;
            await moveDir(mod.path as string, path.join(targetDir, diskName));
            result.jarsPlaced.push(name);
          } catch (error) {
            const reason = errorMsg(error, msg('IMPORT_MOD_FILE_FAILED'));
            result.modsFailed.push({ name: mod.name, reason: reason.text, reasonRef: reason.ref });
          }
        }
      }

      if (profile !== null && (result.jarsPlaced.length > 0 || input.selection.install.length > 0)) {
        job.dto.phase = 'install';
        setMessage(job, msg('IMPORT_STEP_WAIT_INSTALL'));
        // both calls queue behind the installation, which holds the server's lock
        if (result.jarsPlaced.length > 0) {
          try {
            const report = await this.options.mods.scan(server.id);
            report.warnings.forEach((text, index) => {
              result.warnings.push(text);
              result.warningRefs.push(report.warningRefs[index] ?? null);
            });
          } catch (error) {
            warn(error instanceof AppError ? msg('IMPORT_WARN_MODLIST_REASON', { reason: errorMsg(error, msg('IMPORT_WARN_MODLIST')) }) : msg('IMPORT_WARN_MODLIST'));
          }
        }
        for (const entry of input.selection.install) {
          const mod = facts.mods.find((candidate) => candidate.key === entry.key) as FactMod;
          setMessage(job, msg('IMPORT_STEP_MOD_INSTALL', { name: mod.name }));
          try {
            await this.options.mods.install(server.id, entry.projectId, entry.versionId);
            result.modsInstalled.push(mod.name);
          } catch (error) {
            if (error instanceof AppError && error.code === 'MOD_ALREADY_INSTALLED') {
              result.modsInstalled.push(mod.name);
              continue;
            }
            const reason = errorMsg(error, msg('IMPORT_MOD_INSTALL_FAILED'));
            result.modsFailed.push({ name: mod.name, reason: reason.text, reasonRef: reason.ref });
          }
        }
      }
      await rm(job.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      job.dto.result = result;
      job.dto.status = 'done';
      job.dto.phase = null;
      setMessage(job, null);
      this.touch(job);
    } catch (error) {
      const reason = errorMsg(error, msg('UNEXPECTED_ERROR'));
      const partial = msg('IMPORT_PARTIAL', { name: server.name, reason });
      throw new AppError(
        error instanceof AppError ? error.statusCode : 500,
        error instanceof AppError ? error.code : 'IMPORT_FAILED',
        partial.text,
        undefined,
        undefined,
        partial.ref,
      );
    }
  }

  private async copyConfig(facts: ImportFacts, serverDir: string, port: number, result: ImportResultDto, warn: (warning: Msg) => void): Promise<void> {
    const { world } = facts;
    if (world.kind === 'world') return;
    for (const item of world.configItems) {
      const source = path.join(world.root, item);
      const target = path.join(serverDir, item);
      if (item === 'server.properties') continue;
      try {
        await cp(source, target, { recursive: true, force: true });
      } catch {
        warn(msg('IMPORT_WARN_ITEM', { item }));
      }
    }
    if (world.propertiesFile !== null) {
      try {
        await copyFile(world.propertiesFile, path.join(serverDir, 'server.properties'));
        const { doc } = await loadProperties(serverDir);
        doc.set('level-name', DEFAULT_LEVEL);
        doc.set('server-port', String(port));
        doc.set('query.port', String(port));
        await saveProperties(serverDir, doc);
      } catch {
        warn(msg('IMPORT_WARN_PROPERTIES'));
      }
    }
  }

  // ---- replacing the world of an existing server --------------------------------------------

  async replaceWorld(serverId: string, importId: string, input: ReplaceInput): Promise<ImportJobDto> {
    const job = this.staged(importId);
    if (job.dto.mode !== 'replace' || job.dto.serverId !== serverId) {
      throw new AppError(409, 'IMPORT_MODE', 'This upload does not belong to this server.');
    }
    await this.serverRow(serverId);
    this.assertStopped(serverId);
    if (this.options.backups.isBusy(serverId)) throw new AppError(409, 'BACKUP_IN_PROGRESS', 'A backup is currently running for this server.');
    const review = await this.review(importId, null);
    const notices = review.notices;
    this.assertAcknowledged(notices, input.acknowledged);
    job.dto.status = 'applying';
    job.dto.phase = 'prepare';
    setMessage(job, msg('IMPORT_STEP_REPLACE'));
    this.launch(job, () => this.options.lock.run(serverId, () => this.finishReplace(job, job.facts as ImportFacts, serverId)));
    return this.snapshot(job);
  }

  private async finishReplace(job: Job, facts: ImportFacts, serverId: string): Promise<void> {
    const server = await this.serverRow(serverId);
    this.assertStopped(serverId);
    const serverDir = path.join(this.options.serversDir, serverId);
    const level = await readLevelName(serverDir);
    const result: ImportResultDto = { serverId, folders: [], jarsPlaced: [], modsInstalled: [], modsFailed: [], safetyBackupId: null, warnings: [], warningRefs: [] };
    const staging = path.join(serverDir, `.import-new-${randomUUID()}`);
    const trash = path.join(serverDir, `.import-old-${randomUUID()}`);
    let swapped = false;
    this.options.manager.announce(serverId, msg('IMPORT_ANNOUNCE_REPLACING'));
    try {
      await assertFreeSpace(this.freeSpace, serverDir, await this.replaceNeeds(job.dir, serverDir, level), 'world-replace');

      job.dto.phase = 'safety';
      setMessage(job, msg('IMPORT_STEP_SAFETY'));
      const safety = await this.options.backups.safetyBackupLocked(serverId, msg('BACKUP_NOTE_BEFORE_IMPORT'));
      result.safetyBackupId = safety?.id ?? null;
      this.checkpoint();

      job.dto.phase = 'world';
      setMessage(job, msg('IMPORT_STEP_WORLD'));
      const out = path.join(job.dir, 'out');
      const built = await buildOutput(facts.world, styleForLoader(server.loader), level, out);
      const player = await convertSingleplayerPlayer(path.join(out, level), facts.level).catch(() => null);
      if (player !== null) {
        result.warnings.push(msg('IMPORT_WARN_SINGLEPLAYER').text);
        result.warningRefs.push(msg('IMPORT_WARN_SINGLEPLAYER').ref);
      }
      await mkdir(staging, { recursive: true });
      for (const folder of built.folders) await moveDir(path.join(out, folder), path.join(staging, folder));
      this.checkpoint();

      job.dto.phase = 'swap';
      setMessage(job, msg('IMPORT_STEP_SWAP'));
      await swapWorlds(serverDir, staging, trash, built.folders, [...worldNames(level)]);
      swapped = true;
      // the old data is only needed until the swap succeeded; leftovers must be gone before the job reports "done"
      await rm(trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error: unknown) =>
        this.logger.warn({ err: error, serverId }, 'Old world data could not be removed after the import'),
      );
      await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      await rm(job.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      result.folders = built.folders;
      job.dto.result = result;
      job.dto.status = 'done';
      job.dto.phase = null;
      setMessage(job, null);
      this.touch(job);
      this.options.manager.announce(serverId, msg('IMPORT_ANNOUNCE_REPLACED'));
    } catch (error) {
      this.options.manager.announce(serverId, msg('IMPORT_ANNOUNCE_FAILED', { reason: errorMsg(error, msg('UNEXPECTED_ERROR')) }));
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      if (swapped) {
        await rm(trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error: unknown) =>
          this.logger.warn({ err: error, serverId }, 'Old world data could not be removed after the import'),
        );
        await rm(job.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
      } else {
        // only succeeds on an empty folder, which is the case once everything has been put back
        await rmdir(trash).catch(() => undefined);
      }
    }
  }

  // What replacing a world needs on the volume of the server folder, checked before anything is written: moving the
  // staged world into place is a rename on the same volume (nothing extra) and a full copy on another one, and the
  // safety backup of the old world takes its (barely compressed) size on the backup volume. The old world stays in
  // place until the swap, so a 50 GB world can need 45 GB for the backup plus, across volumes, another 50 GB.
  private async replaceNeeds(stagedDir: string, serverDir: string, level: string): Promise<number> {
    const staged = await this.sizeOf(stagedDir);
    let old = 0;
    for (const name of worldNames(level)) old += await this.sizeOf(path.join(serverDir, name));
    const backupBytes = Math.ceil(old * WORLD_COMPRESSION_ESTIMATE);
    const sameAsStaging = await sameVolume(stagedDir, serverDir);
    const sameAsBackups = await sameVolume(this.options.backups.directory, serverDir);
    return (sameAsStaging === true ? 0 : staged) + (sameAsBackups === true || sameAsBackups === null ? backupBytes : 0) + 64 * MIB;
  }

  private async sizeOf(dir: string): Promise<number> {
    let total = 0;
    const visit = async (current: string, depth: number): Promise<void> => {
      if (depth > 64) return;
      for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(full, depth + 1);
        else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
      }
    };
    await visit(dir, 0);
    return total;
  }
}
