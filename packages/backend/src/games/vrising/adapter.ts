import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BackupLayout } from '../../backups/world.js';
import type { Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { a2sInfo } from '../../lib/a2s.js';
import { rconCommand } from '../../lib/rcon.js';
import { msg } from '../../messages.js';
import type { LineEvent } from '../../process/patterns.js';
import type { SteamCmd } from '../../steam/steamcmd.js';
import type { Rcon } from '../ark/adapter.js';
import { ensureProton, installedProton, protonVersion } from '../asa/proton.js';
import { takenPorts } from '../ports.js';
import { gameDefinition } from '../registry.js';
import { allocatePorts, allocateSingle, exists, parseGameSettings, requireProgram, safeText, steamInstall } from '../steam-game.js';
import type { ConfigFile, GameAdapter, InstallContext, StartPlan, WorldImportSupport } from '../types.js';
import { findDirs, moveInto, noWorld } from '../../worldio/game-world.js';

// V Rising (Stunlock Studios). The dedicated server is a Windows program; on Linux it runs through GE-Proton like the
// ARK: Survival Ascended server. Everything WorldFoundry manages is passed on the command line, which the official
// instructions document as overrides of ServerHostSettings.json; the saves and settings live in -persistentDataPath.
export const VRISING_APP_ID = 1829350;
export const DEFAULT_PORT = 9876;
export const DEFAULT_RCON_PORT = 9900;

export const binaryDir = (dir: string): string => path.join(dir, 'server');
// -persistentDataPath: Saves/v4/<save name>/, Settings/ (adminlist.txt, banlist.txt, ServerGameSettings.json)
export const dataDir = (dir: string): string => path.join(dir, 'data');

const SAVE = /^[A-Za-z0-9_-]{1,40}$/;
export const VRISING_MODES = ['StandardPvP', 'StandardPvE', 'custom'] as const;
export const VRISING_DIFFICULTIES = ['Difficulty_Easy', 'Difficulty_Normal', 'Difficulty_Brutal'] as const;

export const VRisingSettingsSchema = z
  .object({
    saveName: z.string().regex(SAVE),
    maxPlayers: z.number().int().min(1).max(128),
    password: z.string().max(64),
    // the game settings preset; 'custom' loads Settings/ServerGameSettings.json instead
    mode: z.enum(VRISING_MODES),
    difficulty: z.enum(VRISING_DIFFICULTIES),
    public: z.boolean(),
    queryPort: z.number().int(),
    rconPort: z.number().int(),
    rconPassword: z.string().min(8).max(64),
  })
  .strict();
export type VRisingSettings = z.infer<typeof VRisingSettingsSchema>;

export const CreateVRisingSchema = z
  .object({
    game: z.literal('vrising'),
    name: z.string().trim().min(1).max(60),
    saveName: z.string().regex(SAVE, 'Letters, digits, _ and - only').default('world1'),
    maxPlayers: z.number().int().min(1).max(128).default(40),
    password: z.string().max(64).default(''),
    mode: z.enum(VRISING_MODES).default('StandardPvP'),
    difficulty: z.enum(VRISING_DIFFICULTIES).default('Difficulty_Normal'),
    public: z.boolean().default(false),
    port: z.number().int().min(1024).max(65534).optional(),
  })
  .strict();

export const EditVRisingSchema = z
  .object({
    saveName: z.string().regex(SAVE),
    maxPlayers: z.number().int().min(1).max(128),
    password: z.string().max(64),
    mode: z.enum(VRISING_MODES),
    difficulty: z.enum(VRISING_DIFFICULTIES),
    public: z.boolean(),
  })
  .partial()
  .strict();

export const parseVRisingSettings = (server: Pick<Server, 'gameSettings'>): VRisingSettings => parseGameSettings(VRisingSettingsSchema, server);

// A save from the game or another server: a session folder with AutoSave_<n> folders inside (on Windows the local saves
// are in %USERPROFILE%\AppData\LocalLow\Stunlock Studios\VRising\Saves\v4\<id>). It goes to Saves/v4/<folder name>.
export const vrisingWorldImport: WorldImportSupport = {
  native: async (staged, out, ctx) => {
    const sessions = await findDirs(staged, async (dir) => (await readdir(dir).catch(() => [] as string[])).some((name) => /^AutoSave_\d+$/.test(name)));
    if (sessions.length === 0) throw noWorld('V Rising', 'a save folder with AutoSave_<n> folders (Saves/v4/<name>)');
    const names: string[] = [];
    for (const session of sessions) {
      const name = path.basename(session).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'imported';
      await moveInto(session, path.join(out, 'Saves', 'v4', name));
      names.push(name);
    }
    const current = parseVRisingSettings(ctx.server).saveName;
    const warnings = names.includes(current) ? [] : [msg('GAME_IMPORT_WORLD_NAME', { found: names.join(', '), current })];
    return { worlds: ['Saves'], configItems: [], warnings };
  },
};

export interface VRisingAdapterOptions {
  steam: SteamCmd;
  protonRoot: string;
  platform?: NodeJS.Platform;
  rcon?: Rcon;
  playerCount?: (queryPort: number) => Promise<number | null>;
  fetch?: typeof fetch;
}

export class VRisingAdapter implements GameAdapter {
  readonly definition = gameDefinition('vrising');
  readonly worldImport = vrisingWorldImport;
  // the server reads no console input; it saves on its own every two minutes (AutoSaveInterval)
  readonly stopCommand = null;
  readonly stopSignal = 'SIGINT' as const;
  private readonly platform: NodeJS.Platform;
  private readonly rcon: Rcon;

  constructor(private readonly options: VRisingAdapterOptions) {
    this.platform = options.platform ?? process.platform;
    this.rcon = options.rcon ?? ((target, command) => rconCommand(target, command));
  }

  executable(dir: string): string {
    return path.join(binaryDir(dir), 'VRisingServer.exe');
  }

  classifyLine(): LineEvent | null {
    return null;
  }

  private target(server: Server): { port: number; password: string } {
    const settings = parseVRisingSettings(server);
    return { port: settings.rconPort, password: settings.rconPassword };
  }

  // RCON knows announce, password, name and a few more; the answer is shown in the console
  async sendCommand(server: Server, _dir: string, command: string): Promise<string[]> {
    const answer = await this.rcon(this.target(server), command);
    return answer.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line !== '');
  }

  async playerList(server: Server): Promise<{ names: string[] | null; count: number | null }> {
    const { queryPort } = parseVRisingSettings(server);
    const count = this.options.playerCount === undefined ? ((await a2sInfo(queryPort))?.players ?? null) : await this.options.playerCount(queryPort);
    return { names: null, count };
  }

  async createColumns(raw: unknown, others: Server[]): Promise<Partial<Server>> {
    const input = CreateVRisingSchema.parse(raw);
    safeText(input.name, 'server name');
    if (input.password !== '') safeText(input.password, 'password');
    const taken = takenPorts(others);
    const port = allocatePorts(input.port, DEFAULT_PORT, [0, 1], taken);
    taken.add(port);
    taken.add(port + 1);
    const rconPort = allocateSingle(undefined, DEFAULT_RCON_PORT, taken);
    const settings: VRisingSettings = {
      saveName: input.saveName,
      maxPlayers: input.maxPlayers,
      password: input.password,
      mode: input.mode,
      difficulty: input.difficulty,
      public: input.public,
      queryPort: port + 1,
      rconPort,
      rconPassword: randomBytes(12).toString('base64url'),
    };
    return { name: input.name, loader: 'vanilla', mcVersion: '', port, maxRamMb: 8192, minRamMb: 1024, eulaAccepted: true, gameSettings: JSON.stringify(settings) };
  }

  async applySettings(server: Server, raw: unknown): Promise<Partial<Server>> {
    const next = { ...parseVRisingSettings(server), ...EditVRisingSchema.parse(raw) };
    if (next.password !== '') safeText(next.password, 'password');
    return { gameSettings: JSON.stringify(VRisingSettingsSchema.parse(next)) };
  }

  installTitle(): string {
    return this.platform === 'win32' ? 'V Rising' : 'V Rising (Windows server through GE-Proton)';
  }

  async validateInstall(server: Server): Promise<void> {
    parseVRisingSettings(server);
    if (this.platform !== 'linux' && this.platform !== 'win32') throw new AppError(422, 'STEAMCMD_PLATFORM', 'SteamCMD servers are supported on Windows and Linux only.');
  }

  async install(_server: Server, ctx: InstallContext): Promise<Partial<Server>> {
    await steamInstall(ctx, {
      steam: this.options.steam,
      appId: VRISING_APP_ID,
      branch: 'public',
      title: 'V Rising',
      dir: binaryDir(ctx.dir),
      ...(this.platform === 'win32' ? {} : { platformType: 'windows' as const }),
    });
    await requireProgram(this.executable(ctx.dir), 'install');
    if (this.platform !== 'win32') {
      const proton = await ensureProton(this.options.protonRoot, ctx, this.options.fetch);
      ctx.log(`Proton: ${await protonVersion(proton)}`);
    }
    // the custom game settings start as the server's defaults, so "Custom" has a file to edit
    const settings = path.join(dataDir(ctx.dir), 'Settings');
    await mkdir(settings, { recursive: true });
    const defaults = path.join(binaryDir(ctx.dir), 'VRisingServer_Data', 'StreamingAssets', 'Settings', 'ServerGameSettings.json');
    if ((await exists(defaults)) && !(await exists(path.join(settings, 'ServerGameSettings.json')))) await copyFile(defaults, path.join(settings, 'ServerGameSettings.json'));
    return {};
  }

  // the arguments of the official start script, plus everything WorldFoundry manages
  startArgs(server: Server, dir: string): string[] {
    const settings = parseVRisingSettings(server);
    return [
      '-persistentDataPath',
      dataDir(dir),
      '-logFile',
      path.join(dataDir(dir), 'VRisingServer.log'),
      '-serverName',
      server.name,
      '-saveName',
      settings.saveName,
      '-gamePort',
      String(server.port),
      '-queryPort',
      String(settings.queryPort),
      '-maxUsers',
      String(settings.maxPlayers),
      ...(settings.password === '' ? [] : ['-password', settings.password]),
      ...(settings.mode === 'custom' ? [] : ['-preset', settings.mode]),
      '-difficultyPreset',
      settings.difficulty,
      '-listOnSteam',
      String(settings.public),
      '-listOnEOS',
      String(settings.public),
      '-rconEnabled',
      'true',
      '-rconPort',
      String(settings.rconPort),
      '-rconPassword',
      settings.rconPassword,
    ];
  }

  async planStart(server: Server, dir: string): Promise<StartPlan> {
    const settings = parseVRisingSettings(server);
    const executable = this.executable(dir);
    await requireProgram(executable, 'start');
    await mkdir(path.join(dataDir(dir), 'Settings'), { recursive: true });
    const common = {
      port: server.port,
      startLine: msg('SERVER_STARTING_GAME', { game: 'V Rising', port: server.port }),
      notes: [msg('VRISING_LOG_FILE', { file: 'data/VRisingServer.log' })],
      beforeSpawn: async () => undefined,
      javaPath: null,
      redact: [settings.rconPassword, ...(settings.password === '' ? [] : [settings.password])],
      // the server answers RCON once the world is loaded
      readiness: async () => {
        await this.rcon(this.target(server), 'version');
        return true;
      },
    };
    if (this.platform === 'win32') {
      return { kind: 'launch', plan: { ...common, command: executable, args: this.startArgs(server, dir), cwd: binaryDir(dir) } };
    }
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
        args: ['run', executable, ...this.startArgs(server, dir)],
        cwd: binaryDir(dir),
        env: { STEAM_COMPAT_DATA_PATH: prefix, STEAM_COMPAT_CLIENT_INSTALL_PATH: client },
      },
    };
  }

  // Saves/ holds the save games, Settings/ the admin and ban lists and the custom game settings
  async backupLayout(_server: Server, dir: string): Promise<BackupLayout> {
    return {
      root: dataDir(dir),
      levelName: 'Saves',
      worlds: () => ['Saves'],
      configFiles: [],
      configDirs: ['Settings'],
      live: false,
      validateLevel: (level) => {
        if (level !== 'Saves') throw new AppError(422, 'BACKUP_INVALID', 'The backup does not belong to a V Rising server.');
        return level;
      },
    };
  }

  configFiles(_server: Server, dir: string): ConfigFile[] {
    const settings = path.join(dataDir(dir), 'Settings');
    return [
      {
        key: 'gamesettings',
        label: 'ServerGameSettings.json',
        description: 'The game rules (blood drain, castle limits, PvP times …). Used when the game mode is "Custom". The default is in server/VRisingServer_Data/StreamingAssets/Settings.',
        file: path.join(settings, 'ServerGameSettings.json'),
        display: 'data/Settings/ServerGameSettings.json',
        format: 'json',
      },
      { key: 'adminlist', label: 'Admins', description: 'One Steam id per line. Admins sign in in the game console with adminauth.', file: path.join(settings, 'adminlist.txt'), display: 'data/Settings/adminlist.txt', format: 'text' },
      { key: 'banlist', label: 'Banned players', description: 'One Steam id per line.', file: path.join(settings, 'banlist.txt'), display: 'data/Settings/banlist.txt', format: 'text' },
    ];
  }
}
