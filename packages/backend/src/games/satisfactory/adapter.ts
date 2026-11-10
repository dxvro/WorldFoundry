import { access, mkdir } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
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
import type { ConfigFile, GameAdapter, InstallContext, StartPlan } from '../types.js';

export const SATISFACTORY_APP_ID = 1690800;
export const DEFAULT_PORT = 7777;
export const DEFAULT_RELIABLE_PORT = 8888;

export const binaryDir = (dir: string): string => path.join(dir, 'server');
// Linux: the server writes below $HOME/.config/Epic; every server gets its own home, so saves never mix
export const homeDir = (dir: string): string => path.join(dir, 'home');

export const SatisfactorySettingsSchema = z
  .object({
    branch: z.enum(['public', 'experimental']),
    reliablePort: z.number().int().min(1024).max(65535),
  })
  .strict();
export type SatisfactorySettings = z.infer<typeof SatisfactorySettingsSchema>;

export const CreateSatisfactorySchema = z
  .object({
    game: z.literal('satisfactory'),
    name: z.string().trim().min(1).max(60),
    branch: z.enum(['public', 'experimental']).default('public'),
    port: z.number().int().min(1024).max(65535).optional(),
    reliablePort: z.number().int().min(1024).max(65535).optional(),
  })
  .strict();

export function parseSatisfactorySettings(server: Pick<Server, 'gameSettings'>): SatisfactorySettings {
  try {
    return SatisfactorySettingsSchema.parse(JSON.parse(server.gameSettings));
  } catch {
    throw new AppError(500, 'GAME_SETTINGS_INVALID', 'The stored settings of this server are damaged.');
  }
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

// The dedicated server's HTTPS API answers HealthCheck without a login once the game is up. Its certificate is
// self-signed, and the request only ever goes to this computer.
export function healthCheck(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ function: 'HealthCheck', data: { clientCustomData: '' } });
    const request = https.request(
      { host: '127.0.0.1', port, path: '/api/v1', method: 'POST', rejectUnauthorized: false, timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (text.length < 10_000) text += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(text) as { data?: { health?: unknown } };
            resolve(response.statusCode === 200 && typeof parsed.data?.health === 'string');
          } catch {
            resolve(false);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end(body);
  });
}

