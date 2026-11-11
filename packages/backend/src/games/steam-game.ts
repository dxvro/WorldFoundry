import { access, chmod } from 'node:fs/promises';
import type { ZodType } from 'zod';
import type { Server } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import type { SteamCmd } from '../steam/steamcmd.js';
import { steamProgressMessage } from '../steam/steamcmd.js';
import { msg } from '../messages.js';
import type { InstallContext } from './types.js';

// Shared pieces of the games that run a dedicated server installed by SteamCMD or downloaded from the publisher.

export const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

export function parseGameSettings<T>(schema: ZodType<T>, server: Pick<Server, 'gameSettings'>): T {
  try {
    return schema.parse(JSON.parse(server.gameSettings));
  } catch {
    throw new AppError(500, 'GAME_SETTINGS_INVALID', 'The stored settings of this server are damaged.');
  }
}

const inUse = (port: number): AppError => new AppError(409, 'PORT_IN_USE', `Port ${port} is already used by another server.`, { port }, { port });

// A block of ports a server needs together (Valheim: game and game+1). A requested base is checked as it is; without
// one, the first base from `fallback` upwards is taken whose whole block is free.
export function allocatePorts(requested: number | undefined, fallback: number, offsets: readonly number[], taken: ReadonlySet<number>): number {
  const fits = (base: number): boolean => offsets.every((offset) => base + offset <= 65535 && !taken.has(base + offset));
  if (requested !== undefined) {
    const clash = offsets.map((offset) => requested + offset).find((port) => taken.has(port));
    if (clash !== undefined) throw inUse(clash);
    if (requested + Math.max(...offsets) > 65535) throw new AppError(422, 'PORT_INVALID', 'The port is too high.');
    return requested;
  }
  for (let base = fallback; base <= 65535; base++) if (fits(base)) return base;
  throw new AppError(409, 'PORT_IN_USE', 'No free port was found.');
}

// one extra port of its own (RCON, query, REST): the requested one, or the first free from the default upwards
export function allocateSingle(requested: number | undefined, fallback: number, taken: Set<number>): number {
  const port = allocatePorts(requested, fallback, [0], taken);
  taken.add(port);
  return port;
}

export interface SteamInstall {
  steam: SteamCmd;
  appId: number;
  branch: string;
  title: string;
  dir: string;
  platformType?: 'windows' | 'linux';
}

export async function steamInstall(ctx: InstallContext, install: SteamInstall): Promise<void> {
  ctx.progress('download', null, msg('INSTALL_STEP_RESOLVE'));
  ctx.log(`SteamCMD: app ${install.appId}, branch ${install.branch}, anonymous login${install.platformType === undefined ? '' : `, ${install.platformType} files`}`);
  await install.steam.appUpdate({
    appId: install.appId,
    branch: install.branch,
    dir: install.dir,
    validate: true,
    signal: ctx.signal,
    onLine: ctx.log,
    onProgress: (progress) => ctx.progress('download', progress.percent, steamProgressMessage(install.title, progress)),
    ...(install.platformType === undefined ? {} : { platformType: install.platformType }),
  });
}

export async function requireProgram(file: string, after: 'install' | 'start'): Promise<void> {
  if (await exists(file)) {
    await chmod(file, 0o755).catch(() => undefined);
    return;
  }
  throw after === 'install'
    ? new AppError(500, 'SERVER_FILES_MISSING', 'The installation finished, but the server program is missing.')
    : new AppError(409, 'SERVER_FILES_MISSING', 'The server program is missing. Please start the installation again.');
}

export const SERVER_NAME = /^[^"\\\r\n\t]{1,60}$/;

// names that end up in a command line or a config file: no quotes, backslashes or line breaks
export function safeText(value: string, what: string): string {
  if (!SERVER_NAME.test(value)) throw new AppError(422, 'VALUE_INVALID', `The ${what} must not contain quotes, backslashes or line breaks.`, undefined, { what });
  return value;
}
