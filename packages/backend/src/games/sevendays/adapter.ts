import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BackupLayout } from '../../backups/world.js';
import type { Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { telnetCommand, type TelnetTarget } from '../../lib/telnet.js';
import { msg } from '../../messages.js';
import type { LineEvent } from '../../process/patterns.js';
import type { SteamCmd } from '../../steam/steamcmd.js';
import { takenPorts } from '../ports.js';
import { gameDefinition } from '../registry.js';
import { allocatePorts, allocateSingle, exists, parseGameSettings, requireProgram, safeText, steamInstall } from '../steam-game.js';
import type { ConfigFile, GameAdapter, InstallContext, StartPlan } from '../types.js';
import { sevenDaysCustomMods } from './custom-mods.js';
import { sevenDaysWorldImport } from './world-import.js';

export const SEVENDAYS_APP_ID = 294420;
export const DEFAULT_PORT = 26900;
export const DEFAULT_TELNET_PORT = 8081;

export const binaryDir = (dir: string): string => path.join(dir, 'server');
// UserDataFolder: Saves/<world>/<game>, GeneratedWorlds/<world>, serveradmin.xml in Saves
export const dataDir = (dir: string): string => path.join(dir, 'data');
export const configPath = (dir: string): string => path.join(dataDir(dir), 'serverconfig.xml');

const NAME = /^[A-Za-z0-9 _-]{1,40}$/;

export const SevenDaysSettingsSchema = z
  .object({
    // Navezgane is the hand-made map; RWG generates one from the seed
    world: z.string().regex(NAME),
    gameName: z.string().regex(NAME),
    seed: z.string().regex(NAME),
    worldSize: z.number().int().min(4096).max(16384),
    maxPlayers: z.number().int().min(1).max(64),
    password: z.string().max(64),
    telnetPort: z.number().int(),
    telnetPassword: z.string().min(8).max(64),
    extraPorts: z.array(z.number().int()),
  })
  .strict();
export type SevenDaysSettings = z.infer<typeof SevenDaysSettingsSchema>;

export const CreateSevenDaysSchema = z
  .object({
    game: z.literal('sevendays'),
    name: z.string().trim().min(1).max(60),
    world: z.string().regex(NAME).default('Navezgane'),
    gameName: z.string().regex(NAME).default('MyGame'),
    seed: z.string().regex(NAME).default('WorldFoundry'),
    worldSize: z.number().int().min(4096).max(16384).default(6144),
    maxPlayers: z.number().int().min(1).max(64).default(8),
    password: z.string().max(64).default(''),
    port: z.number().int().min(1024).max(65533).optional(),
  })
  .strict();

export const EditSevenDaysSchema = z
  .object({ world: z.string().regex(NAME), gameName: z.string().regex(NAME), seed: z.string().regex(NAME), worldSize: z.number().int().min(4096).max(16384), maxPlayers: z.number().int().min(1).max(64), password: z.string().max(64) })
  .partial()
  .strict();

export const parseSevenDaysSettings = (server: Pick<Server, 'gameSettings'>): SevenDaysSettings => parseGameSettings(SevenDaysSettingsSchema, server);

const xmlEscape = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Sets <property name="X" value="..."/> in serverconfig.xml; a property the file lacks is added before </ServerSettings>
export function setProperties(xml: string, values: Record<string, string>): string {
  let text = xml;
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`(<property\\s+name="${name}"\\s+value=")[^"]*(")`);
    if (pattern.test(text)) text = text.replace(pattern, `$1${xmlEscape(value)}$2`);
    else text = text.replace(/<\/ServerSettings>/, `\t<property name="${name}" value="${xmlEscape(value)}"/>\n</ServerSettings>`);
  }
  return text;
}

const READY = /GameServer\.Init successful|StartGame done/;
const SPAWNED = /PlayerSpawnedInWorld \(reason: (?:JoinMultiplayer|EnterMultiplayer)[^)]*\).*PlayerName='([^']{1,40})'/;
const LEFT = /Player disconnected: .*PlayerName='([^']{1,40})'/;

export function classifySevenDaysLine(line: string): LineEvent | null {
  if (line.length > 2000) return null;
  if (READY.test(line)) return { type: 'done' };
  const joined = SPAWNED.exec(line)?.[1];
  if (joined !== undefined) return { type: 'join', name: joined };
  const left = LEFT.exec(line)?.[1];
  if (left !== undefined) return { type: 'leave', name: left };
  return null;
}

