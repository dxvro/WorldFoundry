import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { msg } from '../../messages.js';
import type { LineEvent } from '../../process/patterns.js';
import type { SteamCmd } from '../../steam/steamcmd.js';
import { gameDefinition } from '../registry.js';
import type { GameAdapter, InstallContext, StartPlan } from '../types.js';
import { readIniValues, setIniValues } from './ini.js';

export const ZOMBOID_APP_ID = 380870;
export const DEFAULT_GAME_PORT = 16261;

// A server folder: server/ holds the files from SteamCMD, data/ is the game's cache folder (-cachedir) with
// Server/<profile>.ini, Saves/ and db/. Keeping them apart lets a reinstall replace the program without touching worlds.
export const binaryDir = (dir: string): string => path.join(dir, 'server');
export const dataDir = (dir: string): string => path.join(dir, 'data');
export const iniFile = (dir: string, profile: string): string => path.join(dataDir(dir), 'Server', `${profile}.ini`);

export const ZomboidSettingsSchema = z
  .object({
    profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Letters, digits, _ and - only'),
    branch: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).refine((value) => !value.startsWith('-')),
    udpPort: z.number().int().min(1024).max(65535),
    // the in-game admin account of the first start; shown in the interface, needed to log in as admin
    adminPassword: z.string().min(8).max(128),
  })
  .strict();
export type ZomboidSettings = z.infer<typeof ZomboidSettingsSchema>;

export const CreateZomboidSchema = z
  .object({
    game: z.literal('zomboid'),
    name: z.string().trim().min(1).max(60),
    profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('servertest'),
    branch: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).refine((value) => !value.startsWith('-'), 'Invalid branch').default('public'),
    port: z.number().int().min(1024).max(65535).optional(),
    udpPort: z.number().int().min(1024).max(65535).optional(),
    maxRamMb: z.number().int().min(1024).max(262_144).default(4096),
  })
  .strict();

export function parseZomboidSettings(server: Pick<Server, 'gameSettings'>): ZomboidSettings {
  try {
    return ZomboidSettingsSchema.parse(JSON.parse(server.gameSettings));
  } catch {
    throw new AppError(500, 'GAME_SETTINGS_INVALID', 'The stored settings of this server are damaged.');
  }
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

// PZ listens on UDP; the core only checks the TCP side of the game port
export function probeUdp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', () => {
      socket.close();
      resolve(false);
    });
    socket.bind(port, '0.0.0.0', () => socket.close(() => resolve(true)));
  });
}

// Log lines of the dedicated server (build 41 and 42). Player lines are best effort: the format is not documented.
const READY = /\*\*\* SERVER STARTED \*\*\*/;
const JOIN = /ConnectionManager: \[fully-connected\].*\busername="([^"\r\n]{1,64})"/;
const LEAVE = /ConnectionManager: \[disconnect\].*\busername="([^"\r\n]{1,64})"/;

export function classifyZomboidLine(line: string): LineEvent | null {
  if (line.length > 1000) return null;
  if (READY.test(line)) return { type: 'done' };
  const joined = JOIN.exec(line)?.[1];
  if (joined !== undefined) return { type: 'join', name: joined };
  const left = LEAVE.exec(line)?.[1];
  if (left !== undefined) return { type: 'leave', name: left };
  return null;
}

export interface ZomboidAdapterOptions {
  steam: SteamCmd;
  platform?: NodeJS.Platform;
  probeUdp?: (port: number) => Promise<boolean>;
}

