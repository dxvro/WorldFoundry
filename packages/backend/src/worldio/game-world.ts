import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { BackupService, RestoreResult } from '../backups/service.js';
import { MANIFEST_NAME, type BackupLayout } from '../backups/world.js';
import type { Db } from '../db/client.js';
import { servers, type Server } from '../db/schema.js';
import type { GameAdapters } from '../games/adapters.js';
import { gameDefinition } from '../games/registry.js';
import { GAME_IDS, type PreparedWorld, type WorldImportContext } from '../games/types.js';
import { AppError } from '../http/errors.js';
import { assertFreeSpace, freeBytes, sizeText, type FreeSpaceReader } from '../lib/disk.js';
import { receiveToFile } from '../lib/receive.js';
import { msg, type Msg } from '../messages.js';
import type { ProcessManager } from '../process/manager.js';
import { stageArchive } from './staging.js';

// The description inside a world export of a game other than Minecraft (Minecraft keeps worldfoundry-export.json)
export const GAME_EXPORT_MANIFEST_NAME = 'worldfoundry-game-export.json';

export const GameExportManifestSchema = z.object({
  format: z.literal(1),
  kind: z.literal('worldfoundry-game-world'),
  game: z.enum(GAME_IDS),
  appVersion: z.string().max(64),
  createdAt: z.string().max(40),
  source: z.enum(['server', 'backup']),
  server: z.object({ name: z.string().max(200) }),
  levelName: z.string().min(1).max(100),
  worlds: z.array(z.string().min(1).max(120)).max(10),
  configItems: z.array(z.string().min(1).max(200)).max(100),
});
export type GameExportManifest = z.infer<typeof GameExportManifestSchema>;

// the description of a backup archive (backups/service.ts), read when someone uploads a downloaded backup
const BackupManifestSchema = z.object({
  levelName: z.string().min(1).max(100),
  worlds: z.array(z.string().min(1).max(120)).max(10),
  configItems: z.array(z.string().min(1).max(200)).max(100),
});

const MIB = 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_ENTRIES = 2_000_000;
const UNPACK_FACTOR = 4;
const MAX_RATIO = 200;

// ---- helpers for the game modules -----------------------------------------------------------

const kind = (file: string): Promise<'file' | 'dir' | null> =>
  lstat(file).then(
    (info) => (info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null),
    () => null,
  );

export const isDir = async (file: string): Promise<boolean> => (await kind(file)) === 'dir';
export const isFile = async (file: string): Promise<boolean> => (await kind(file)) === 'file';

// Folders below `root` (itself included) for which `match` is true, breadth first, never following symlinks
export async function findDirs(root: string, match: (dir: string, files: string[]) => boolean | Promise<boolean>, limit = 50): Promise<string[]> {
  const found: string[] = [];
  let level = [root];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && found.length < limit; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      if (await match(dir, files)) found.push(dir);
      for (const entry of entries) if (entry.isDirectory()) next.push(path.join(dir, entry.name));
    }
    level = next.sort();
  }
  return found;
}

// every regular file below `root` whose name passes `match`
export async function findFiles(root: string, match: (name: string) => boolean, limit = 1000): Promise<string[]> {
  const found: string[] = [];
  await findDirs(root, (dir, files) => {
    for (const name of files) if (found.length < limit && match(name)) found.push(path.join(dir, name));
    return false;
  });
  return found;
}

export async function moveInto(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
}

export const noWorld = (game: string, what: string): AppError =>
  new AppError(422, 'IMPORT_NO_WORLD', `No ${game} world was found in the file. Expected: ${what}.`, undefined, { game, what });

// ---- the import ------------------------------------------------------------------------------

export interface GameWorldServiceOptions {
  db: Db;
  serversDir: string;
  tmpDir: string;
  games: GameAdapters;
  backups: BackupService;
  manager: ProcessManager;
  maxUploadBytes: number;
  freeSpace?: FreeSpaceReader;
}

export interface GameImportResult extends RestoreResult {
  imported: { worlds: string[]; configItems: string[] };
}

const safeFileName = (name: string): string => {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._ -]/g, '_').trim();
  return base === '' || base.startsWith('.') ? 'upload' : base.slice(0, 120);
};

