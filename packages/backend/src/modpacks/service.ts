import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/client.js';
import type { Server } from '../db/schema.js';
import { extractZip } from '../archive/zip.js';
import { resolveEntry } from '../archive/safe-path.js';
import { AppError } from '../http/errors.js';
import { allowedImageUrl } from '../lib/images.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { msg } from '../messages.js';
import { downloadToTmp, type DownloaderOptions } from '../mods/downloader.js';
import { mapLimit, removeQuietly } from '../mods/files.js';
import { rethrowFsError } from '../mods/fs-errors.js';
import { getLoaderProfile } from '../mods/profile.js';
import { scanServer } from '../mods/scanner.js';
import type { ModrinthApi, Version, VersionFile } from '../modrinth/types.js';
import type { InstallContext } from '../games/types.js';
import type { ModpackHit, ModpackRef, ModpackSearchResponse, ModpackVersionDto } from './types.js';
import { MRPACK_DOWNLOAD_HOSTS, OVERRIDE_DIRS, packTarget, readPackIndex, serverFiles, type PackFile, type PackTarget } from './mrpack.js';

// Folder inside the server directory that holds the pack while the server is created and installed
export type { ModpackHit, ModpackRef, ModpackSearchResponse, ModpackVersionDto };

export const PACK_DIR = '.modpack';
const PACK_FILE = 'pack.mrpack';
const DOWNLOAD_CONCURRENCY = 4;
const MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_OVERRIDE_ENTRIES = 50_000;

export interface PreparedPack {
  ref: ModpackRef;
  target: PackTarget;
}

export interface ModpackServiceOptions {
  db: Db;
  modrinth: ModrinthApi;
  downloader: DownloaderOptions;
  logger?: Logger;
}

const SUPPORTED_LOADERS = new Set(['fabric', 'forge', 'neoforge']);

export function parseModpackRef(raw: string | null): ModpackRef | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<ModpackRef>;
    if (typeof value.projectId !== 'string' || typeof value.versionId !== 'string') return null;
    return {
      projectId: value.projectId,
      versionId: value.versionId,
      title: typeof value.title === 'string' ? value.title : value.projectId,
      versionNumber: typeof value.versionNumber === 'string' ? value.versionNumber : '',
      iconUrl: allowedImageUrl(value.iconUrl),
    };
  } catch {
    return null;
  }
}

const packFileOf = (version: Version): VersionFile | undefined => {
  const packs = version.files.filter((file) => file.filename.toLowerCase().endsWith('.mrpack'));
  return packs.find((file) => file.primary) ?? packs[0];
};

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

// Modpacks from Modrinth: search, versions, and the files of a pack on a new server.
export class ModpackService {
  private readonly logger: Logger;

