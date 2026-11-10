import { randomBytes } from 'node:crypto';
import { access, cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BackupLayout } from '../../backups/world.js';
import type { Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { rconCommand } from '../../lib/rcon.js';
import { msg } from '../../messages.js';
import type { LineEvent } from '../../process/patterns.js';
import type { SteamCmd } from '../../steam/steamcmd.js';
import { takenPorts } from '../ports.js';
import { gameDefinition } from '../registry.js';
import type { ConfigFile, GameAdapter, InstallContext, StartPlan } from '../types.js';
import { getSectionValue } from './ini.js';

export const ARK_APP_ID = 376030;
export const ARK_WORKSHOP_APP = 346110;

// The official maps of ARK: Survival Evolved and the names the server expects
export const ARK_MAPS = {
  TheIsland: 'The Island',
  TheCenter: 'The Center',
  ScorchedEarth_P: 'Scorched Earth',
  Ragnarok: 'Ragnarok',
  Aberration_P: 'Aberration',
  Extinction: 'Extinction',
  Valguero_P: 'Valguero',
  Genesis: 'Genesis: Part 1',
  CrystalIsles: 'Crystal Isles',
  Gen2: 'Genesis: Part 2',
  LostIsland: 'Lost Island',
  Fjordur: 'Fjordur',
} as const;
export type ArkMap = keyof typeof ARK_MAPS;
const MAP_IDS = Object.keys(ARK_MAPS) as [ArkMap, ...ArkMap[]];

export const binaryDir = (dir: string): string => path.join(dir, 'server');
export const savedDir = (dir: string): string => path.join(binaryDir(dir), 'ShooterGame', 'Saved');

export const ArkSettingsSchema = z
  .object({
    map: z.enum(MAP_IDS),
    maxPlayers: z.number().int().min(1).max(200),
    peerPort: z.number().int().min(1024).max(65535),
    queryPort: z.number().int().min(1024).max(65535),
    rconPort: z.number().int().min(1024).max(65535),
    // in-game admin password, also the RCON password; WorldFoundry creates it and shows it to the owner
    adminPassword: z.string().min(8).max(128),
  })
  .strict();
export type ArkSettings = z.infer<typeof ArkSettingsSchema>;

// characters that would break the ?Key=Value list of the command line
const SAFE_NAME = /^[^?"\\\r\n\u0000]{1,60}$/;

export const CreateArkSchema = z
  .object({
    game: z.literal('ark'),
    name: z.string().trim().regex(SAFE_NAME, 'No ?, quotes or backslashes'),
    map: z.enum(MAP_IDS).default('TheIsland'),
    maxPlayers: z.number().int().min(1).max(200).default(70),
    port: z.number().int().min(1024).max(65534).optional(),
    queryPort: z.number().int().min(1024).max(65535).optional(),
    rconPort: z.number().int().min(1024).max(65535).optional(),
  })
  .strict();

export function parseArkSettings(server: Pick<Server, 'gameSettings'>): ArkSettings {
  try {
    return ArkSettingsSchema.parse(JSON.parse(server.gameSettings));
  } catch {
    throw new AppError(500, 'GAME_SETTINGS_INVALID', 'The stored settings of this server are damaged.');
  }
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

// "0. Bob, 76561198000000001" per player; "No Players Connected" when empty. Community-documented format.
export function parseListPlayers(text: string): Array<{ name: string; steamId: string }> {
  const players: Array<{ name: string; steamId: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\d+\.\s+(.+?),\s*(\d{15,20})\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) players.push({ name: match[1], steamId: match[2] });
  }
  return players;
}

export type Rcon = (options: { port: number; password: string }, command: string) => Promise<string>;

export interface ArkAdapterOptions {
  steam: SteamCmd;
  platform?: NodeJS.Platform;
  rcon?: Rcon;
}

export class ArkAdapter implements GameAdapter {
  readonly definition = gameDefinition('ark');
  // the server reads no console input: commands, players and the clean stop go through RCON
  readonly stopCommand = null;
  readonly stopSignal = 'SIGINT' as const;
  private readonly platform: NodeJS.Platform;
  private readonly rcon: Rcon;
  // name -> Steam id from the last player list, per server, so actions can work by name
  private readonly known = new Map<string, Map<string, string>>();

  readonly playerActions = [
    { id: 'kick', label: 'Kick', confirm: false, command: (who: string) => `KickPlayer ${who}` },
    { id: 'ban', label: 'Ban', confirm: true, command: (who: string) => `BanPlayer ${who}` },
    { id: 'unban', label: 'Unban', confirm: false, command: (who: string) => `UnbanPlayer ${who}` },
  ] as const;

  constructor(private readonly options: ArkAdapterOptions) {
    this.platform = options.platform ?? process.platform;
    this.rcon = options.rcon ?? ((rcon, command) => rconCommand(rcon, command));
  }

  private get platformDir(): string {
    return this.platform === 'win32' ? 'WindowsServer' : 'LinuxServer';
  }

  executable(dir: string): string {
    return this.platform === 'win32'
      ? path.join(binaryDir(dir), 'ShooterGame', 'Binaries', 'Win64', 'ShooterGameServer.exe')
      : path.join(binaryDir(dir), 'ShooterGame', 'Binaries', 'Linux', 'ShooterGameServer');
  }

  gameUserSettings(dir: string): string {
    return path.join(savedDir(dir), 'Config', this.platformDir, 'GameUserSettings.ini');
  }

  classifyLine(): LineEvent | null {
    return null;
  }

  async createColumns(raw: unknown, others: Server[]): Promise<Partial<Server>> {
    const input = CreateArkSchema.parse(raw);
    const taken = takenPorts(others);
    const free = (from: number, count: number): number => {
      let start = from;
      while (Array.from({ length: count }, (_, index) => start + index).some((port) => taken.has(port))) start += count;
      return start;
    };
    const port = input.port ?? free(7777, 2);
    if (taken.has(port) || taken.has(port + 1)) throw new AppError(409, 'PORT_IN_USE', `Port ${taken.has(port) ? port : port + 1} is already used by another server.`, { port }, { port });
    taken.add(port);
    taken.add(port + 1);
    const queryPort = input.queryPort ?? free(27015, 1);
    taken.add(queryPort);
    const rconPort = input.rconPort ?? free(27020, 1);
    if (new Set([port, port + 1, queryPort, rconPort]).size !== 4) throw new AppError(422, 'PORT_INVALID', 'The game, peer, query and RCON ports must all differ.');
    const settings: ArkSettings = { map: input.map, maxPlayers: input.maxPlayers, peerPort: port + 1, queryPort, rconPort, adminPassword: randomBytes(12).toString('base64url') };
    return { name: input.name, loader: 'vanilla', mcVersion: '', port, maxRamMb: 8192, minRamMb: 1024, eulaAccepted: true, gameSettings: JSON.stringify(settings) };
  }

  installTitle(): string {
    return 'ARK: Survival Evolved';
  }

  async validateInstall(server: Server): Promise<void> {
    parseArkSettings(server);
    if (this.platform !== 'linux' && this.platform !== 'win32') throw new AppError(422, 'STEAMCMD_PLATFORM', 'SteamCMD servers are supported on Windows and Linux only.');
  }

  async install(_server: Server, ctx: InstallContext): Promise<Partial<Server>> {
    ctx.progress('download', null, msg('INSTALL_STEP_RESOLVE'));
    ctx.log(`SteamCMD: app ${ARK_APP_ID}, anonymous login`);
    await this.options.steam.appUpdate({
      appId: ARK_APP_ID,
      branch: 'public',
      dir: binaryDir(ctx.dir),
      validate: true,
      signal: ctx.signal,
      onLine: ctx.log,
      onProgress: ({ percent }) => ctx.progress('download', percent, msg('INSTALL_STEP_DOWNLOAD', { fileName: 'ARK', kib: 0 })),
    });
    if (!(await exists(this.executable(ctx.dir)))) throw new AppError(500, 'SERVER_FILES_MISSING', 'SteamCMD finished, but the server program is missing.');
    return {};
  }

  async activeMods(dir: string): Promise<string[]> {
    const text = await readFile(this.gameUserSettings(dir), 'utf8').catch(() => '');
    return (getSectionValue(text, 'ServerSettings', 'ActiveMods') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => /^\d{1,20}$/.test(id));
  }

  async planStart(server: Server, dir: string): Promise<StartPlan> {
    const settings = parseArkSettings(server);
    const executable = this.executable(dir);
    if (!(await exists(executable))) throw new AppError(409, 'SERVER_FILES_MISSING', 'The server program is missing. Please start the installation again.');
    const mods = await this.activeMods(dir);
    if (mods.length > 0 && this.platform === 'linux') {
      // -automanagedmods runs the SteamCMD the server ships beside the engine; ARK does not bring it on Linux
      const target = path.join(binaryDir(dir), 'Engine', 'Binaries', 'ThirdParty', 'SteamCMD', 'Linux');
      if (!(await exists(path.join(target, 'steamcmd.sh')))) {
        await this.options.steam.prepare(new AbortController().signal, () => undefined);
        await mkdir(target, { recursive: true });
        // only the program itself: the folder of a configured SteamCMD may hold anything else
        for (const entry of ['steamcmd.sh', 'linux32', 'linux64']) {
          const from = path.join(this.options.steam.directory, entry);
          if (await exists(from)) await cp(from, path.join(target, entry), { recursive: true });
        }
      }
    }
    const query = [
      settings.map,
      'listen',
      `SessionName=${server.name}`,
      `Port=${server.port}`,
      `QueryPort=${settings.queryPort}`,
      `MaxPlayers=${settings.maxPlayers}`,
      'RCONEnabled=True',
      `RCONPort=${settings.rconPort}`,
      `ServerAdminPassword=${settings.adminPassword}`,
    ].join('?');
    const rcon = { port: settings.rconPort, password: settings.adminPassword };
    return {
      kind: 'launch',
      plan: {
        command: executable,
        args: [query, '-server', '-log', ...(mods.length > 0 ? ['-automanagedmods'] : [])],
        cwd: path.dirname(executable),
        port: server.port,
        startLine: msg('SERVER_STARTING_GAME', { game: 'ARK', port: server.port }),
        notes: [],
        beforeSpawn: async () => undefined,
        javaPath: null,
        redact: [settings.adminPassword],
        readiness: async () => {
          await this.rcon(rcon, 'GetGameLog');
          return true;
        },
      },
    };
  }

  async sendCommand(server: Server, _dir: string, command: string): Promise<string[]> {
    const settings = parseArkSettings(server);
    const answer = await this.rcon({ port: settings.rconPort, password: settings.adminPassword }, command);
    return answer.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line !== '');
  }

  // saveworld first, so nothing since the last autosave is lost, then doexit
  async stop(server: Server): Promise<void> {
    const settings = parseArkSettings(server);
    const rcon = { port: settings.rconPort, password: settings.adminPassword };
    await this.rcon(rcon, 'SaveWorld');
    await this.rcon(rcon, 'DoExit');
  }

  async playerList(server: Server): Promise<{ names: string[] | null; count: number | null }> {
    const settings = parseArkSettings(server);
    const players = parseListPlayers(await this.rcon({ port: settings.rconPort, password: settings.adminPassword }, 'ListPlayers'));
    this.known.set(server.id, new Map(players.map((player) => [player.name, player.steamId])));
    return { names: players.map((player) => player.name), count: players.length };
  }

  // the player actions of ARK need the Steam id; a name is looked up in the last player list
  resolvePlayer(serverId: string, nameOrId: string): string {
    if (/^\d{15,20}$/.test(nameOrId)) return nameOrId;
    const id = this.known.get(serverId)?.get(nameOrId);
    if (id === undefined) throw new AppError(422, 'PLAYER_ID_UNKNOWN', 'ARK needs the Steam id of a player who is not online (17 digits).');
    return id;
  }

  // SavedArks holds the world, the players and the tribes; the server is stopped for the copy
  async backupLayout(_server: Server, dir: string): Promise<BackupLayout> {
    return {
      root: savedDir(dir),
      levelName: 'SavedArks',
      worlds: () => ['SavedArks'],
      configFiles: [],
      configDirs: ['Config'],
      live: false,
      validateLevel: (level) => {
        if (level !== 'SavedArks') throw new AppError(422, 'BACKUP_INVALID', 'The backup does not belong to an ARK server.');
        return level;
      },
    };
  }

  configFiles(_server: Server, dir: string): ConfigFile[] {
    const folder = path.join(savedDir(dir), 'Config', this.platformDir);
    const display = `server/ShooterGame/Saved/Config/${this.platformDir}`;
    return [
      { key: 'gameusersettings', label: 'GameUserSettings.ini', description: 'Server settings ([ServerSettings]): difficulty, rates, PvE, passwords, ActiveMods. Created on the first start.', file: path.join(folder, 'GameUserSettings.ini'), display: `${display}/GameUserSettings.ini`, format: 'ini' },
      { key: 'game', label: 'Game.ini', description: 'Detailed game rules (level caps, engram points, loot). Optional.', file: path.join(folder, 'Game.ini'), display: `${display}/Game.ini`, format: 'ini' },
    ];
  }
}
