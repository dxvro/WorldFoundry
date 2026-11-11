import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BackupLayout } from '../../backups/world.js';
import type { Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { msg } from '../../messages.js';
import type { LineEvent } from '../../process/patterns.js';
import type { SteamCmd } from '../../steam/steamcmd.js';
import { takenPorts } from '../ports.js';
import { gameDefinition } from '../registry.js';
import { allocatePorts, allocateSingle, parseGameSettings, requireProgram, safeText, steamInstall } from '../steam-game.js';
import type { ConfigFile, CustomMod, CustomModSupport, GameAdapter, InstallContext, StartPlan, WorldImportSupport } from '../types.js';
import { findDirs, findFiles, isDir, moveInto, noWorld } from '../../worldio/game-world.js';
import { folderSize, invalidMod } from '../custom-mods.js';

export const PALWORLD_APP_ID = 2394010;
export const DEFAULT_PORT = 8211;
export const DEFAULT_QUERY_PORT = 27015;
export const DEFAULT_REST_PORT = 8212;

export const binaryDir = (dir: string): string => path.join(dir, 'server');
export const savedDir = (dir: string): string => path.join(binaryDir(dir), 'Pal', 'Saved');

export const PalworldSettingsSchema = z
  .object({
    maxPlayers: z.number().int().min(1).max(32),
    password: z.string().max(64),
    adminPassword: z.string().min(8).max(64),
    public: z.boolean(),
    queryPort: z.number().int(),
    restPort: z.number().int(),
  })
  .strict();
export type PalworldSettings = z.infer<typeof PalworldSettingsSchema>;

export const CreatePalworldSchema = z
  .object({
    game: z.literal('palworld'),
    name: z.string().trim().min(1).max(60),
    maxPlayers: z.number().int().min(1).max(32).default(16),
    password: z.string().max(64).default(''),
    public: z.boolean().default(false),
    port: z.number().int().min(1024).max(65535).optional(),
  })
  .strict();

export const EditPalworldSchema = z.object({ maxPlayers: z.number().int().min(1).max(32), password: z.string().max(64), public: z.boolean() }).partial().strict();

export const parsePalworldSettings = (server: Pick<Server, 'gameSettings'>): PalworldSettings => parseGameSettings(PalworldSettingsSchema, server);

// OptionSettings=(Key=Value,Text="quoted",...) in one line; a key the line lacks is appended inside the brackets
export function setOptions(ini: string, values: Record<string, string | number | boolean>): string {
  const line = /^OptionSettings=\((.*)\)\s*$/m.exec(ini);
  let body = line?.[1] ?? '';
  for (const [key, raw] of Object.entries(values)) {
    const value = typeof raw === 'string' ? `"${raw.replace(/["\\]/g, '')}"` : typeof raw === 'boolean' ? (raw ? 'True' : 'False') : String(raw);
    const pattern = new RegExp(`(^|,)${key}=("[^"]*"|[^,]*)`);
    body = pattern.test(body) ? body.replace(pattern, `$1${key}=${value}`) : `${body}${body === '' ? '' : ','}${key}=${value}`;
  }
  const next = `OptionSettings=(${body})`;
  if (line !== null) return ini.replace(line[0], next);
  return `${ini.trimEnd()}${ini.trim() === '' ? '' : '\n'}[/Script/Pal.PalGameWorldSettings]\n${next}\n`;
}

// ---- the REST API of the dedicated server (Basic auth, user "admin", the admin password) ----

export type PalRest = (settings: Pick<PalworldSettings, 'restPort' | 'adminPassword'>, method: 'GET' | 'POST', route: string, body?: unknown) => Promise<unknown>;

export const palRest: PalRest = async (settings, method, route, body) => {
  const response = await fetch(`http://127.0.0.1:${settings.restPort}/v1/api/${route}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`admin:${settings.adminPassword}`).toString('base64')}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new AppError(502, 'GAME_CONSOLE_UNREACHABLE', `The server answered ${response.status}.`);
  const text = await response.text();
  return text === '' ? null : (JSON.parse(text) as unknown);
};

interface PalPlayer {
  name: string;
  userId: string;
}

const playersOf = (answer: unknown): PalPlayer[] => {
  const list = (answer as { players?: unknown } | null)?.players;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const player = entry as { name?: unknown; userId?: unknown };
    return typeof player.name === 'string' && typeof player.userId === 'string' ? [{ name: player.name, userId: player.userId }] : [];
  });
};

// A world from another server or a co-op host: SaveGames/0/<world id>/Level.sav (with Players/). The server loads the
// world named by DedicatedServerName in GameUserSettings.ini, which `after` sets to the imported one.
export const palworldWorldImport: WorldImportSupport = {
  native: async (staged, out) => {
    const worlds = await findDirs(staged, (_dir, files) => files.includes('Level.sav'));
    const world = worlds[0];
    if (world === undefined) throw noWorld('Palworld', 'a world folder with Level.sav (Pal/Saved/SaveGames/0/<id>)');
    await moveInto(world, path.join(out, 'SaveGames', '0', path.basename(world)));
    return { worlds: ['SaveGames'], configItems: [], warnings: worlds.length > 1 ? [msg('GAME_IMPORT_FIRST_OF_SEVERAL', { count: worlds.length, name: path.basename(world) })] : [] };
  },
};

// Pak mods: <name>.pak (with .ucas/.utoc) in Pal/Content/Paks/~mods; every file there was put by WorldFoundry
const paksDir = (dir: string): string => path.join(binaryDir(dir), 'Pal', 'Content', 'Paks', '~mods');
const PAK = /\.(pak|ucas|utoc)$/i;
export const palworldCustomMods: CustomModSupport = {
  accept: '.zip,.tar.gz,.tgz',
  async list(_server, dir) {
    const mods: CustomMod[] = [];
    for (const name of await readdir(paksDir(dir)).catch(() => [])) {
      if (!/\.pak$/i.test(name)) continue;
      const base = name.replace(/\.pak$/i, '');
      let size = 0;
      for (const part of [name, `${base}.ucas`, `${base}.utoc`]) size += (await stat(path.join(paksDir(dir), part)).catch(() => null))?.size ?? 0;
      mods.push({ id: base, name: base, location: `server/Pal/Content/Paks/~mods/${name}`, sizeBytes: size, active: null });
    }
    return mods.sort((a, b) => a.name.localeCompare(b.name));
  },
  async install(_server, dir, staged) {
    const files = await findFiles(staged, (name) => PAK.test(name));
    if (!files.some((file) => /\.pak$/i.test(file))) throw invalidMod('Palworld', 'one or more .pak files (with their .ucas/.utoc), packed as .zip');
    await mkdir(paksDir(dir), { recursive: true });
    const installed: CustomMod[] = [];
    for (const file of files) {
      const name = path.basename(file);
      if (!/^[A-Za-z0-9 _.+()-]{1,120}$/.test(name)) throw invalidMod('Palworld', 'file names without special characters');
      await copyFile(file, path.join(paksDir(dir), name));
      if (/\.pak$/i.test(name)) installed.push({ id: name.replace(/\.pak$/i, ''), name: name.replace(/\.pak$/i, ''), location: `server/Pal/Content/Paks/~mods/${name}`, sizeBytes: await folderSize(path.join(paksDir(dir), name)), active: null });
    }
    return installed;
  },
  async remove(_server, dir, id) {
    for (const ext of ['pak', 'ucas', 'utoc']) await rm(path.join(paksDir(dir), `${id}.${ext}`), { force: true });
  },
};

export interface PalworldAdapterOptions {
  steam: SteamCmd;
  platform?: NodeJS.Platform;
  rest?: PalRest;
}

export class PalworldAdapter implements GameAdapter {
  readonly definition = gameDefinition('palworld');
  readonly worldImport: WorldImportSupport;
  readonly customMods = palworldCustomMods;
  // no console input: save and shutdown go through the REST API, SIGINT is the fallback
  readonly stopCommand = null;
  readonly stopSignal = 'SIGINT' as const;
  readonly playerActions = [
    { id: 'kick', label: 'Kick', confirm: false, command: (name: string) => `kick ${name}` },
    { id: 'ban', label: 'Ban', confirm: true, command: (name: string) => `ban ${name}` },
  ];
  private readonly platform: NodeJS.Platform;
  private readonly rest: PalRest;

  constructor(private readonly options: PalworldAdapterOptions) {
    this.platform = options.platform ?? process.platform;
    this.rest = options.rest ?? palRest;
    this.worldImport = { ...palworldWorldImport, after: (ctx) => this.pointAtImportedWorld(ctx.dir) };
  }

  private get platformDir(): string {
    return this.platform === 'win32' ? 'WindowsServer' : 'LinuxServer';
  }

  executable(dir: string): string {
    return path.join(binaryDir(dir), this.platform === 'win32' ? 'PalServer.exe' : 'PalServer.sh');
  }

  settingsFile(dir: string): string {
    return path.join(savedDir(dir), 'Config', this.platformDir, 'PalWorldSettings.ini');
  }

  gameUserSettings(dir: string): string {
    return path.join(savedDir(dir), 'Config', this.platformDir, 'GameUserSettings.ini');
  }

  classifyLine(): LineEvent | null {
    return null;
  }

  async playerList(server: Server): Promise<{ names: string[] | null; count: number | null }> {
    const players = playersOf(await this.rest(parsePalworldSettings(server), 'GET', 'players'));
    return { names: players.map((player) => player.name), count: players.length };
  }

  // "broadcast <text>", "save", "kick <name>", "ban <name>", "unban <user id>": the REST API has no free console
  async sendCommand(server: Server, _dir: string, command: string): Promise<string[]> {
    const settings = parsePalworldSettings(server);
    const [verb = '', ...rest] = command.trim().split(/\s+/);
    const argument = rest.join(' ');
    const userIdOf = async (name: string): Promise<string> => {
      const player = playersOf(await this.rest(settings, 'GET', 'players')).find((entry) => entry.name === name || entry.userId === name);
      if (player === undefined) throw new AppError(404, 'PLAYER_NOT_FOUND', `"${name}" is not online.`);
      return player.userId;
    };
    switch (verb.toLowerCase()) {
      case 'broadcast':
        await this.rest(settings, 'POST', 'announce', { message: argument });
        return [`Announced: ${argument}`];
      case 'save':
        await this.rest(settings, 'POST', 'save');
        return ['World saved.'];
      case 'kick':
        await this.rest(settings, 'POST', 'kick', { userid: await userIdOf(argument), message: 'Kicked by an admin.' });
        return [`Kicked ${argument}`];
      case 'ban':
        await this.rest(settings, 'POST', 'ban', { userid: await userIdOf(argument), message: 'Banned by an admin.' });
        return [`Banned ${argument}`];
      case 'unban':
        await this.rest(settings, 'POST', 'unban', { userid: argument });
        return [`Unbanned ${argument}`];
      default:
        throw new AppError(422, 'COMMAND_UNSUPPORTED', 'Palworld accepts these commands here: broadcast <text>, save, kick <name>, ban <name>, unban <user id>.');
    }
  }

  async stop(server: Server): Promise<void> {
    const settings = parsePalworldSettings(server);
    await this.rest(settings, 'POST', 'save');
    await this.rest(settings, 'POST', 'shutdown', { waittime: 1, message: 'The server is shutting down.' });
  }

  async createColumns(raw: unknown, others: Server[]): Promise<Partial<Server>> {
    const input = CreatePalworldSchema.parse(raw);
    safeText(input.name, 'server name');
    if (input.password !== '') safeText(input.password, 'password');
    const taken = takenPorts(others);
    const port = allocatePorts(input.port, DEFAULT_PORT, [0], taken);
    taken.add(port);
    const queryPort = allocateSingle(undefined, DEFAULT_QUERY_PORT, taken);
    const restPort = allocateSingle(undefined, DEFAULT_REST_PORT, taken);
    const settings: PalworldSettings = { maxPlayers: input.maxPlayers, password: input.password, adminPassword: randomBytes(12).toString('base64url'), public: input.public, queryPort, restPort };
    return { name: input.name, loader: 'vanilla', mcVersion: '', port, maxRamMb: 16_384, minRamMb: 1024, eulaAccepted: true, gameSettings: JSON.stringify(settings) };
  }

  async applySettings(server: Server, raw: unknown): Promise<Partial<Server>> {
    const next = { ...parsePalworldSettings(server), ...EditPalworldSchema.parse(raw) };
    if (next.password !== '') safeText(next.password, 'password');
    return { gameSettings: JSON.stringify(PalworldSettingsSchema.parse(next)) };
  }

  installTitle(): string {
    return 'Palworld';
  }

  async validateInstall(server: Server): Promise<void> {
    parsePalworldSettings(server);
    if (this.platform !== 'linux' && this.platform !== 'win32') throw new AppError(422, 'STEAMCMD_PLATFORM', 'SteamCMD servers are supported on Windows and Linux only.');
  }

  async install(_server: Server, ctx: InstallContext): Promise<Partial<Server>> {
    await steamInstall(ctx, { steam: this.options.steam, appId: PALWORLD_APP_ID, branch: 'public', title: 'Palworld', dir: binaryDir(ctx.dir) });
    await requireProgram(this.executable(ctx.dir), 'install');
    return {};
  }

  // PalWorldSettings.ini starts from the template that ships with the server; the values WorldFoundry owns are
  // written on every start (the REST API is how WorldFoundry talks to the server), everything else is the user's
  private async writeSettings(server: Server, dir: string): Promise<void> {
    const settings = parsePalworldSettings(server);
    const file = this.settingsFile(dir);
    await mkdir(path.dirname(file), { recursive: true });
    let current = await readFile(file, 'utf8').catch(() => null);
    if (current === null || current.trim() === '') current = await readFile(path.join(binaryDir(dir), 'DefaultPalWorldSettings.ini'), 'utf8').catch(() => '');
    await writeFile(
      file,
      setOptions(current, {
        ServerName: server.name,
        ServerPassword: settings.password,
        AdminPassword: settings.adminPassword,
        ServerPlayerMaxNum: settings.maxPlayers,
        PublicPort: server.port,
        RESTAPIEnabled: true,
        RESTAPIPort: settings.restPort,
        RCONEnabled: false,
      }),
    );
  }

  async planStart(server: Server, dir: string): Promise<StartPlan> {
    const settings = parsePalworldSettings(server);
    const executable = this.executable(dir);
    await requireProgram(executable, 'start');
    await this.writeSettings(server, dir);
    return {
      kind: 'launch',
      plan: {
        command: executable,
        args: [`-port=${server.port}`, `-queryport=${settings.queryPort}`, `-players=${settings.maxPlayers}`, ...(settings.public ? ['-publiclobby'] : []), '-useperfthreads', '-NoAsyncLoadingThread', '-UseMultithreadForDS'],
        cwd: binaryDir(dir),
        port: server.port,
        startLine: msg('SERVER_STARTING_GAME', { game: 'Palworld', port: server.port }),
        notes: [],
        beforeSpawn: async () => undefined,
        javaPath: null,
        redact: [settings.adminPassword, ...(settings.password === '' ? [] : [settings.password])],
        readiness: async () => {
          await this.rest(settings, 'GET', 'info');
          return true;
        },
      },
    };
  }

  // after an import: DedicatedServerName points the server at the imported world
  private async pointAtImportedWorld(dir: string): Promise<ReturnType<typeof msg>[]> {
    const folder = path.join(savedDir(dir), 'SaveGames', '0');
    const worlds: string[] = [];
    for (const name of await readdir(folder).catch(() => [])) if (await isDir(path.join(folder, name))) worlds.push(name);
    if (worlds.length !== 1 || worlds[0] === undefined) return [];
    const file = this.gameUserSettings(dir);
    const text = await readFile(file, 'utf8').catch(() => '');
    const line = `DedicatedServerName=${worlds[0]}`;
    const next = /^DedicatedServerName=.*$/m.test(text) ? text.replace(/^DedicatedServerName=.*$/m, line) : `${text.trimEnd()}${text.trim() === '' ? '[/Script/Pal.PalGameLocalSettings]' : ''}\n${line}\n`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, next);
    return [];
  }

  async backupLayout(_server: Server, dir: string): Promise<BackupLayout> {
    return {
      root: savedDir(dir),
      levelName: 'SaveGames',
      worlds: () => ['SaveGames'],
      configFiles: [],
      configDirs: ['Config'],
      live: false,
      validateLevel: (level) => {
        if (level !== 'SaveGames') throw new AppError(422, 'BACKUP_INVALID', 'The backup does not belong to a Palworld server.');
        return level;
      },
    };
  }

  configFiles(_server: Server, dir: string): ConfigFile[] {
    const display = `server/Pal/Saved/Config/${this.platformDir}`;
    return [
      { key: 'palworldsettings', label: 'PalWorldSettings.ini', description: 'Game rules in OptionSettings=(…): rates, death penalty, base camps, PvP. Name, passwords, player limit, port and the REST API are set by WorldFoundry on every start.', file: this.settingsFile(dir), display: `${display}/PalWorldSettings.ini`, format: 'ini' },
    ];
  }
}