  constructor(private readonly options: ModpackServiceOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  async search(query: string, offset: number, limit: number): Promise<ModpackSearchResponse> {
    const result = await this.options.modrinth.search({
      query,
      facets: [['project_type:modpack'], ['server_side:required', 'server_side:optional']],
      index: query.trim() === '' ? 'downloads' : 'relevance',
      limit,
      offset,
    });
    return {
      totalHits: result.total_hits,
      hits: result.hits.map((hit) => ({
        projectId: hit.project_id,
        slug: hit.slug,
        title: hit.title,
        description: hit.description,
        author: hit.author,
        downloads: hit.downloads,
        iconUrl: allowedImageUrl(hit.icon_url),
        categories: hit.categories,
      })),
    };
  }

  async versions(projectId: string): Promise<ModpackVersionDto[]> {
    const project = await this.options.modrinth.getProject(projectId);
    if (project.project_type !== 'modpack') throw new AppError(422, 'MODPACK_NOT_A_PACK', 'This Modrinth project is not a modpack.');
    const versions = await this.options.modrinth.listProjectVersions(project.id, [], []);
    return versions
      .filter((version) => packFileOf(version) !== undefined)
      .sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published))
      .map((version) => ({
        id: version.id,
        name: version.name,
        versionNumber: version.version_number,
        versionType: version.version_type,
        datePublished: version.date_published,
        gameVersions: version.game_versions,
        loaders: version.loaders,
        supported: version.loaders.length === 0 || version.loaders.some((loader) => SUPPORTED_LOADERS.has(loader)),
      }));
  }

  // Downloads the pack of a new server into <dir>/.modpack and reads which loader and versions it needs.
  async prepare(projectId: string, versionId: string, dir: string, signal?: AbortSignal): Promise<PreparedPack> {
    const { modrinth } = this.options;
    const version = await modrinth.getVersion(versionId);
    if (version.project_id !== projectId) throw new AppError(422, 'MODPACK_VERSION_MISMATCH', 'The version does not belong to this modpack.');
    const project = await modrinth.getProject(projectId);
    if (project.project_type !== 'modpack') throw new AppError(422, 'MODPACK_NOT_A_PACK', 'This Modrinth project is not a modpack.');
    const file = packFileOf(version);
    if (file === undefined) throw new AppError(422, 'MODPACK_INVALID', 'The modpack is not a valid Modrinth modpack (no .mrpack file).', undefined, { detail: 'no .mrpack file' });
    if (file.size > MAX_PACK_BYTES) throw new AppError(422, 'ARCHIVE_TOO_LARGE', 'The archive is larger than allowed.', undefined, { maxMb: MAX_PACK_BYTES / 1024 / 1024 });

    const packDir = path.join(dir, PACK_DIR);
    await mkdir(packDir, { recursive: true });
    const part = await downloadToTmp(
      {
        url: file.url,
        fileName: PACK_FILE,
        fileKind: 'any',
        size: file.size,
        ...(file.hashes.sha512 === undefined ? {} : { hash: { algorithm: 'sha512' as const, value: file.hashes.sha512 } }),
        allowedHosts: ['cdn.modrinth.com'],
        requireZip: true,
      },
      packDir,
      { ...this.options.downloader, ...(signal === undefined ? {} : { signal }) },
    );
    const target = path.join(packDir, PACK_FILE);
    await rename(part, target);
    const index = await readPackIndex(target);
    return {
      target: packTarget(index),
      ref: { projectId: project.id, versionId: version.id, title: project.title, versionNumber: version.version_number, iconUrl: allowedImageUrl(project.icon_url) },
    };
  }

  // Puts the files of the pack into an installed server: the downloads, then overrides/ and server-overrides/.
  async install(server: Server, ref: ModpackRef, ctx: InstallContext): Promise<void> {
    const { dir, log, progress, signal } = ctx;
    const packDir = path.join(dir, PACK_DIR);
    const archive = path.join(packDir, PACK_FILE);
    if (!(await exists(archive))) {
      log(`Downloading the modpack ${ref.title} ${ref.versionNumber} ...`);
      await this.prepare(ref.projectId, ref.versionId, dir, signal);
    }
    const index = await readPackIndex(archive);
    const files = serverFiles(index);
    log(`Modpack ${index.name} ${index.versionId}: ${files.length} files for the server (${index.files.length - files.length} client-only files skipped)`);

    const downloader = { ...this.options.downloader, signal };
    const tmpDir = path.join(packDir, 'tmp');
    let done = 0;
    progress('modpack', 0, msg('MODPACK_STEP_FILES', { done, total: files.length }));
    await mapLimit(files, DOWNLOAD_CONCURRENCY, async (file) => {
      signal.throwIfAborted();
      await this.downloadFile(file, dir, tmpDir, downloader);
      done++;
      progress('modpack', Math.min(99, Math.floor((done / Math.max(1, files.length)) * 100)), msg('MODPACK_STEP_FILES', { done, total: files.length }));
    });
    log(`Downloaded ${files.length} files (SHA-512 verified)`);

    progress('modpack', null, msg('MODPACK_STEP_OVERRIDES'));
    const unpacked = path.join(packDir, 'unpacked');
    await extractZip(archive, unpacked, { maxBytes: MAX_PACK_BYTES * 2, maxEntries: MAX_OVERRIDE_ENTRIES, checkpoint: () => signal.throwIfAborted() });
    for (const name of OVERRIDE_DIRS) {
      const source = path.join(unpacked, name);
      if (!(await exists(source))) continue;
      const count = (await readdir(source)).length;
      try {
        await cp(source, dir, { recursive: true, force: true, errorOnExist: false, verbatimSymlinks: true });
      } catch (error) {
        rethrowFsError(error, name);
      }
      log(`Copied ${name}/ (${count} entries)`);
    }
    await rm(packDir, { recursive: true, force: true }).catch(() => undefined);

    // registers the mods, so the mod list knows them as Modrinth projects (updates, dependencies)
    const profile = getLoaderProfile(server.loader);
    if (profile !== null) {
      try {
        const report = await scanServer({ db: this.options.db, modrinth: this.options.modrinth, profile, serverDir: dir, serverId: server.id });
        log(`Mod list: ${report.added} mods recognised`);
      } catch (error) {
        this.logger.warn({ err: error, serverId: server.id }, 'Modpack: the mods could not be scanned');
        log('Note: the mod list could not be read now; it is read again when the mods page is opened.');
      }
    }
  }

  private async downloadFile(file: PackFile, dir: string, tmpDir: string, downloader: DownloaderOptions): Promise<void> {
    const { target } = resolveEntry(dir, file.path);
    let lastError: unknown = null;
    for (const url of file.downloads) {
      try {
        const part = await downloadToTmp(
          {
            url,
            fileName: path.basename(target),
            fileKind: 'any',
            size: file.fileSize,
            hash: { algorithm: 'sha512', value: file.hashes.sha512 },
            allowedHosts: MRPACK_DOWNLOAD_HOSTS,
          },
          tmpDir,
          downloader,
        );
        try {
          await mkdir(path.dirname(target), { recursive: true });
          await rm(target, { force: true });
          await rename(part, target);
        } catch (error) {
          await removeQuietly(part);
          rethrowFsError(error, file.path);
        }
        return;
      } catch (error) {
        lastError = error;
        if (downloader.signal?.aborted === true) throw error;
      }
    }
    throw lastError ?? new AppError(502, 'DOWNLOAD_FAILED', 'The download could not be started.');
  }
}
