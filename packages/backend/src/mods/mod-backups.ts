import { desc, eq, inArray } from 'drizzle-orm';
import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ModBackupEntry, ModBackupList } from '../contract.js';
import type { Db } from '../db/client.js';
import { modUpdateLog } from '../db/schema.js';
import { rethrowFsError } from './fs-errors.js';
import type { LoaderProfile } from './profile.js';

export type { ModBackupEntry, ModBackupList };

export interface ModBackupEnv {
  db: Db;
  profile: LoaderProfile;
  serverDir: string;
  serverId: string;
}

interface Analysis {
  entries: ModBackupEntry[];
  removable: ModBackupEntry[];
}

const backupDirOf = (env: ModBackupEnv): string => path.join(env.serverDir, env.profile.backupDir);

async function listFiles(dir: string): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    const info = await lstat(path.join(dir, name)).catch(() => null);
    if (info?.isFile() === true) files.push({ name, size: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

// Backups are grouped per mod using the update log (which file belongs to which update); the newest `keep`
// per mod stay. Files the log does not know are shown but never removed.
async function analyze(env: ModBackupEnv, keep: number, protectedFile: string | null): Promise<Analysis> {
  const files = await listFiles(backupDirOf(env));
  const log = await env.db
    .select()
    .from(modUpdateLog)
    .where(eq(modUpdateLog.serverId, env.serverId))
    .orderBy(desc(modUpdateLog.createdAt), desc(modUpdateLog.id));
  const owner = new Map<string, (typeof log)[number]>();
  for (const entry of log) {
    if (entry.backupPath === null || entry.status !== 'success') continue;
    const name = path.posix.basename(entry.backupPath.replaceAll('\\', '/'));
    if (!owner.has(name)) owner.set(name, entry);
  }
  const protectedName = protectedFile === null ? null : path.basename(protectedFile);
  const groups = new Map<string, ModBackupEntry[]>();
  const entries: ModBackupEntry[] = [];
  for (const file of files) {
    const entry = owner.get(file.name);
    const item: ModBackupEntry = {
      fileName: file.name,
      sizeBytes: file.size,
      createdAt: entry?.createdAt.getTime() ?? file.mtimeMs,
      modName: entry?.modName ?? null,
      logId: entry?.id ?? null,
      removable: false,
    };
    entries.push(item);
    if (entry === undefined) continue;
    const key = entry.modId ?? `name:${entry.modName}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const removable: ModBackupEntry[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.createdAt - a.createdAt);
    for (const item of group.slice(keep)) {
      if (item.fileName === protectedName) continue;
      item.removable = true;
      removable.push(item);
    }
  }
  entries.sort((a, b) => b.createdAt - a.createdAt);
  return { entries, removable };
}

export async function listModBackups(env: ModBackupEnv, keep: number): Promise<ModBackupList> {
  const { entries } = await analyze(env, keep, null);
  return { backups: entries, totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0), keep };
}

export interface PruneResult {
  removed: number;
  freedBytes: number;
}

// `protectedFile` (the backup just created) is never deleted, whatever the numbers say
export async function pruneModBackups(env: ModBackupEnv, keep: number, protectedFile: string | null): Promise<PruneResult> {
  const { removable } = await analyze(env, Math.max(1, keep), protectedFile);
  let freedBytes = 0;
  const gone: ModBackupEntry[] = [];
  for (const entry of removable) {
    try {
      await rm(path.join(backupDirOf(env), entry.fileName), { force: true });
    } catch (error) {
      rethrowFsError(error, entry.fileName);
    }
    freedBytes += entry.sizeBytes;
    gone.push(entry);
  }
  const logIds = gone.map((entry) => entry.logId).filter((id): id is number => id !== null);
  if (logIds.length > 0) {
    await env.db.transaction((tx) => tx.update(modUpdateLog).set({ backupPath: null }).where(inArray(modUpdateLog.id, logIds)));
  }
  return { removed: gone.length, freedBytes };
}
