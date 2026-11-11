import { randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BackupLayout } from '../../backups/world.js';
import type { Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { a2sInfo } from '../../lib/a2s.js';
import { msg } from '../../messages.js';
import type { LineEvent } from '../../process/patterns.js';
import type { SteamCmd } from '../../steam/steamcmd.js';
import { takenPorts } from '../ports.js';
import { gameDefinition } from '../registry.js';
import { allocatePorts, parseGameSettings, requireProgram, safeText, steamInstall } from '../steam-game.js';
import type { ConfigFile, GameAdapter, InstallContext, StartPlan, WorldImportSupport } from '../types.js';
import { findFiles, moveInto, noWorld } from '../../worldio/game-world.js';

export const VALHEIM_APP_ID = 896660;
// the app id of the game itself; the server registers with it on Steam
const VALHEIM_GAME_APP_ID = '892970';
export const DEFAULT_PORT = 2456;

export const binaryDir = (dir: string): string => path.join(dir, 'server');
// -savedir: worlds_local/<world>.db and .fwl, adminlist.txt, bannedlist.txt, permittedlist.txt
export const saveDir = (dir: string): string => path.join(dir, 'data');

const WORLD = /^[A-Za-z0-9_-]{1,40}$/;

export const ValheimSettingsSchema = z
  .object({
    world: z.string().regex(WORLD),
    password: z.string().min(5).max(64),
    public: z.boolean(),
    crossplay: z.boolean(),
    queryPort: z.number().int(),
  })
  .strict();
export type ValheimSettings = z.infer<typeof ValheimSettingsSchema>;

export const CreateValheimSchema = z
  .object({
    game: z.literal('valheim'),
    name: z.string().trim().min(1).max(60),
    world: z.string().regex(WORLD, 'Letters, digits, _ and - only').default('Dedicated'),
    password: z.string().min(5).max(64).optional(),
    public: z.boolean().default(false),
    crossplay: z.boolean().default(false),
    port: z.number().int().min(1024).max(65534).optional(),
  })
  .strict();

// what can be changed later, while the server is stopped
export const EditValheimSchema = z
  .object({ world: z.string().regex(WORLD), password: z.string().min(5).max(64), public: z.boolean(), crossplay: z.boolean() })
  .partial()
  .strict();

export const parseValheimSettings = (server: Pick<Server, 'gameSettings'>): ValheimSettings => parseGameSettings(ValheimSettingsSchema, server);

// Valheim refuses a password that is part of the server name
function checkPassword(name: string, password: string): void {
  if (name.toLowerCase().includes(password.toLowerCase())) {
    throw new AppError(422, 'PASSWORD_INVALID', 'The password must not be part of the server name (Valheim refuses that).');
  }
  safeText(password, 'password');
}

const READY = /Game server connected/;
const JOIN = /Got character ZDOID from (.+?) : /;

export function classifyValheimLine(line: string): LineEvent | null {
  if (line.length > 1000) return null;
  if (READY.test(line)) return { type: 'done' };
  const joined = JOIN.exec(line)?.[1];
  // "from <name> : 0:0" is also logged when a player dies; the core counts a name once
  if (joined !== undefined) return { type: 'join', name: joined };
  return null;
}

// A world from single player or another server: <name>.fwl (meta) with <name>.db (the world), maybe .old backups
export const valheimWorldImport: WorldImportSupport = {
  native: async (staged, out, ctx) => {
    const metas = await findFiles(staged, (name) => /\.fwl$/i.test(name));
    if (metas.length === 0) throw noWorld('Valheim', 'a world (<name>.fwl with <name>.db), for example from worlds_local');
    const names: string[] = [];
    for (const meta of metas) {
      const base = path.basename(meta).replace(/\.fwl$/i, '');
      const folder = path.dirname(meta);
      for (const file of await readdir(folder)) {
        if (file === `${base}.fwl` || file === `${base}.db` || file.startsWith(`${base}.fwl.`) || file.startsWith(`${base}.db.`) || file.startsWith(`${base}_backup_`)) {
          await moveInto(path.join(folder, file), path.join(out, 'worlds_local', file));
        }
      }
      names.push(base);
    }
    const world = parseValheimSettings(ctx.server).world;
    const warnings = names.includes(world) ? [] : [msg('GAME_IMPORT_WORLD_NAME', { found: names.join(', '), current: world })];
    return { worlds: ['worlds_local'], configItems: [], warnings };
  },
};

export interface ValheimAdapterOptions {
  steam: SteamCmd;
  platform?: NodeJS.Platform;
  playerCount?: (queryPort: number) => Promise<number | null>;
}

export class ValheimAdapter implements GameAdapter {
  readonly definition = gameDefinition('valheim');
  readonly worldImport = valheimWorldImport;
  // the server reads no console input; SIGINT makes it save the world and quit
  readonly stopCommand = null;
  readonly stopSignal = 'SIGINT' as const;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: ValheimAdapterOptions) {
    this.platform = options.platform ?? process.platform;
  }

  executable(dir: string): string {
    return path.join(binaryDir(dir), this.platform === 'win32' ? 'valheim_server.exe' : 'valheim_server.x86_64');
  }

  classifyLine(line: string): LineEvent | null {
    return classifyValheimLine(line);
  }

  async playerList(server: Server): Promise<{ names: string[] | null; count: number | null }> {
    const settings = parseValheimSettings(server);
    const count = this.options.playerCount === undefined ? ((await a2sInfo(settings.queryPort))?.players ?? null) : await this.options.playerCount(settings.queryPort);
    return { names: null, count };
  }

  async createColumns(raw: unknown, others: Server[]): Promise<Partial<Server>> {
    const input = CreateValheimSchema.parse(raw);
    safeText(input.name, 'server name');
    const password = input.password ?? randomBytes(6).toString('base64url');
    checkPassword(input.name, password);
    const port = allocatePorts(input.port, DEFAULT_PORT, [0, 1], takenPorts(others));
    const settings: ValheimSettings = { world: input.world, password, public: input.public, crossplay: input.crossplay, queryPort: port + 1 };
    return { name: input.name, loader: 'vanilla', mcVersion: '', port, maxRamMb: 4096, minRamMb: 1024, eulaAccepted: true, gameSettings: JSON.stringify(settings) };
  }

  async applySettings(server: Server, raw: unknown): Promise<Partial<Server>> {
    const next: ValheimSettings = { ...parseValheimSettings(server), ...EditValheimSchema.parse(raw) };
    checkPassword(server.name, next.password);
    return { gameSettings: JSON.stringify(ValheimSettingsSchema.parse(next)) };
  }

  installTitle(): string {
    return 'Valheim';
  }

  async validateInstall(server: Server): Promise<void> {
    parseValheimSettings(server);
    if (this.platform !== 'linux' && this.platform !== 'win32') throw new AppError(422, 'STEAMCMD_PLATFORM', 'SteamCMD servers are supported on Windows and Linux only.');
  }

  async install(_server: Server, ctx: InstallContext): Promise<Partial<Server>> {
    await steamInstall(ctx, { steam: this.options.steam, appId: VALHEIM_APP_ID, branch: 'public', title: 'Valheim', dir: binaryDir(ctx.dir) });
    await requireProgram(this.executable(ctx.dir), 'install');
    await mkdir(saveDir(ctx.dir), { recursive: true });
    return {};
  }

  async planStart(server: Server, dir: string): Promise<StartPlan> {
    const settings = parseValheimSettings(server);
    const executable = this.executable(dir);
    await requireProgram(executable, 'start');
    await mkdir(saveDir(dir), { recursive: true });
    const linux = path.join(binaryDir(dir), 'linux64');
    return {
      kind: 'launch',
      plan: {
        command: executable,
        args: [
          '-nographics',
          '-batchmode',
          '-name',
          server.name,
          '-port',
          String(server.port),
          '-world',
          settings.world,
          '-password',
          settings.password,
          '-public',
          settings.public ? '1' : '0',
          '-savedir',
          saveDir(dir),
          ...(settings.crossplay ? ['-crossplay'] : []),
        ],
        cwd: binaryDir(dir),
        port: server.port,
        startLine: msg('SERVER_STARTING_GAME', { game: 'Valheim', port: server.port }),
        notes: [],
        beforeSpawn: async () => undefined,
        javaPath: null,
        redact: [settings.password],
        env: { SteamAppId: VALHEIM_GAME_APP_ID, ...(this.platform === 'win32' ? {} : { LD_LIBRARY_PATH: `${linux}${process.env['LD_LIBRARY_PATH'] === undefined ? '' : `:${process.env['LD_LIBRARY_PATH']}`}` }) },
      },
    };
  }

  // worlds_local holds the worlds; the three lists are the configuration. The server saves on its own schedule and
  // on SIGINT only, so backups run while it is stopped.
  async backupLayout(_server: Server, dir: string): Promise<BackupLayout> {
    return {
      root: saveDir(dir),
      levelName: 'worlds_local',
      worlds: () => ['worlds_local'],
      configFiles: ['adminlist.txt', 'bannedlist.txt', 'permittedlist.txt'],
      configDirs: [],
      live: false,
      validateLevel: (level) => {
        if (level !== 'worlds_local') throw new AppError(422, 'BACKUP_INVALID', 'The backup does not belong to a Valheim server.');
        return level;
      },
    };
  }

  configFiles(_server: Server, dir: string): ConfigFile[] {
    const file = (name: string, label: string, description: string): ConfigFile => ({ key: name.replace('.txt', ''), label, description, file: path.join(saveDir(dir), name), display: `data/${name}`, format: 'text' });
    return [
      file('adminlist.txt', 'Admins', 'One Steam id (or platform id) per line. Created on the first start.'),
      file('bannedlist.txt', 'Banned players', 'One Steam id per line.'),
      file('permittedlist.txt', 'Allowed players', 'When it has entries, only these Steam ids may join.'),
    ];
  }
}
