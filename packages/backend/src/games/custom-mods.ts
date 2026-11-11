import { randomUUID } from 'node:crypto';
import { cp, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { servers, type Server } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import type { KeyedLock } from '../lib/keyed-lock.js';
import { assertFreeSpace, freeBytes, sizeText, type FreeSpaceReader } from '../lib/disk.js';
import { receiveToFile } from '../lib/receive.js';
import { getLoaderProfile } from '../mods/profile.js';
import type { ServerRuntimeGuard } from '../mods/runtime-guard.js';
import { stageArchive } from '../worldio/staging.js';
import { isDir, isFile } from '../worldio/game-world.js';
import type { GameAdapters } from './adapters.js';
import type { CustomMod, CustomModSupport, CustomModsView } from './types.js';

export type { CustomMod, CustomModSupport, CustomModsView } from './types.js';

const MIB = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,119}$/;

export const folderSize = async (target: string): Promise<number> => {
  const info = await stat(target).catch(() => null);
  if (info === null) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    total += await folderSize(path.join(target, entry.name));
  }
  return total;
};

// a mod folder is replaced as a whole: what an older version had must not stay
export async function placeFolder(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  const old = `${to}.old-${randomUUID().slice(0, 8)}`;
  const had = await isDir(to);
  if (had) await rename(to, old);
  try {
    await cp(from, to, { recursive: true });
  } catch (error) {
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    if (had) await rename(old, to).catch(() => undefined);
    throw error;
  }
  if (had) await rm(old, { recursive: true, force: true });
}

export const safeFolderName = (name: string, what: string): string => {
  if (!SAFE_NAME.test(name) || name.endsWith('.') || name.endsWith(' ')) {
    throw new AppError(422, 'CUSTOM_MOD_INVALID', `The ${what} "${name.slice(0, 60)}" has characters that cannot be used as a folder name.`, undefined, { name: name.slice(0, 60) });
  }
  return name;
};

export const invalidMod = (game: string, what: string): AppError =>
  new AppError(422, 'CUSTOM_MOD_INVALID', `No ${game} mod was found in the file. Expected: ${what}.`, undefined, { game, what });


export interface CustomModsServiceOptions {
  db: Db;
  serversDir: string;
  tmpDir: string;
  lock: KeyedLock;
  guard: ServerRuntimeGuard;
  games: GameAdapters;
  maxUploadBytes: number;
  // Minecraft: registers the uploaded jar like a mod put into the folder by hand
  scanMinecraft: (serverId: string) => Promise<unknown>;
  freeSpace?: FreeSpaceReader;
}

// Upload, list and removal of mods that are not in the mod store of a game. The server must be stopped.
export class CustomModsService {
  private readonly freeSpace: FreeSpaceReader;

  constructor(private readonly options: CustomModsServiceOptions) {
    this.freeSpace = options.freeSpace ?? freeBytes;
  }

  private async server(serverId: string): Promise<Server> {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    return row;
  }

  private dir(server: Server): string {
    return path.join(this.options.serversDir, server.id);
  }

  private support(server: Server): CustomModSupport | null {
    if (server.game === 'minecraft') {
      const profile = getLoaderProfile(server.loader);
      if (profile === null) return null;
      return {
        accept: '.jar',
        list: async () => [],
        install: async () => [],
        remove: async () => undefined,
      };
    }
    return this.options.games.forServer(server).customMods ?? null;
  }

  private assertStopped(serverId: string): void {
    if (this.options.guard.isRunning(serverId)) throw new AppError(409, 'SERVER_RUNNING', 'The server is running. Please stop it before changing its mods.');
  }

  async list(serverId: string): Promise<CustomModsView> {
    const server = await this.server(serverId);
    const support = this.support(server);
    if (support === null) return { supported: false, accept: '', mods: [] };
    return { supported: true, accept: support.accept, mods: server.game === 'minecraft' ? [] : await support.list(server, this.dir(server)) };
  }