// Takes a world of Project Zomboid, Satisfactory or ARK from an uploaded file into a stopped server. The file is turned
// into a backup of the server and restored like one: the current world is kept as a safety backup first.
export class GameWorldService {
  private readonly freeSpace: FreeSpaceReader;
  private readonly running = new Set<string>();

  constructor(private readonly options: GameWorldServiceOptions) {
    this.freeSpace = options.freeSpace ?? freeBytes;
  }

  // true while an upload is being taken over; an update waits for it
  get busy(): boolean {
    return this.running.size > 0;
  }

  // leftovers of imports that a shutdown interrupted
  async recoverInterrupted(): Promise<void> {
    await rm(this.options.tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }

  private async serverRow(serverId: string): Promise<Server> {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    return row;
  }

  private assertReady(server: Server): void {
    if (server.game === 'minecraft') {
      throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', 'Minecraft worlds are imported with "Replace world".', undefined, { game: gameDefinition('minecraft').name });
    }
    if (this.options.games.forServer(server).worldImport === undefined) {
      const name = gameDefinition(server.game).name;
      throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', `This part of WorldFoundry is not available for ${name} servers yet.`, undefined, { game: name });
    }
    if (server.installState !== 'installed') throw new AppError(409, 'SERVER_NOT_INSTALLED', 'The server is not installed yet.');
    if (this.options.manager.isRunning(server.id)) {
      throw new AppError(409, 'SERVER_RUNNING', 'The server is running. Please stop it first before a world is imported.');
    }
  }

  async importUpload(serverId: string, stream: Readable, input: { contentLength: number | null; fileName: string }): Promise<GameImportResult> {
    const max = this.options.maxUploadBytes;
    const maxText = sizeText(max);
    const tooLarge = (): AppError => new AppError(413, 'IMPORT_TOO_LARGE', `The file is too large (at most ${maxText}). The limit can be adjusted with IMPORT_MAX_MB.`, undefined, { max: maxText });
    if (input.contentLength !== null && input.contentLength > max) throw tooLarge();
    const server = await this.serverRow(serverId);
    this.assertReady(server);
    if (this.running.has(serverId)) throw new AppError(409, 'IMPORT_IN_PROGRESS', 'An import is already running for this server.');
    this.running.add(serverId);
    const work = path.join(this.options.tmpDir, randomUUID());
    try {
      await mkdir(work, { recursive: true });
      await assertFreeSpace(this.freeSpace, this.options.tmpDir, (input.contentLength ?? 64 * MIB) * 3 + 128 * MIB, 'upload');
      const upload = path.join(work, 'upload.bin');
      await receiveToFile(stream, upload, max, tooLarge);

      const adapter = this.options.games.forServer(server);
      const support = adapter.worldImport;
      if (support === undefined) throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', 'This game has no world import.');
      const dir = path.join(this.options.serversDir, server.id);
      const ctx: WorldImportContext = { server, dir, layout: await adapter.backupLayout(server, dir) };
      const staged = path.join(work, 'staged');
      const fileName = safeFileName(input.fileName);
      await mkdir(staged, { recursive: true });
      if (support.singleFile?.(fileName) === true) {
        await rename(upload, path.join(staged, fileName));
      } else {
        await stageArchive(upload, staged, { maxBytes: max * UNPACK_FACTOR, maxEntries: MAX_ENTRIES, maxRatio: MAX_RATIO }, this.freeSpace, () => undefined);
        await rm(upload, { force: true });
      }

      const out = path.join(work, 'world');
      await mkdir(out, { recursive: true });
      const prepared = await this.prepare(staged, out, ctx);
      if (prepared.worlds.length === 0) throw noWorld(gameDefinition(server.game).name, 'a save game');

      // the server must still be stopped: the upload can take a while
      this.assertReady(await this.serverRow(serverId));
      const backup = await this.options.backups.storeFolder(serverId, out, msg('GAME_IMPORT_NOTE', { fileName }));
      const restored = await this.options.backups.restore(serverId, backup.id);
      const after = (await support.after?.({ ...ctx, server: await this.serverRow(serverId) })) ?? [];
      const warnings = [...prepared.warnings, ...after];
      return {
        ...restored,
        warnings: [...restored.warnings, ...warnings.map((warning) => warning.text)],
        warningRefs: [...restored.warningRefs, ...warnings.map((warning) => warning.ref)],
        imported: { worlds: prepared.worlds, configItems: prepared.configItems },
      };
    } finally {
      this.running.delete(serverId);
      await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    }
  }

  // A WorldFoundry export or backup is taken as it is; anything else is searched for the game's own save format
  private async prepare(staged: string, out: string, ctx: WorldImportContext): Promise<PreparedWorld> {
    const support = this.options.games.forServer(ctx.server).worldImport;
    if (support === undefined) throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', 'This game has no world import.');
    // an archive often wraps everything in one folder
    let root = staged;
    for (let depth = 0; depth < 3; depth++) {
      const entries = await readdir(root, { withFileTypes: true });
      if (entries.length === 1 && entries[0]?.isDirectory() === true) root = path.join(root, entries[0].name);
      else break;
    }
    const described = await this.readDescription(root, ctx);
    if (described === null) return support.native(staged, out, ctx);

    const allowedWorlds = new Set(ctx.layout.worlds(described.levelName));
    const allowedConfig = new Set([...ctx.layout.configFiles, ...ctx.layout.configDirs]);
    const valid = described.worlds.every((name) => allowedWorlds.has(name)) && described.configItems.every((name) => allowedConfig.has(name));
    if (!valid) throw new AppError(422, 'BACKUP_INVALID', 'The file contains unexpected files and is not imported for security reasons.');
    const worlds: string[] = [];
    const configItems: string[] = [];
    for (const name of described.worlds) {
      if ((await kind(path.join(root, name))) === null) continue;
      await moveInto(path.join(root, name), path.join(out, name));
      worlds.push(name);
    }
    for (const name of described.configItems) {
      if ((await kind(path.join(root, name))) === null) continue;
      await moveInto(path.join(root, name), path.join(out, name));
      configItems.push(name);
    }
    if (described.levelName !== ctx.layout.levelName) await support.adopt?.(out, described.levelName, ctx);
    return { worlds, configItems, warnings: [] };
  }

  private async readDescription(root: string, ctx: WorldImportContext): Promise<{ levelName: string; worlds: string[]; configItems: string[] } | null> {
    const game = gameDefinition(ctx.server.game).name;
    const exportFile = path.join(root, GAME_EXPORT_MANIFEST_NAME);
    if (await isFile(exportFile)) {
      const parsed = GameExportManifestSchema.safeParse(await readJson(exportFile));
      if (!parsed.success) throw new AppError(422, 'BACKUP_INVALID', `The description ${GAME_EXPORT_MANIFEST_NAME} is damaged.`);
      if (parsed.data.game !== ctx.server.game) {
        const other = gameDefinition(parsed.data.game).name;
        throw new AppError(422, 'IMPORT_WRONG_GAME', `The file holds a ${other} world, but this is a ${game} server.`, undefined, { found: other, game });
      }
      return parsed.data;
    }
    if (await isFile(path.join(root, 'worldfoundry-export.json'))) {
      throw new AppError(422, 'IMPORT_WRONG_GAME', `The file holds a Minecraft world, but this is a ${game} server.`, undefined, { found: 'Minecraft', game });
    }
    const backupFile = path.join(root, MANIFEST_NAME);
    if (await isFile(backupFile)) {
      const parsed = BackupManifestSchema.safeParse(await readJson(backupFile));
      if (!parsed.success) throw new AppError(422, 'BACKUP_INVALID', `The description ${MANIFEST_NAME} is damaged.`);
      try {
        ctx.layout.validateLevel(parsed.data.levelName);
      } catch {
        throw new AppError(422, 'IMPORT_WRONG_GAME', `The backup belongs to another game, but this is a ${game} server.`, undefined, { found: '?', game });
      }
      return parsed.data;
    }
    return null;
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

// Used by the export: the description of a game world archive
export function gameExportManifest(input: { server: Server; source: 'server' | 'backup'; appVersion: string; createdAt: number; layout: BackupLayout; levelName: string; worlds: string[]; configItems: string[] }): Buffer {
  const manifest: GameExportManifest = {
    format: 1,
    kind: 'worldfoundry-game-world',
    game: input.server.game,
    appVersion: input.appVersion,
    createdAt: new Date(input.createdAt).toISOString(),
    source: input.source,
    server: { name: input.server.name },
    levelName: input.levelName,
    worlds: input.worlds,
    configItems: input.configItems,
  };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export type { Msg };
