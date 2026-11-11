import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { extractZip } from '../../archive/zip.js';
import type { BackupLayout } from '../../backups/world.js';
import type { Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { msg } from '../../messages.js';
import { downloadToTmp } from '../../mods/downloader.js';
import type { LineEvent } from '../../process/patterns.js';
import { takenPorts } from '../ports.js';
import { gameDefinition } from '../registry.js';
import { allocatePorts, exists, parseGameSettings, requireProgram, safeText } from '../steam-game.js';
import type { ConfigFile, GameAdapter, InstallContext, StartPlan, WorldImportSupport } from '../types.js';
import { findFiles, moveInto, noWorld } from '../../worldio/game-world.js';

// The official dedicated server comes as one zip per version from terraria.org; the list names the current one.
export const TERRARIA_LIST_URL = 'https://terraria.org/api/get/dedicated-servers-names';
export const terrariaDownloadUrl = (fileName: string): string => `https://terraria.org/api/download/pc-dedicated-server/${fileName}`;
const TERRARIA_HOSTS = ['terraria.org'];
export const DEFAULT_PORT = 7777;

export const binaryDir = (dir: string): string => path.join(dir, 'server');
export const worldsDir = (dir: string): string => path.join(dir, 'worlds');
export const configFile = (dir: string): string => path.join(dir, 'serverconfig.txt');

const WORLD = /^[A-Za-z0-9_ -]{1,40}$/;

export const TerrariaSettingsSchema = z
  .object({
    world: z.string().regex(WORLD),
    // 1 small, 2 medium, 3 large
    size: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    // 0 classic (normal), 1 expert, 2 master, 3 journey
    difficulty: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    maxPlayers: z.number().int().min(1).max(255),
    password: z.string().max(64),
    version: z.string().max(40),
  })
  .strict();
export type TerrariaSettings = z.infer<typeof TerrariaSettingsSchema>;

export const CreateTerrariaSchema = z
  .object({
    game: z.literal('terraria'),
    name: z.string().trim().min(1).max(60),
    world: z.string().regex(WORLD, 'Letters, digits, spaces, _ and - only').default('World'),
    size: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    difficulty: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).default(0),
    maxPlayers: z.number().int().min(1).max(255).default(8),
    password: z.string().max(64).default(''),
    port: z.number().int().min(1024).max(65535).optional(),
  })
  .strict();

export const EditTerrariaSchema = z
  .object({ world: z.string().regex(WORLD), size: TerrariaSettingsSchema.shape.size, difficulty: TerrariaSettingsSchema.shape.difficulty, maxPlayers: z.number().int().min(1).max(255), password: z.string().max(64) })
  .partial()
  .strict();

export const parseTerrariaSettings = (server: Pick<Server, 'gameSettings'>): TerrariaSettings => parseGameSettings(TerrariaSettingsSchema, server);

const READY = /^\s*Server started\s*$/;
const JOIN = /^(.{1,40}) has joined\.$/;
const LEAVE = /^(.{1,40}) has left\.$/;

export function classifyTerrariaLine(line: string): LineEvent | null {
  if (line.length > 400) return null;
  const text = line.replace(/^:\s*/, '').trim();
  if (READY.test(text)) return { type: 'done' };
  const joined = JOIN.exec(text)?.[1];
  if (joined !== undefined) return { type: 'join', name: joined };
  const left = LEAVE.exec(text)?.[1];
  if (left !== undefined) return { type: 'leave', name: left };
  return null;
}

// serverconfig.txt: key=value lines; the keys WorldFoundry owns are written, everything else the user added stays
export function writeConfig(current: string, values: Record<string, string>): string {
  const lines = current === '' ? [] : current.replace(/\r?\n$/, '').split(/\r?\n/);
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const key = /^\s*#?\s*([A-Za-z]+)=/.exec(line)?.[1];
    if (key === undefined || !(key in values) || line.trimStart().startsWith('#')) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) if (!seen.has(key)) next.push(`${key}=${value}`);
  return `${next.join('\n')}\n`;
}