  async upload(serverId: string, stream: Readable, input: { contentLength: number | null; fileName: string }): Promise<CustomModsView & { installed: CustomMod[] }> {
    const max = this.options.maxUploadBytes;
    const tooLarge = (): AppError => new AppError(413, 'IMPORT_TOO_LARGE', `The file is too large (at most ${sizeText(max)}). The limit can be adjusted with IMPORT_MAX_MB.`, undefined, { max: sizeText(max) });
    if (input.contentLength !== null && input.contentLength > max) throw tooLarge();
    const server = await this.server(serverId);
    const support = this.support(server);
    if (support === null) throw new AppError(409, 'MODS_NOT_SUPPORTED', 'This server cannot load mods. Vanilla Minecraft has no mod loader.');
    if (server.installState !== 'installed') throw new AppError(409, 'SERVER_NOT_INSTALLED', 'The server is not installed yet.');
    this.assertStopped(serverId);

    const work = path.join(this.options.tmpDir, randomUUID());
    try {
      await mkdir(work, { recursive: true });
      await assertFreeSpace(this.freeSpace, this.options.tmpDir, (input.contentLength ?? 64 * MIB) * 3 + 64 * MIB, 'upload');
      const upload = path.join(work, 'upload.bin');
      await receiveToFile(stream, upload, max, tooLarge);
      if (server.game === 'minecraft') return await this.minecraftJar(server, upload, input.fileName);

      const staged = path.join(work, 'staged');
      await mkdir(staged, { recursive: true });
      await stageArchive(upload, staged, { maxBytes: max * 4, maxEntries: 200_000, maxRatio: 200 }, this.freeSpace, () => undefined);
      const installed = await this.options.lock.run(serverId, async () => {
        this.assertStopped(serverId);
        return support.install(server, this.dir(server), staged);
      });
      return { ...(await this.list(serverId)), installed };
    } finally {
      await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    }
  }

  // A jar goes into mods/ or plugins/ and is then registered by the scan, like a jar put there by hand
  private async minecraftJar(server: Server, upload: string, fileName: string): Promise<CustomModsView & { installed: CustomMod[] }> {
    const profile = getLoaderProfile(server.loader);
    if (profile === null) throw new AppError(409, 'MODS_NOT_SUPPORTED', 'This server cannot load mods. Vanilla Minecraft has no mod loader.');
    const name = path.basename(fileName.replace(/\\/g, '/'));
    if (!/\.jar$/i.test(name)) throw new AppError(422, 'CUSTOM_MOD_INVALID', 'Please upload a .jar file.');
    safeFolderName(name, 'file name');
    const handle = await open(upload, 'r');
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0).finally(() => handle.close());
    if (head[0] !== 0x50 || head[1] !== 0x4b) throw new AppError(422, 'CUSTOM_MOD_INVALID', 'The file is not a valid .jar (a jar is a zip archive).');
    const target = path.join(this.dir(server), profile.contentDir, name);
    await this.options.lock.run(server.id, async () => {
      this.assertStopped(server.id);
      if ((await isFile(target)) || (await isFile(`${target}.disabled`))) {
        throw new AppError(409, 'MOD_ALREADY_INSTALLED', `A file named "${name}" is already in ${profile.contentDir}/. Delete it first to replace it.`, undefined, { name });
      }
      await mkdir(path.dirname(target), { recursive: true });
      await cp(upload, target);
    });
    await this.options.scanMinecraft(server.id);
    const size = (await stat(target)).size;
    return { supported: true, accept: '.jar', mods: [], installed: [{ id: name, name, location: `${profile.contentDir}/${name}`, sizeBytes: size, active: true }] };
  }

  async remove(serverId: string, id: string): Promise<CustomModsView> {
    const server = await this.server(serverId);
    const support = this.support(server);
    if (support === null || server.game === 'minecraft') throw new AppError(409, 'MODS_NOT_SUPPORTED', 'Minecraft mods are removed on the Mods tab.');
    this.assertStopped(serverId);
    await this.options.lock.run(serverId, async () => {
      this.assertStopped(serverId);
      const known = await support.list(server, this.dir(server));
      if (!known.some((mod) => mod.id === id)) throw new AppError(404, 'MOD_NOT_FOUND', 'The mod was not found.');
      await support.remove(server, this.dir(server), id);
    });
    return this.list(serverId);
  }
}