function apiCall(port: number, fn: string, data: Record<string, unknown> | null, token: string | null, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data === null ? { function: fn } : { function: fn, data });
    const headers: Record<string, string | number> = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (token !== null) headers['Authorization'] = `Bearer ${token}`;
    const request = https.request({ host: '127.0.0.1', port, path: '/api/v1', method: 'POST', rejectUnauthorized: false, timeout: timeoutMs, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        if (text.length < 100_000) text += chunk;
      });
      response.on('end', () => {
        try {
          resolve(text === '' ? null : JSON.parse(text));
        } catch {
          reject(new Error('invalid answer'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

// Players online, through the HTTPS API: a client login works without a password unless the owner set a
// client protection password; then the number stays unknown.
export async function satisfactoryPlayerCount(port: number): Promise<number | null> {
  const login = (await apiCall(port, 'PasswordlessLogin', { minimumPrivilegeLevel: 'Client' }, null)) as { data?: { authenticationToken?: unknown } } | null;
  const token = login?.data?.authenticationToken;
  if (typeof token !== 'string') return null;
  const state = (await apiCall(port, 'QueryServerState', null, token)) as { data?: { serverGameState?: { numConnectedPlayers?: unknown } } } | null;
  const count = state?.data?.serverGameState?.numConnectedPlayers;
  return typeof count === 'number' ? count : null;
}

export interface SatisfactoryAdapterOptions {
  steam: SteamCmd;
  platform?: NodeJS.Platform;
  health?: (port: number) => Promise<boolean>;
  playerCount?: (port: number) => Promise<number | null>;
  // %LOCALAPPDATA% on Windows, where the server keeps its saves whatever the working folder
  localAppData?: string;
}

export class SatisfactoryAdapter implements GameAdapter {
  readonly definition = gameDefinition('satisfactory');
  // the server reads no console input; SIGINT makes it save and quit on Linux
  readonly stopCommand = null;
  readonly stopSignal = 'SIGINT' as const;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: SatisfactoryAdapterOptions) {
    this.platform = options.platform ?? process.platform;
  }

  classifyLine(): LineEvent | null {
    return null;
  }

  async playerList(server: Server): Promise<{ names: string[] | null; count: number | null }> {
    return { names: null, count: await (this.options.playerCount ?? satisfactoryPlayerCount)(server.port) };
  }

  private get platformDir(): string {
    return this.platform === 'win32' ? 'WindowsServer' : 'LinuxServer';
  }

  // FactoryGame/Saved: config and save games
  savedDir(dir: string): string {
    if (this.platform === 'win32') {
      const base = this.options.localAppData ?? process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
      return path.join(base, 'FactoryGame', 'Saved');
    }
    return path.join(homeDir(dir), '.config', 'Epic', 'FactoryGame', 'Saved');
  }

  executable(dir: string): string {
    return this.platform === 'win32'
      ? path.join(binaryDir(dir), 'Engine', 'Binaries', 'Win64', 'FactoryServer-Win64-Shipping-Cmd.exe')
      : path.join(binaryDir(dir), 'Engine', 'Binaries', 'Linux', 'FactoryServer-Linux-Shipping');
  }

  async createColumns(raw: unknown, others: Server[]): Promise<Partial<Server>> {
    const input = CreateSatisfactorySchema.parse(raw);
    const taken = takenPorts(others);
    let port = input.port ?? DEFAULT_PORT;
    let reliablePort = input.reliablePort ?? DEFAULT_RELIABLE_PORT;
    if (input.port === undefined) while (taken.has(port)) port += 1;
    if (input.reliablePort === undefined) while (taken.has(reliablePort) || reliablePort === port) reliablePort += 1;
    if (port === reliablePort) throw new AppError(422, 'PORT_INVALID', 'The game port and the reliable port must differ.');
    for (const candidate of [port, reliablePort]) {
      if (taken.has(candidate)) throw new AppError(409, 'PORT_IN_USE', `Port ${candidate} is already used by another server.`, { port: candidate }, { port: candidate });
    }
    const settings: SatisfactorySettings = { branch: input.branch, reliablePort };
    return { name: input.name, loader: 'vanilla', mcVersion: '', port, maxRamMb: 12_288, minRamMb: 1024, eulaAccepted: true, gameSettings: JSON.stringify(settings) };
  }

  installTitle(server: Server): string {
    return `Satisfactory (Steam branch ${parseSatisfactorySettings(server).branch})`;
  }

  async validateInstall(server: Server): Promise<void> {
    parseSatisfactorySettings(server);
    if (this.platform !== 'linux' && this.platform !== 'win32') throw new AppError(422, 'STEAMCMD_PLATFORM', 'SteamCMD servers are supported on Windows and Linux only.');
  }

  async install(server: Server, ctx: InstallContext): Promise<Partial<Server>> {
    const settings = parseSatisfactorySettings(server);
    ctx.progress('download', null, msg('INSTALL_STEP_RESOLVE'));
    ctx.log(`SteamCMD: app ${SATISFACTORY_APP_ID}, branch ${settings.branch}, anonymous login`);
    await this.options.steam.appUpdate({
      appId: SATISFACTORY_APP_ID,
      branch: settings.branch,
      dir: binaryDir(ctx.dir),
      validate: true,
      signal: ctx.signal,
      onLine: ctx.log,
      onProgress: ({ percent }) => ctx.progress('download', percent, msg('INSTALL_STEP_DOWNLOAD', { fileName: 'Satisfactory', kib: 0 })),
    });
    if (!(await exists(this.executable(ctx.dir)))) throw new AppError(500, 'SERVER_FILES_MISSING', 'SteamCMD finished, but the server program is missing.');
    await mkdir(homeDir(ctx.dir), { recursive: true });
    return {};
  }

  async planStart(server: Server, dir: string): Promise<StartPlan> {
    const settings = parseSatisfactorySettings(server);
    const executable = this.executable(dir);
    if (!(await exists(executable))) throw new AppError(409, 'SERVER_FILES_MISSING', 'The server program is missing. Please start the installation again.');
    await mkdir(homeDir(dir), { recursive: true });
    const health = this.options.health ?? healthCheck;
    return {
      kind: 'launch',
      plan: {
        command: executable,
        args: ['FactoryGame', `-Port=${server.port}`, `-ReliablePort=${settings.reliablePort}`, '-log', '-unattended'],
        cwd: binaryDir(dir),
        port: server.port,
        startLine: msg('SERVER_STARTING_GAME', { game: 'Satisfactory', port: server.port }),
        notes: [],
        beforeSpawn: async () => undefined,
        javaPath: null,
        ...(this.platform === 'win32' ? {} : { env: { HOME: homeDir(dir), XDG_CONFIG_HOME: path.join(homeDir(dir), '.config') } }),
        readiness: () => health(server.port),
      },
    };
  }

  // The save games and the server settings (ServerSettings.<port>.sav: name, passwords, certificate) belong together.
  // The game has no "pause saving", so backups run while it is stopped.
  async backupLayout(server: Server, dir: string): Promise<BackupLayout> {
    return {
      root: path.join(this.savedDir(dir), 'SaveGames'),
      levelName: 'server',
      worlds: () => ['server'],
      configFiles: [`ServerSettings.${server.port}.sav`],
      configDirs: [],
      live: false,
      validateLevel: (level) => {
        if (level !== 'server') throw new AppError(422, 'BACKUP_INVALID', 'The backup does not belong to a Satisfactory server.');
        return level;
      },
    };
  }

  configFiles(_server: Server, dir: string): ConfigFile[] {
    const configDir = path.join(this.savedDir(dir), 'Config', this.platformDir);
    const display = this.platform === 'win32' ? `%LOCALAPPDATA%/FactoryGame/Saved/Config/${this.platformDir}` : `home/.config/Epic/FactoryGame/Saved/Config/${this.platformDir}`;
    const file = (name: string, label: string, description: string): ConfigFile => ({ key: name.replace('.ini', '').toLowerCase(), label, description, file: path.join(configDir, name), display: `${display}/${name}`, format: 'ini' });
    return [
      file('Game.ini', 'Game.ini', 'Engine settings of the game, for example the player limit ([/Script/Engine.GameSession] MaxPlayers). Created on the first start.'),
      file('Engine.ini', 'Engine.ini', 'Network and autosave settings of the engine. Created on the first start.'),
      file('GameUserSettings.ini', 'GameUserSettings.ini', 'Further server settings. Created on the first start.'),
    ];
  }
}
