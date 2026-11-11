import { randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BackupLayout } from '../../backups/world.js';
import type { Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { rconCommand } from '../../lib/rcon.js';
import { msg } from '../../messages.js';
import type { LineEvent } from '../../process/patterns.js';
import type { SteamCmd } from '../../steam/steamcmd.js';
import { parseListPlayers, type Rcon } from '../ark/adapter.js';
import { takenPorts } from '../ports.js';
import { gameDefinition } from '../registry.js';
import { allocatePorts, allocateSingle, exists, parseGameSettings, requireProgram, safeText, steamInstall } from '../steam-game.js';
import type { ConfigFile, GameAdapter, InstallContext, StartPlan, WorldImportSupport } from '../types.js';
import { findDirs, moveInto, noWorld } from '../../worldio/game-world.js';
import { ensureProton, installedProton, protonVersion } from './proton.js';

export const ASA_APP_ID = 2430930;
export const DEFAULT_PORT = 7777;
export const DEFAULT_RCON_PORT = 27020;

// map ids of the official maps (the _WP suffix is part of the name the server expects)
export const ASA_MAPS: Record<string, string> = {
  TheIsland_WP: 'The Island',
  ScorchedEarth_WP: 'Scorched Earth',
  TheCenter_WP: 'The Center',
  Aberration_WP: 'Aberration',
  Extinction_WP: 'Extinction',
  Astraeos_WP: 'Astraeos',
  Ragnarok_WP: 'Ragnarok',
  Valguero_WP: 'Valguero',
};
const MAP_IDS = Object.keys(ASA_MAPS) as [string, ...string[]];

export const binaryDir = (dir: string): string => path.join(dir, 'server');
export const savedDir = (dir: string): string => path.join(binaryDir(dir), 'ShooterGame', 'Saved');

const MOD_ID = /^\d{1,12}$/;

export const AsaSettingsSchema = z
  .object({
    map: z.enum(MAP_IDS),
    maxPlayers: z.number().int().min(1).max(127),
    password: z.string().max(64),
    adminPassword: z.string().min(8).max(64),
    rconPort: z.number().int(),
    // CurseForge project ids; the server downloads them itself
    mods: z.array(z.string().regex(MOD_ID)).max(200),
  })
  .strict();
export type AsaSettings = z.infer<typeof AsaSettingsSchema>;

export const CreateAsaSchema = z
  .object({
    game: z.literal('asa'),
    name: z.string().trim().min(1).max(60),
    map: z.enum(MAP_IDS).default('TheIsland_WP'),
    maxPlayers: z.number().int().min(1).max(127).default(20),
    password: z.string().max(64).default(''),
    port: z.number().int().min(1024).max(65535).optional(),
  })
  .strict();

export const EditAsaSchema = z
  .object({ map: z.enum(MAP_IDS), maxPlayers: z.number().int().min(1).max(127), password: z.string().max(64), mods: z.array(z.string().regex(MOD_ID)).max(200) })
  .partial()
  .strict();

export const parseAsaSettings = (server: Pick<Server, 'gameSettings'>): AsaSettings => parseGameSettings(AsaSettingsSchema, server);

// A save from another server: SavedArks/<Map>_WP/<Map>_WP.ark with the .arkprofile and .arktribe files beside it
export const asaWorldImport: WorldImportSupport = {
  native: async (staged, out, ctx) => {
    const holders = await findDirs(staged, (_dir, files) => files.some((name) => /^[A-Za-z0-9]+_WP\.ark$/.test(name)));
    const holder = holders[0];
    if (holder === undefined) throw noWorld('ARK: Survival Ascended', 'a map folder with <Map>_WP.ark (ShooterGame/Saved/SavedArks/<Map>_WP)');
    const mapFile = (await readdir(holder)).find((name) => /^[A-Za-z0-9]+_WP\.ark$/.test(name)) ?? '';
    const map = mapFile.replace(/\.ark$/, '');
    await moveInto(holder, path.join(out, 'SavedArks', map));
    const current = parseAsaSettings(ctx.server).map;
    return { worlds: ['SavedArks'], configItems: [], warnings: current === map ? [] : [msg('GAME_IMPORT_ARK_MAP', { found: map, map: ASA_MAPS[current] ?? current })] };
  },
};

export interface AsaAdapterOptions {
  steam: SteamCmd;
  // <data>/runtimes/proton, where GE-Proton is kept
  protonRoot: string;
  platform?: NodeJS.Platform;
  rcon?: Rcon;
  fetch?: typeof fetch;
}

export class AsaAdapter implements GameAdapter {
  readonly definition = gameDefinition('asa');
  readonly worldImport = asaWorldImport;
  // no console input: RCON for commands and players, SaveWorld + DoExit for a clean stop
  readonly stopCommand = null;
  readonly playerActions = [
    { id: 'kick', label: 'Kick', confirm: false, command: (id: string) => `KickPlayer ${id}` },
    { id: 'ban', label: 'Ban', confirm: true, command: (id: string) => `BanPlayer ${id}` },
    { id: 'unban', label: 'Unban', confirm: false, command: (id: string) => `UnbanPlayer ${id}` },
  ];
  private readonly platform: NodeJS.Platform;
  private readonly rcon: Rcon;
  // the id ARK needs for kick and ban, per server and player name, from the last ListPlayers
  private readonly ids = new Map<string, Map<string, string>>();

  constructor(private readonly options: AsaAdapterOptions) {
    this.platform = options.platform ?? process.platform;
    this.rcon = options.rcon ?? ((target, command) => rconCommand(target, command));
  }

  windowsExecutable(dir: string): string {
    return path.join(binaryDir(dir), 'ShooterGame', 'Binaries', 'Win64', 'ArkAscendedServer.exe');
  }

  // a native Linux build, should the game ever ship one; until then Proton runs the Windows build
  linuxExecutable(dir: string): string {
    return path.join(binaryDir(dir), 'ShooterGame', 'Binaries', 'Linux', 'ArkAscendedServer');
  }

  classifyLine(): LineEvent | null {
    return null;
  }

  private target(server: Server): { port: number; password: string } {
    const settings = parseAsaSettings(server);
    return { port: settings.rconPort, password: settings.adminPassword };
  }

  async sendCommand(server: Server, _dir: string, command: string): Promise<string[]> {
    const answer = await this.rcon(this.target(server), command);
    return answer.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line !== '');
  }

  async stop(server: Server): Promise<void> {
    await this.rcon(this.target(server), 'SaveWorld');
    await this.rcon(this.target(server), 'DoExit');
  }

  async playerList(server: Server): Promise<{ names: string[] | null; count: number | null }> {
    const players = parseListPlayers(await this.rcon(this.target(server), 'ListPlayers'));
    this.ids.set(server.id, new Map(players.map((player) => [player.name, player.steamId])));
    return { names: players.map((player) => player.name), count: players.length };
  }

  resolvePlayer(serverId: string, nameOrId: string): string {
    return this.ids.get(serverId)?.get(nameOrId) ?? nameOrId;
  }

  async createColumns(raw: unknown, others: Server[]): Promise<Partial<Server>> {
    const input = CreateAsaSchema.parse(raw);
    safeText(input.name, 'server name');
    if (input.password !== '') safeText(input.password, 'password');
    // the name travels inside the ?-separated launch options
    if (input.name.includes('?')) throw new AppError(422, 'VALUE_INVALID', 'The server name must not contain "?".');
    const taken = takenPorts(others);
    const port = allocatePorts(input.port, DEFAULT_PORT, [0], taken);
    taken.add(port);
    const rconPort = allocateSingle(undefined, DEFAULT_RCON_PORT, taken);
    const settings: AsaSettings = { map: input.map, maxPlayers: input.maxPlayers, password: input.password, adminPassword: randomBytes(12).toString('base64url'), rconPort, mods: [] };
    return { name: input.name, loader: 'vanilla', mcVersion: '', port, maxRamMb: 16_384, minRamMb: 1024, eulaAccepted: true, gameSettings: JSON.stringify(settings) };
  }

  async applySettings(server: Server, raw: unknown): Promise<Partial<Server>> {
    const next = { ...parseAsaSettings(server), ...EditAsaSchema.parse(raw) };
    if (next.password !== '') safeText(next.password, 'password');
    return { gameSettings: JSON.stringify(AsaSettingsSchema.parse({ ...next, mods: [...new Set(next.mods)] })) };
  }

  installTitle(): string {
    return this.platform === 'win32' ? 'ARK: Survival Ascended' : 'ARK: Survival Ascended (Windows server through GE-Proton)';
  }

  async validateInstall(server: Server): Promise<void> {
    parseAsaSettings(server);
    if (this.platform !== 'linux' && this.platform !== 'win32') throw new AppError(422, 'STEAMCMD_PLATFORM', 'SteamCMD servers are supported on Windows and Linux only.');
  }

  async install(_server: Server, ctx: InstallContext): Promise<Partial<Server>> {
    await steamInstall(ctx, {
      steam: this.options.steam,
      appId: ASA_APP_ID,
      branch: 'public',
      title: 'ARK: Survival Ascended',
      dir: binaryDir(ctx.dir),
      ...(this.platform === 'win32' ? {} : { platformType: 'windows' as const }),
    });
    if (this.platform !== 'win32' && !(await exists(this.linuxExecutable(ctx.dir)))) {
      const proton = await ensureProton(this.options.protonRoot, ctx, this.options.fetch);
      ctx.log(`Proton: ${await protonVersion(proton)}`);
    }
    if (!(await exists(this.linuxExecutable(ctx.dir)))) await requireProgram(this.windowsExecutable(ctx.dir), 'install');
    return {};
  }

  async planStart(server: Server, dir: string): Promise<StartPlan> {
    const settings = parseAsaSettings(server);
    const query = [
      settings.map,
      'listen',
      `SessionName=${server.name}`,
      `Port=${server.port}`,
      'RCONEnabled=True',
      `RCONPort=${settings.rconPort}`,
      `ServerAdminPassword=${settings.adminPassword}`,
      ...(settings.password === '' ? [] : [`ServerPassword=${settings.password}`]),
    ].join('?');
    const flags = [`-WinLiveMaxPlayers=${settings.maxPlayers}`, '-NoBattlEye', '-log', ...(settings.mods.length > 0 ? [`-mods=${settings.mods.join(',')}`] : [])];
    const common = {
      port: server.port,
      startLine: msg('SERVER_STARTING_GAME', { game: 'ARK: Survival Ascended', port: server.port }),
      notes: [],
      beforeSpawn: async () => undefined,
      javaPath: null,
      redact: [settings.adminPassword, ...(settings.password === '' ? [] : [settings.password])],
      readiness: async () => {
        await this.rcon(this.target(server), 'ListPlayers');
        return true;
      },
    };
    if (this.platform === 'win32' || (await exists(this.linuxExecutable(dir)))) {
      const executable = this.platform === 'win32' ? this.windowsExecutable(dir) : this.linuxExecutable(dir);
      await requireProgram(executable, 'start');
      return { kind: 'launch', plan: { ...common, command: executable, args: [query, ...flags], cwd: path.dirname(executable) } };
    }
    await requireProgram(this.windowsExecutable(dir), 'start');
    const proton = await installedProton(this.options.protonRoot);
    if (proton === null) throw new AppError(409, 'SERVER_FILES_MISSING', 'GE-Proton is missing. Please start the installation again.');
    // Proton keeps its Windows environment per server; the client path only has to exist
    const prefix = path.join(dir, 'proton-prefix');
    const client = path.join(dir, 'proton-client');
    await mkdir(prefix, { recursive: true });
    await mkdir(client, { recursive: true });
    return {
      kind: 'launch',
      plan: {
        ...common,
        command: proton,
        args: ['run', this.windowsExecutable(dir), query, ...flags],
        cwd: path.dirname(this.windowsExecutable(dir)),
        env: { STEAM_COMPAT_DATA_PATH: prefix, STEAM_COMPAT_CLIENT_INSTALL_PATH: client },
      },
    };
  }

  async backupLayout(_server: Server, dir: string): Promise<BackupLayout> {
    return {
      root: savedDir(dir),
      levelName: 'SavedArks',
      worlds: () => ['SavedArks'],
      configFiles: [],
      configDirs: ['Config'],
      live: false,
      validateLevel: (level) => {
        if (level !== 'SavedArks') throw new AppError(422, 'BACKUP_INVALID', 'The backup does not belong to an ARK: Survival Ascended server.');
        return level;
      },
    };
  }

  configFiles(_server: Server, dir: string): ConfigFile[] {
    // the Windows build writes WindowsServer, also under Proton
    const folder = path.join(savedDir(dir), 'Config', 'WindowsServer');
    const display = 'server/ShooterGame/Saved/Config/WindowsServer';
    return [
      { key: 'gameusersettings', label: 'GameUserSettings.ini', description: 'Server settings ([ServerSettings]): difficulty, rates, PvE. Created on the first start.', file: path.join(folder, 'GameUserSettings.ini'), display: `${display}/GameUserSettings.ini`, format: 'ini' },
      { key: 'game', label: 'Game.ini', description: 'Detailed game rules (level caps, engram points, loot). Optional.', file: path.join(folder, 'Game.ini'), display: `${display}/Game.ini`, format: 'ini' },
    ];
  }
}
