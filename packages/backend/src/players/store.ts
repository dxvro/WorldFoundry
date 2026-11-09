import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BanEntry, IpBanEntry, OpEntry, PlayerListKey, WhitelistEntry } from '../contract.js';
import { AppError } from '../http/errors.js';
import { renameWithRetry } from '../lib/fs-retry.js';
import { removeQuietly } from '../mods/files.js';
import { rethrowFsError } from '../mods/fs-errors.js';

export const LIST_FILES: Record<PlayerListKey, string> = {
  whitelist: 'whitelist.json',
  ops: 'ops.json',
  bannedPlayers: 'banned-players.json',
  bannedIps: 'banned-ips.json',
};

export interface ListTypes {
  whitelist: WhitelistEntry;
  ops: OpEntry;
  bannedPlayers: BanEntry;
  bannedIps: IpBanEntry;
}

const banFields = {
  created: z.string().default(''),
  source: z.string().default(''),
  expires: z.string().default('forever'),
  reason: z.string().default(''),
};

const SCHEMAS: { [K in PlayerListKey]: z.ZodType<ListTypes[K]> } = {
  whitelist: z.object({ uuid: z.string(), name: z.string() }),
  ops: z.object({
    uuid: z.string(),
    name: z.string(),
    level: z.number().int().min(0).max(4),
    bypassesPlayerLimit: z.boolean().default(false),
  }),
  bannedPlayers: z.object({ uuid: z.string(), name: z.string(), ...banFields }),
  bannedIps: z.object({ ip: z.string(), ...banFields }),
};

export interface ListData<K extends PlayerListKey> {
  entries: ListTypes[K][];
  // the file exists but cannot be understood; it must not be overwritten
  corrupt: boolean;
}

// A missing or empty file is an empty list. Entries that do not fit the format make the whole file count as corrupt,
// because writing the list back would silently drop them.
export async function readList<K extends PlayerListKey>(serverDir: string, key: K): Promise<ListData<K>> {
  const file = LIST_FILES[key];
  let text: string;
  try {
    text = await readFile(path.join(serverDir, file), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], corrupt: false };
    rethrowFsError(error, file);
  }
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed === '') return { entries: [], corrupt: false };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { entries: [], corrupt: true };
  }
  if (!Array.isArray(json)) return { entries: [], corrupt: true };
  const entries: ListTypes[K][] = [];
  let corrupt = false;
  for (const item of json) {
    const parsed = SCHEMAS[key].safeParse(item);
    if (parsed.success) entries.push(parsed.data);
    else corrupt = true;
  }
  return { entries, corrupt };
}

export async function writeList<K extends PlayerListKey>(serverDir: string, key: K, entries: ListTypes[K][]): Promise<void> {
  const file = LIST_FILES[key];
  await mkdir(serverDir, { recursive: true });
  const target = path.join(serverDir, file);
  const temp = path.join(serverDir, `${file}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(entries, null, 2), 'utf8');
    await renameWithRetry(temp, target);
  } catch (error) {
    await removeQuietly(temp);
    rethrowFsError(error, file);
  }
}

export function corruptListError(key: PlayerListKey): AppError {
  return new AppError(
    409,
    'PLAYER_LIST_CORRUPT',
    `The file "${LIST_FILES[key]}" is corrupt and is therefore not overwritten. Please check or delete the file in the server folder.`,
    { file: LIST_FILES[key] },
  );
}