export class ZomboidAdapter implements GameAdapter {
  readonly definition = gameDefinition('zomboid');
  readonly stopCommand = 'quit';
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: ZomboidAdapterOptions) {
    this.platform = options.platform ?? process.platform;
  }

  classifyLine(line: string): LineEvent | null {
    return classifyZomboidLine(line);
  }

  async createColumns(raw: unknown, others: Server[]): Promise<Partial<Server>> {
    const input = CreateZomboidSchema.parse(raw);
    const taken = new Set<number>();
    for (const other of others) {
      taken.add(other.port);
      if (other.game === 'zomboid') taken.add(parseZomboidSettings(other).udpPort);
    }
    let port = input.port ?? DEFAULT_GAME_PORT;
    if (input.port === undefined) while (taken.has(port) || taken.has(port + 1)) port += 2;
    const udpPort = input.udpPort ?? port + 1;
    if (udpPort === port) throw new AppError(422, 'PORT_INVALID', 'The two UDP ports must differ.');
    for (const candidate of [port, udpPort]) {
      if (taken.has(candidate)) throw new AppError(409, 'PORT_IN_USE', `Port ${candidate} is already used by another server.`, { port: candidate }, { port: candidate });
    }
    const settings: ZomboidSettings = { profile: input.profile, branch: input.branch, udpPort, adminPassword: randomBytes(12).toString('base64url') };
    return {
      name: input.name,
      loader: 'vanilla',
      mcVersion: '',
      port,
      maxRamMb: input.maxRamMb,
      minRamMb: Math.min(1024, input.maxRamMb),
      // anonymous SteamCMD downloads need no license step from WorldFoundry; the game's own terms apply to the user
      eulaAccepted: true,
      gameSettings: JSON.stringify(settings),
    };
  }

  installTitle(server: Server): string {
    return `Project Zomboid (Steam branch ${parseZomboidSettings(server).branch})`;
  }

  async validateInstall(server: Server): Promise<void> {
    parseZomboidSettings(server);
    if (this.platform !== 'linux' && this.platform !== 'win32') throw new AppError(422, 'STEAMCMD_PLATFORM', 'SteamCMD servers are supported on Windows and Linux only.');
  }

  async install(server: Server, ctx: InstallContext): Promise<Partial<Server>> {
    const settings = parseZomboidSettings(server);
    ctx.progress('download', null, msg('INSTALL_STEP_RESOLVE'));
    ctx.log(`SteamCMD: app ${ZOMBOID_APP_ID}, branch ${settings.branch}, anonymous login`);
    await this.options.steam.appUpdate({
      appId: ZOMBOID_APP_ID,
      branch: settings.branch,
      dir: binaryDir(ctx.dir),
      validate: true,
      signal: ctx.signal,
      onLine: ctx.log,
      onProgress: ({ percent }) => ctx.progress('download', percent, msg('INSTALL_STEP_DOWNLOAD', { fileName: 'Project Zomboid', kib: 0 })),
    });
    const start = this.startFile(ctx.dir);
    if (!(await exists(start))) throw new AppError(500, 'SERVER_FILES_MISSING', 'SteamCMD finished, but the start file of the server is missing.');
    // the first settings: ports and name; everything else is created by the game on its first start
    const ini = iniFile(ctx.dir, settings.profile);
    await mkdir(path.dirname(ini), { recursive: true });
    const current = await readFile(ini, 'utf8').catch(() => '');
    const values = readIniValues(current);
    await writeFile(
      ini,
      setIniValues(current, {
        DefaultPort: String(server.port),
        UDPPort: String(settings.udpPort),
        ...(values.has('PublicName') ? {} : { PublicName: server.name }),
      }),
    );
    ctx.log(`Settings: ${path.relative(ctx.dir, ini)}`);
    return {};
  }

  private startFile(dir: string): string {
    return this.platform === 'win32' ? path.join(binaryDir(dir), 'jre64', 'bin', 'java.exe') : path.join(binaryDir(dir), 'start-server.sh');
  }

  async planStart(server: Server, dir: string): Promise<StartPlan> {
    const settings = parseZomboidSettings(server);
    const bin = binaryDir(dir);
    const start = this.startFile(dir);
    if (!(await exists(start))) throw new AppError(409, 'SERVER_FILES_MISSING', 'The start file of the server is missing. Please start the installation again.');
    const cache = path.resolve(dataDir(dir));
    await mkdir(cache, { recursive: true });
    // without a player database the dedicated server waits for an admin password on the console
    const firstStart = !(await exists(path.join(cache, 'db', `${settings.profile}.db`)));
    const gameArgs = ['-servername', settings.profile, `-cachedir=${cache}`, ...(firstStart ? ['-adminpassword', settings.adminPassword] : [])];
    const memory = [`-Xms${Math.min(server.minRamMb, server.maxRamMb)}m`, `-Xmx${server.maxRamMb}m`];

    let command: string;
    let args: string[];
    if (this.platform === 'win32') {
      // the bundled Java directly, so no user value ever passes through cmd.exe
      command = start;
      args = [...memory, '-Dzomboid.steam=1', '-Dzomboid.znetlog=1', '-Djava.library.path=natives/;win64/;.', '-cp', 'java/;java/*', 'zombie.network.GameServer', ...gameArgs];
    } else {
      // start-server.sh reads the heap size from ProjectZomboid64.json, not from its arguments
      const json = path.join(bin, 'ProjectZomboid64.json');
      let config: { vmArgs?: unknown };
      try {
        config = JSON.parse(await readFile(json, 'utf8')) as { vmArgs?: unknown };
      } catch {
        throw new AppError(409, 'SERVER_FILES_MISSING', 'ProjectZomboid64.json is missing or damaged. Please start the installation again.');
      }
      if (!Array.isArray(config.vmArgs) || !config.vmArgs.every((value) => typeof value === 'string')) {
        throw new AppError(409, 'SERVER_FILES_MISSING', 'ProjectZomboid64.json has no valid vmArgs. Please start the installation again.');
      }
      config.vmArgs = [...(config.vmArgs as string[]).filter((value) => !/^-Xm[sx]/.test(value)), ...memory];
      await writeFile(json, `${JSON.stringify(config, null, 2)}\n`);
      command = '/bin/bash';
      args = [start, ...gameArgs];
    }
    const probe = this.options.probeUdp ?? probeUdp;
    return {
      kind: 'launch',
      plan: {
        command,
        args,
        cwd: bin,
        port: server.port,
        startLine: msg('SERVER_STARTING_GAME', { game: 'Project Zomboid', port: server.port }),
        notes: [],
        beforeSpawn: async () => {
          for (const port of [server.port, settings.udpPort]) {
            if (!(await probe(port))) throw new AppError(409, 'PORT_IN_USE', `UDP port ${port} is already in use by another program.`, { port }, { port });
          }
        },
        javaPath: null,
        redact: [settings.adminPassword],
      },
    };
  }
}
