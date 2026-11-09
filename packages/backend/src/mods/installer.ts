import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Db, Tx } from '../db/client.js';
import { modDependencies, mods, type Mod } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { downloadToTmp, sanitizeJarName, type DownloaderOptions } from './downloader.js';
import { DISABLED_SUFFIX, removeQuietly } from './files.js';
import { rethrowFsError } from './fs-errors.js';
import type { LoaderProfile } from './profile.js';
import { relinkDependencies } from './scanner.js';
import type { InstallPlan, PlanItem } from './resolver.js';

export interface InstallEnv {
  db: Db;
  profile: LoaderProfile;
  serverDir: string;
  serverId: string;
  downloader: DownloaderOptions;
}

export const tmpDirOf = (env: InstallEnv): string => path.join(env.serverDir, '.tmp');
export const contentDirOf = (env: InstallEnv): string => path.join(env.serverDir, env.profile.contentDir);

export async function downloadItems(env: InstallEnv, items: readonly PlanItem[]): Promise<Map<string, string>> {
  const tmp = new Map<string, string>();
  try {
    for (const item of items) {
      const sha512 = item.file.hashes.sha512;
      if (sha512 === undefined) throw new AppError(502, 'DOWNLOAD_HASH_MISMATCH', 'No checksum is available for the file.');
      const target = await downloadToTmp(
        { url: item.file.url, fileName: item.file.filename, hash: { algorithm: 'sha512', value: sha512 }, size: item.file.size },
        tmpDirOf(env),
        env.downloader,
      );
      tmp.set(item.projectId, target);
    }
    return tmp;
  } catch (error) {
    await removeQuietly(...tmp.values());
    throw error;
  }
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

export async function assertDestinationsFree(env: InstallEnv, items: readonly PlanItem[], ignore: string | null): Promise<void> {
  for (const item of items) {
    const name = sanitizeJarName(item.file.filename);
    if (name === ignore) continue;
    for (const taken of [name, `${name}${DISABLED_SUFFIX}`]) {
      if (await exists(path.join(contentDirOf(env), taken))) {
        throw new AppError(409, 'FILE_EXISTS', `The file "${taken}" already exists in the server folder.`, undefined, { file: taken });
      }
    }
  }
}

// `placed` is filled as we go so the caller can undo a partial move
export async function placeItems(
  env: InstallEnv,
  items: readonly PlanItem[],
  tmp: ReadonlyMap<string, string>,
  placed: string[],
  // projects whose file is placed as <name>.jar.disabled (an update of a switched-off mod)
  disabledProjects: ReadonlySet<string> = new Set(),
): Promise<void> {
  await mkdir(contentDirOf(env), { recursive: true });
  for (const item of items) {
    const source = tmp.get(item.projectId);
    if (source === undefined) throw new Error('Internal error: missing download file.');
    const suffix = disabledProjects.has(item.projectId) ? DISABLED_SUFFIX : '';
    const target = path.join(contentDirOf(env), `${sanitizeJarName(item.file.filename)}${suffix}`);
    try {
      await rename(source, target);
    } catch (error) {
      rethrowFsError(error, path.basename(target));
    }
    placed.push(target);
  }
}

export async function insertDependencyRows(
  tx: Tx,
  modId: string,
  item: PlanItem,
  projectToMod: ReadonlyMap<string, string>,
): Promise<void> {
  if (item.dependencies.length === 0) return;
  await tx.insert(modDependencies).values(
    item.dependencies.map((dep) => ({
      modId,
      dependencyType: dep.type,
      projectId: dep.projectId,
      versionId: dep.versionId,
      fileName: dep.fileName,
      dependsOnModId: dep.linkProjectId === null ? null : (projectToMod.get(dep.linkProjectId) ?? null),
    })),
  );
}

export async function insertPlannedMods(
  tx: Tx,
  serverId: string,
  items: readonly PlanItem[],
  names: ReadonlyMap<string, string>,
  existingProjectToMod: ReadonlyMap<string, string>,
): Promise<Mod[]> {
  const now = new Date();
  const projectToMod = new Map(existingProjectToMod);
  const rows: Mod[] = items.map((item) => {
    const id = randomUUID();
    projectToMod.set(item.projectId, id);
    return {
      id,
      serverId,
      source: 'modrinth',
      projectId: item.projectId,
      versionId: item.version.id,
      versionNumber: item.version.version_number,
      name: names.get(item.projectId) ?? item.version.name,
      fileName: item.file.filename,
      sha512: (item.file.hashes.sha512 ?? '').toLowerCase(),
      sizeBytes: item.file.size,
      isDependency: item.isDependency,
      enabled: true,
      installedAt: now,
      updatedAt: now,
    };
  });
  if (rows.length > 0) await tx.insert(mods).values(rows);
  for (const [index, item] of items.entries()) {
    await insertDependencyRows(tx, (rows[index] as Mod).id, item, projectToMod);
  }
  await relinkDependencies(tx, serverId);
  return rows;
}

export async function projectModMap(tx: Tx, serverId: string): Promise<Map<string, string>> {
  const rows = await tx.select().from(mods).where(eq(mods.serverId, serverId));
  const map = new Map<string, string>();
  for (const row of rows) if (row.projectId !== null) map.set(row.projectId, row.id);
  return map;
}

export interface FileMove {
  from: string;
  to: string;
}

// Renames files one by one; if one fails the ones already moved are put back and the error is rethrown.
export async function moveAll(moves: readonly FileMove[], done: FileMove[] = []): Promise<void> {
  for (const move of moves) {
    try {
      await rename(move.from, move.to);
    } catch (error) {
      await undoMoves(done);
      rethrowFsError(error, path.basename(move.from));
    }
    done.push(move);
  }
}

export async function undoMoves(done: FileMove[]): Promise<void> {
  for (const move of [...done].reverse()) await rename(move.to, move.from).catch(() => undefined);
  done.length = 0;
}

// a switched-off mod comes back by dropping the .disabled suffix; the target name must be free
export async function planEnableMoves(env: InstallEnv, toEnable: readonly Mod[]): Promise<FileMove[]> {
  const moves: FileMove[] = [];
  for (const mod of toEnable) {
    const to = path.join(contentDirOf(env), mod.fileName);
    const from = `${to}${DISABLED_SUFFIX}`;
    if (!(await exists(from))) {
      throw new AppError(409, 'MOD_FILE_MISSING', `The file "${mod.fileName}${DISABLED_SUFFIX}" of "${mod.name}" is missing. Please rescan the mod list.`, { modId: mod.id }, { file: `${mod.fileName}${DISABLED_SUFFIX}`, name: mod.name });
    }
    if (await exists(to)) {
      throw new AppError(409, 'FILE_EXISTS', `The file "${mod.fileName}" already exists in the server folder, so "${mod.name}" cannot be enabled.`, undefined, { file: mod.fileName, name: mod.name });
    }
    moves.push({ from, to });
  }
  return moves;
}

export interface InstalledPlan {
  installed: Mod[];
  reenabled: Mod[];
}

export async function installPlan(env: InstallEnv, plan: InstallPlan): Promise<InstalledPlan> {
  let tmp = new Map<string, string>();
  const placed: string[] = [];
  const moved: FileMove[] = [];
  try {
    await assertDestinationsFree(env, plan.items, null);
    const enableMoves = await planEnableMoves(env, plan.reenable);
    tmp = await downloadItems(env, plan.items);
    await placeItems(env, plan.items, tmp, placed);
    await moveAll(enableMoves, moved);
    const installed = await env.db.transaction(async (tx) => {
      const rows = await insertPlannedMods(tx, env.serverId, plan.items, plan.names, await projectModMap(tx, env.serverId));
      for (const mod of plan.reenable) {
        await tx.update(mods).set({ enabled: true, updatedAt: new Date() }).where(eq(mods.id, mod.id));
      }
      return rows;
    });
    return { installed, reenabled: plan.reenable.map((mod) => ({ ...mod, enabled: true })) };
  } catch (error) {
    await removeQuietly(...placed);
    await undoMoves(moved);
    throw error;
  } finally {
    await removeQuietly(...tmp.values());
  }
}