export type Telnet = (target: TelnetTarget, command: string) => Promise<string>;

export interface SevenDaysAdapterOptions {
  steam: SteamCmd;
  platform?: NodeJS.Platform;
  telnet?: Telnet;
}

export class SevenDaysAdapter implements GameAdapter {
  readonly definition = gameDefinition('sevendays');
  readonly worldImport = sevenDaysWorldImport;
  readonly customMods = sevenDaysCustomMods;
  // the server reads no console input: commands, the player list and the clean stop go through telnet
  readonly stopCommand = null;
  readonly stopSignal = 'SIGINT' as const;
  readonly playerActions = [
    { id: 'kick', label: 'Kick', confirm: false, command: (name: string) => `kick "${name}"` },
    { id: 'ban', label: 'Ban', confirm: true, command: (name: string) => `ban add "${name}" 10 years` },
    { id: 'unban', label: 'Unban', confirm: false, command: (name: string) => `ban remove "${name}"` },
    { id: 'admin', label: 'Make admin', confirm: true, command: (name: string) => `admin add "${name}" 0` },
  ];
  private readonly platform: NodeJS.Platform;
  private readonly telnet: Telnet;

  constructor(private readonly options: SevenDaysAdapterOptions) {
    this.platform = options.platform ?? process.platform;
    this.telnet = options.telnet ?? telnetCommand;
  }

  executable(dir: string): string {
    return path.join(binaryDir(dir), this.platform === 'win32' ? '7DaysToDieServer.exe' : '7DaysToDieServer.x86_64');
  }

  classifyLine(line: string): LineEvent | null {
    return classifySevenDaysLine(line);
  }

  private target(server: Server): TelnetTarget {
    const settings = parseSevenDaysSettings(server);
    return { port: settings.telnetPort, password: settings.telnetPassword };
  }

  async sendCommand(server: Server, _dir: string, command: string): Promise<string[]> {
    const answer = await this.telnet(this.target(server), command);
    return answer.split('\n').filter((line) => line.trim() !== '');
  }

  async stop(server: Server): Promise<void> {
    await this.telnet(this.target(server), 'saveworld');
    await this.telnet({ ...this.target(server), quietMs: 200 }, 'shutdown');
  }

  // "lp": one line per player "0. id=171, Bob, pos=(...)", then "Total of N in the game"
  async playerList(server: Server): Promise<{ names: string[] | null; count: number | null }> {
    const answer = await this.telnet(this.target(server), 'lp');
    const names = [...answer.matchAll(/^\d+\. id=\d+, ([^,]{1,40}),/gm)].map((match) => match[1] ?? '').filter((name) => name !== '');
    const total = /Total of (\d+) in the game/.exec(answer)?.[1];
    return { names, count: total === undefined ? names.length : Number(total) };
  }

  async createColumns(raw: unknown, others: Server[]): Promise<Partial<Server>> {
    const input = CreateSevenDaysSchema.parse(raw);
    safeText(input.name, 'server name');
    if (input.password !== '') safeText(input.password, 'password');
    const taken = takenPorts(others);
    const port = allocatePorts(input.port, DEFAULT_PORT, [0, 1, 2], taken);
    for (const offset of [0, 1, 2]) taken.add(port + offset);
    const telnetPort = allocateSingle(undefined, DEFAULT_TELNET_PORT, taken);
    const settings: SevenDaysSettings = {
      world: input.world,
      gameName: input.gameName,
      seed: input.seed,
      worldSize: input.worldSize,
      maxPlayers: input.maxPlayers,
      password: input.password,
      telnetPort,
      telnetPassword: randomBytes(12).toString('base64url'),
      extraPorts: [port + 1, port + 2],
    };
    return { name: input.name, loader: 'vanilla', mcVersion: '', port, maxRamMb: 8192, minRamMb: 1024, eulaAccepted: true, gameSettings: JSON.stringify(settings) };
  }

  async applySettings(server: Server, raw: unknown): Promise<Partial<Server>> {
    const next = { ...parseSevenDaysSettings(server), ...EditSevenDaysSchema.parse(raw) };
    if (next.password !== '') safeText(next.password, 'password');
    return { gameSettings: JSON.stringify(SevenDaysSettingsSchema.parse(next)) };
  }

  installTitle(): string {
    return '7 Days to Die';
  }

  async validateInstall(server: Server): Promise<void> {
    parseSevenDaysSettings(server);
    if (this.platform !== 'linux' && this.platform !== 'win32') throw new AppError(422, 'STEAMCMD_PLATFORM', 'SteamCMD servers are supported on Windows and Linux only.');
  }