// A world from single player or another server: <name>.wld, maybe with .wld.bak and the .twld of tModLoader
export const terrariaWorldImport: WorldImportSupport = {
  singleFile: (fileName) => /\.wld$/i.test(fileName),
  native: async (staged, out, ctx) => {
    const worlds = await findFiles(staged, (name) => /\.wld$/i.test(name));
    if (worlds.length === 0) throw noWorld('Terraria', 'a world file (<name>.wld), alone or in a .zip');
    const names: string[] = [];
    for (const file of worlds) {
      const base = path.basename(file).replace(/\.wld$/i, '');
      for (const entry of await readdir(path.dirname(file))) {
        if (entry === `${base}.wld` || entry.startsWith(`${base}.wld.`) || entry === `${base}.twld`) await moveInto(path.join(path.dirname(file), entry), path.join(out, 'worlds', entry));
      }
      names.push(base);
    }
    const world = parseTerrariaSettings(ctx.server).world;
    return { worlds: ['worlds'], configItems: [], warnings: names.includes(world) ? [] : [msg('GAME_IMPORT_WORLD_NAME', { found: names.join(', '), current: world })] };
  },
};

export interface TerrariaAdapterOptions {
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  tmpDir: string;
}

export class TerrariaAdapter implements GameAdapter {
  readonly definition = gameDefinition('terraria');
  readonly worldImport = terrariaWorldImport;
  // "exit" saves the world and quits
  readonly stopCommand = 'exit';
  readonly playerActions = [
    { id: 'kick', label: 'Kick', confirm: false, command: (name: string) => `kick ${name}` },
    { id: 'ban', label: 'Ban', confirm: true, command: (name: string) => `ban ${name}` },
  ];
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: TerrariaAdapterOptions) {
    this.platform = options.platform ?? process.platform;
  }

  executable(dir: string): string {
    return path.join(binaryDir(dir), this.platform === 'win32' ? 'TerrariaServer.exe' : 'TerrariaServer.bin.x86_64');
  }

  classifyLine(line: string): LineEvent | null {
    return classifyTerrariaLine(line);
  }

  async createColumns(raw: unknown, others: Server[]): Promise<Partial<Server>> {
    const input = CreateTerrariaSchema.parse(raw);
    safeText(input.name, 'server name');
    if (input.password !== '') safeText(input.password, 'password');
    const port = allocatePorts(input.port, DEFAULT_PORT, [0], takenPorts(others));
    const settings: TerrariaSettings = { world: input.world.trim(), size: input.size, difficulty: input.difficulty, maxPlayers: input.maxPlayers, password: input.password, version: '' };
    return { name: input.name, loader: 'vanilla', mcVersion: '', port, maxRamMb: 2048, minRamMb: 512, eulaAccepted: true, gameSettings: JSON.stringify(settings) };
  }

  async applySettings(server: Server, raw: unknown): Promise<Partial<Server>> {
    const next = { ...parseTerrariaSettings(server), ...EditTerrariaSchema.parse(raw) };
    if (next.password !== '') safeText(next.password, 'password');
    return { gameSettings: JSON.stringify(TerrariaSettingsSchema.parse(next)) };
  }

  installTitle(): string {
    return 'Terraria (dedicated server from terraria.org)';
  }

  async validateInstall(server: Server): Promise<void> {
    parseTerrariaSettings(server);
    if (this.platform !== 'linux' && this.platform !== 'win32') throw new AppError(422, 'PLATFORM_UNSUPPORTED', 'The Terraria server runs on Windows and Linux only.');
  }

  // the newest server from the official list, unpacked for this platform into server/
  async install(server: Server, ctx: InstallContext): Promise<Partial<Server>> {
    const fetcher = this.options.fetch ?? fetch;
    ctx.progress('resolve', null, msg('INSTALL_STEP_RESOLVE'));
    const response = await fetcher(TERRARIA_LIST_URL, { signal: ctx.signal }).catch(() => null);
    const names = response?.ok === true ? ((await response.json().catch(() => null)) as unknown) : null;
    const fileName = Array.isArray(names) ? names.find((name): name is string => typeof name === 'string' && /^terraria-server-\d{3,6}\.zip$/.test(name)) : undefined;
    if (fileName === undefined) throw new AppError(502, 'UPSTREAM_UNREACHABLE', 'The list of Terraria servers on terraria.org could not be read.', undefined, { service: 'terraria.org' });
    const version = /(\d+)\.zip$/.exec(fileName)?.[1] ?? '';
    ctx.log(`terraria.org: ${fileName}`);
    const tmp = path.join(this.options.tmpDir, `terraria-${server.id}`);
    await rm(tmp, { recursive: true, force: true });
    try {
      const archive = await downloadToTmp(
        {
          url: terrariaDownloadUrl(fileName),
          fileName,
          fileKind: 'archive',
          requireZip: true,
          onProgress: (received, total) => ctx.progress('download', total === null ? null : (received / total) * 100, msg('INSTALL_STEP_DOWNLOAD', { fileName, kib: Math.round(received / 1024) })),
        },
        tmp,
        { fetch: fetcher, allowedHosts: TERRARIA_HOSTS, timeoutMs: 10 * 60_000, signal: ctx.signal },
      );
      const unpacked = path.join(tmp, 'unpacked');
      await extractZip(archive, unpacked, { maxBytes: 512 * 1024 * 1024, maxEntries: 5000, platform: this.platform, checkpoint: () => ctx.signal.throwIfAborted() });
      // <version>/Linux or <version>/Windows
      const top = (await readdir(unpacked))[0];
      const source = top === undefined ? null : path.join(unpacked, top, this.platform === 'win32' ? 'Windows' : 'Linux');
      if (source === null || !(await exists(source))) throw new AppError(502, 'SERVER_FILES_MISSING', 'The download from terraria.org does not contain the server for this system.');
      await rm(binaryDir(ctx.dir), { recursive: true, force: true });
      await cp(source, binaryDir(ctx.dir), { recursive: true });
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
    await requireProgram(this.executable(ctx.dir), 'install');
    await mkdir(worldsDir(ctx.dir), { recursive: true });
    return { gameSettings: JSON.stringify({ ...parseTerrariaSettings(server), version }) };
  }

  // serverconfig.txt is written from the settings on every start; lines the user added (motd, secure, ...) stay
  async planStart(server: Server, dir: string): Promise<StartPlan> {
    const settings = parseTerrariaSettings(server);
    const executable = this.executable(dir);
    await requireProgram(executable, 'start');
    await mkdir(worldsDir(dir), { recursive: true });
    const current = await readFile(configFile(dir), 'utf8').catch(() => '');
    await writeFile(
      configFile(dir),
      writeConfig(current, {
        world: path.join(worldsDir(dir), `${settings.world}.wld`),
        autocreate: String(settings.size),
        worldname: settings.world,
        difficulty: String(settings.difficulty),
        maxplayers: String(settings.maxPlayers),
        port: String(server.port),
        password: settings.password,
        worldpath: worldsDir(dir),
        banlist: path.join(dir, 'banlist.txt'),
      }),
    );
    return {
      kind: 'launch',
      plan: {
        command: executable,
        args: ['-config', configFile(dir)],
        cwd: dir,
        port: server.port,
        startLine: msg('SERVER_STARTING_GAME', { game: 'Terraria', port: server.port }),
        notes: [],
        beforeSpawn: async () => undefined,
        javaPath: null,
        ...(settings.password === '' ? {} : { redact: [settings.password] }),
      },
    };
  }

  async backupLayout(_server: Server, dir: string): Promise<BackupLayout> {
    return {
      root: dir,
      levelName: 'worlds',
      worlds: () => ['worlds'],
      configFiles: ['serverconfig.txt', 'banlist.txt'],
      configDirs: [],
      live: false,
      validateLevel: (level) => {
        if (level !== 'worlds') throw new AppError(422, 'BACKUP_INVALID', 'The backup does not belong to a Terraria server.');
        return level;
      },
    };
  }

  configFiles(_server: Server, dir: string): ConfigFile[] {
    return [
      { key: 'serverconfig', label: 'serverconfig.txt', description: 'Further settings (motd, secure, npcstream …). World, size, difficulty, players, port and password are set by WorldFoundry on every start.', file: configFile(dir), display: 'serverconfig.txt', format: 'text' },
      { key: 'banlist', label: 'Ban list', description: 'Banned players, as the server writes them.', file: path.join(dir, 'banlist.txt'), display: 'banlist.txt', format: 'text' },
    ];
  }
}