  async install(_server: Server, ctx: InstallContext): Promise<Partial<Server>> {
    await steamInstall(ctx, { steam: this.options.steam, appId: SEVENDAYS_APP_ID, branch: 'public', title: '7 Days to Die', dir: binaryDir(ctx.dir) });
    await requireProgram(this.executable(ctx.dir), 'install');
    await mkdir(dataDir(ctx.dir), { recursive: true });
    // the template that ships with the server, so every setting is documented in the file
    if (!(await exists(configPath(ctx.dir))) && (await exists(path.join(binaryDir(ctx.dir), 'serverconfig.xml')))) {
      await copyFile(path.join(binaryDir(ctx.dir), 'serverconfig.xml'), configPath(ctx.dir));
    }
    return {};
  }

  // The settings WorldFoundry owns are written into serverconfig.xml on every start; everything else in it is the user's
  private async writeConfig(server: Server, dir: string): Promise<void> {
    const settings = parseSevenDaysSettings(server);
    const current = await readFile(configPath(dir), 'utf8').catch(() => '<?xml version="1.0"?>\n<ServerSettings>\n</ServerSettings>\n');
    await writeFile(
      configPath(dir),
      setProperties(current, {
        ServerName: server.name,
        ServerPort: String(server.port),
        ServerMaxPlayerCount: String(settings.maxPlayers),
        ServerPassword: settings.password,
        GameWorld: settings.world,
        WorldGenSeed: settings.seed,
        WorldGenSize: String(settings.worldSize),
        GameName: settings.gameName,
        UserDataFolder: dataDir(dir),
        TelnetEnabled: 'true',
        TelnetPort: String(settings.telnetPort),
        TelnetPassword: settings.telnetPassword,
        TelnetFailedLoginLimit: '10',
        WebDashboardEnabled: 'false',
      }),
    );
  }

  async planStart(server: Server, dir: string): Promise<StartPlan> {
    const settings = parseSevenDaysSettings(server);
    const executable = this.executable(dir);
    await requireProgram(executable, 'start');
    await mkdir(dataDir(dir), { recursive: true });
    await this.writeConfig(server, dir);
    return {
      kind: 'launch',
      plan: {
        command: executable,
        // "-logfile -" sends the Unity log to the console WorldFoundry reads
        args: ['-quit', '-batchmode', '-nographics', '-dedicated', `-configfile=${configPath(dir)}`, '-logfile', '-'],
        cwd: binaryDir(dir),
        port: server.port,
        startLine: msg('SERVER_STARTING_GAME', { game: '7 Days to Die', port: server.port }),
        notes: [],
        beforeSpawn: async () => undefined,
        javaPath: null,
        redact: [settings.telnetPassword, ...(settings.password === '' ? [] : [settings.password])],
        ...(this.platform === 'win32' ? {} : { env: { LD_LIBRARY_PATH: `${binaryDir(dir)}${process.env['LD_LIBRARY_PATH'] === undefined ? '' : `:${process.env['LD_LIBRARY_PATH']}`}` } }),
      },
    };
  }

  // Saves holds the games and serveradmin.xml, GeneratedWorlds the random worlds; serverconfig.xml is the configuration
  async backupLayout(_server: Server, dir: string): Promise<BackupLayout> {
    return {
      root: dataDir(dir),
      levelName: 'Saves',
      worlds: () => ['Saves', 'GeneratedWorlds'],
      configFiles: ['serverconfig.xml'],
      configDirs: [],
      live: false,
      validateLevel: (level) => {
        if (level !== 'Saves') throw new AppError(422, 'BACKUP_INVALID', 'The backup does not belong to a 7 Days to Die server.');
        return level;
      },
    };
  }

  configFiles(_server: Server, dir: string): ConfigFile[] {
    return [
      { key: 'serverconfig', label: 'serverconfig.xml', description: 'All game rules (difficulty, loot, day length, blood moon …). Name, port, players, password, world and telnet are set by WorldFoundry on every start.', file: configPath(dir), display: 'data/serverconfig.xml', format: 'text' },
      { key: 'serveradmin', label: 'serveradmin.xml', description: 'Admins, whitelist and bans. Created on the first start.', file: path.join(dataDir(dir), 'Saves', 'serveradmin.xml'), display: 'data/Saves/serveradmin.xml', format: 'text' },
    ];
  }
}
