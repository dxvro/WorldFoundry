import { desc, eq } from 'drizzle-orm';
import { access, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { ModUpdateLogEntry, UpdateCandidate, UpdateResult } from '../contract.js';
import type { UpdateStatus } from '../db/enums.js';
import { modDependencies, modUpdateLog, mods, type Mod } from '../db/schema.js';
import { AppError, errorMsg } from '../http/errors.js';
import { msg, parseRef, serializeRef, type MessageRef, type Msg } from '../messages.js';
import type { ModrinthApi, Version } from '../modrinth/types.js';
import { pruneModBackups } from './mod-backups.js';
import { DISABLED_SUFFIX, diskNameOf, removeQuietly } from './files.js';
import { lockedFileError, type ModLogger } from './fs-errors.js';
import { incompatibleRows, requiredLinks } from './graph.js';
import {
  assertDestinationsFree,
  contentDirOf,
  downloadItems,
  insertDependencyRows,
  insertPlannedMods,
  moveAll,
  placeItems,
  planEnableMoves,
  projectModMap,
  undoMoves,
  type FileMove,
  type InstallEnv,
} from './installer.js';
import { planUpdate, type InstalledIncompatibility, type ResolverContext } from './resolver.js';
import { relinkDependencies } from './scanner.js';
import { chooseNewestByDate, isCompatible, pickFile, publishedAt, stabilityRank } from './versions.js';

export const DEFAULT_BACKUP_KEEP = 3;

export interface UpdateEnv extends InstallEnv {
  modrinth: ModrinthApi;
  mcVersion: string;
  // backups per project that stay in <mods|plugins>_backup after an update
  backupKeep?: number;
  logger?: ModLogger;
}

export type { UpdateCandidate, UpdateResult };

interface InternalCandidate {
  info: UpdateCandidate;
  version: Version;
}

export async function loadResolverContext(env: UpdateEnv): Promise<ResolverContext> {
  const installed = await env.db.select().from(mods).where(eq(mods.serverId, env.serverId));
  const byId = new Map(installed.map((mod) => [mod.id, mod]));
  const installedIncompatibilities: InstalledIncompatibility[] = [];
  for (const row of await incompatibleRows(env.db, env.serverId)) {
    const owner = byId.get(row.modId);
    if (owner !== undefined) installedIncompatibilities.push({ modId: owner.id, modName: owner.name, projectId: row.projectId });
  }
  return {
    modrinth: env.modrinth,
    profile: env.profile,
    mcVersion: env.mcVersion,
    installed,
    installedIncompatibilities,
    requiredLinks: await requiredLinks(env.db, env.serverId),
  };
}

async function findCandidates(env: UpdateEnv): Promise<InternalCandidate[]> {
  const rows = (await env.db.select().from(mods).where(eq(mods.serverId, env.serverId))).filter(
    (row): row is Mod & { projectId: string } => row.projectId !== null,
  );
  if (rows.length === 0) return [];
  const hashes = rows.map((row) => row.sha512);
  const current = await env.modrinth.versionFilesByHash(hashes);
  const proposed = await env.modrinth.versionFilesUpdate(hashes, env.profile.loaders, [env.mcVersion]);

  const out: InternalCandidate[] = [];
  for (const row of rows) {
    const cur = current[row.sha512];
    if (cur === undefined) continue;
    const minRank = stabilityRank(cur.version_type);
    let best: Version | null = proposed[row.sha512] ?? null;
    if (best !== null && (stabilityRank(best.version_type) < minRank || !isCompatible(best, env.profile, env.mcVersion))) {
      best = null;
      const versions = await env.modrinth.listProjectVersions(row.projectId, env.profile.loaders, [env.mcVersion]);
      best = chooseNewestByDate(versions, env.profile, env.mcVersion, minRank);
    }
    if (best === null || best.id === cur.id || publishedAt(best) < publishedAt(cur)) continue;
    const file = pickFile(best);
    out.push({
      version: best,
      info: {
        modId: row.id,
        projectId: row.projectId,
        name: row.name,
        currentVersionId: cur.id,
        currentVersionNumber: cur.version_number,
        newVersionId: best.id,
        newVersionNumber: best.version_number,
        versionType: best.version_type,
        newFileName: file?.filename ?? '',
      },
    });
  }
  return out;
}

export async function checkUpdates(env: UpdateEnv): Promise<UpdateCandidate[]> {
  return (await findCandidates(env)).map((candidate) => candidate.info);
}

async function writeLog(
  env: UpdateEnv,
  candidate: UpdateCandidate,
  mod: Mod,
  status: UpdateStatus,
  extra: { backupPath?: string | null; error?: Msg | null; toFileName?: string },
): Promise<void> {
  await env.db.transaction((tx) => tx.insert(modUpdateLog).values(logValues(env, candidate, mod, status, extra)));
}

const errorFields = (message: Msg): { error: string; errorRef: MessageRef } => ({ error: message.text, errorRef: message.ref });

function logValues(
  env: UpdateEnv,
  candidate: UpdateCandidate,
  mod: Mod,
  status: UpdateStatus,
  extra: { backupPath?: string | null; error?: Msg | null; toFileName?: string },
): typeof modUpdateLog.$inferInsert {
  return {
    serverId: env.serverId,
    modId: mod.id,
    modName: mod.name,
    fromVersionId: mod.versionId,
    toVersionId: candidate.newVersionId,
    fromFileName: mod.fileName,
    toFileName: extra.toFileName ?? candidate.newFileName,
    backupPath: extra.backupPath ?? null,
    status,
    error: extra.error?.text ?? null,
    errorRef: serializeRef(extra.error?.ref),
    createdAt: new Date(),
  };
}

function errorText(env: UpdateEnv, mod: Mod, error: unknown): Msg {
  if (error instanceof AppError) return errorMsg(error, msg('MOD_UPDATE_UNEXPECTED'));
  env.logger?.error({ err: error, modId: mod.id, fileName: mod.fileName }, 'Update failed');
  return errorMsg(lockedFileError(error, mod.fileName), msg('MOD_UPDATE_UNEXPECTED'));
}

// the backup keeps the on-disk name, so a switched-off mod stays switched off when it is restored by hand
function backupName(mod: Pick<Mod, 'fileName' | 'enabled'>, taken: boolean): string {
  if (!taken) return diskNameOf(mod);
  const stamp = new Date().toISOString().replace(/\D/g, '');
  return `${mod.fileName.replace(/\.jar$/i, '')}-${stamp}.jar${mod.enabled ? '' : DISABLED_SUFFIX}`;
}

// retention must never turn a successful update into a failure
async function pruneBackups(env: UpdateEnv, justCreated: string): Promise<void> {
  try {
    await pruneModBackups(env, env.backupKeep ?? DEFAULT_BACKUP_KEEP, justCreated);
  } catch (error) {
    env.logger?.error({ err: error, serverId: env.serverId }, 'Old mod backups could not be cleaned up');
  }
}

async function applyOne(env: UpdateEnv, candidate: InternalCandidate): Promise<UpdateResult> {
  const info = candidate.info;
  const mod = (await env.db.select().from(mods).where(eq(mods.id, info.modId)))[0];
  if (mod === undefined) return { modId: info.modId, name: info.name, status: 'failed', ...errorFields(msg('MOD_UPDATE_GONE')) };

  let tmp = new Map<string, string>();
  const placed: string[] = [];
  const enableMoves: FileMove[] = [];
  const movedBack: FileMove[] = [];
  let backupFull: string | null = null;
  let oldMoved = false;
  const oldPath = path.join(contentDirOf(env), diskNameOf(mod));
  const backupDirPath = path.join(env.serverDir, env.profile.backupDir);

  try {
    const plan = await planUpdate(await loadResolverContext(env), mod, candidate.version);
    const root = plan.items.find((item) => item.projectId === mod.projectId);
    if (root === undefined) throw new Error('Internal error: root is missing from the plan.');
    await assertDestinationsFree(env, plan.items, mod.fileName);
    enableMoves.push(...(await planEnableMoves(env, plan.reenable)));
    tmp = await downloadItems(env, plan.items);

    try {
      await mkdir(backupDirPath, { recursive: true });
      const taken = await access(path.join(backupDirPath, diskNameOf(mod))).then(
        () => true,
        () => false,
      );
      backupFull = path.join(backupDirPath, backupName(mod, taken));
      await rename(oldPath, backupFull);
      oldMoved = true;
      // a switched-off mod is updated in place of its .disabled file and stays switched off
      const disabledProjects = !mod.enabled && mod.projectId !== null ? new Set([mod.projectId]) : new Set<string>();
      await placeItems(env, plan.items, tmp, placed, disabledProjects);
      await moveAll(enableMoves, movedBack);
      const backupRelative = path.join(env.profile.backupDir, path.basename(backupFull)).replaceAll('\\', '/');
      await env.db.transaction(async (tx) => {
        const projectToMod = await projectModMap(tx, env.serverId);
        const rootFile = root.file;
        await tx
          .update(mods)
          .set({
            versionId: root.version.id,
            versionNumber: root.version.version_number,
            fileName: rootFile.filename,
            sha512: (rootFile.hashes.sha512 ?? '').toLowerCase(),
            sizeBytes: rootFile.size,
            updatedAt: new Date(),
          })
          .where(eq(mods.id, mod.id));
        await tx.delete(modDependencies).where(eq(modDependencies.modId, mod.id));
        const extras = plan.items.filter((item) => item !== root);
        for (const row of await insertPlannedMods(tx, env.serverId, extras, plan.names, projectToMod)) {
          if (row.projectId !== null) projectToMod.set(row.projectId, row.id);
        }
        await insertDependencyRows(tx, mod.id, root, projectToMod);
        for (const other of plan.reenable) {
          await tx.update(mods).set({ enabled: true, updatedAt: new Date() }).where(eq(mods.id, other.id));
        }
        await relinkDependencies(tx, env.serverId);
        await tx.insert(modUpdateLog).values(logValues(env, info, mod, 'success', { backupPath: backupRelative, toFileName: rootFile.filename }));
      });
      await pruneBackups(env, backupFull);
      return { modId: mod.id, name: mod.name, status: 'success' };
    } catch (error) {
      await removeQuietly(...placed);
      await undoMoves(movedBack);
      let kept: string | null = null;
      if (oldMoved && backupFull !== null) {
        try {
          await rename(backupFull, oldPath);
        } catch {
          kept = path.basename(backupFull);
        }
      }
      const reason = errorText(env, mod, error);
      const message = kept === null ? reason : msg('MOD_UPDATE_BACKUP_KEPT', { reason, backup: kept });
      const status: UpdateStatus = oldMoved ? 'rolled_back' : 'failed';
      await writeLog(env, info, mod, status, { error: message, backupPath: null });
      return { modId: mod.id, name: mod.name, status, ...errorFields(message) };
    }
  } catch (error) {
    const message = errorText(env, mod, error);
    await writeLog(env, info, mod, 'failed', { error: message });
    return { modId: mod.id, name: mod.name, status: 'failed', ...errorFields(message) };
  } finally {
    await removeQuietly(...tmp.values());
  }
}

export async function applyUpdates(env: UpdateEnv, projectIds?: readonly string[]): Promise<UpdateResult[]> {
  const candidates = (await findCandidates(env)).filter(
    (candidate) => projectIds === undefined || projectIds.includes(candidate.info.projectId),
  );
  const results: UpdateResult[] = [];
  for (const candidate of candidates) results.push(await applyOne(env, candidate));
  return results;
}

export async function listUpdateLog(env: Pick<UpdateEnv, 'db' | 'serverId'>, limit: number): Promise<ModUpdateLogEntry[]> {
  const rows = await env.db
    .select()
    .from(modUpdateLog)
    .where(eq(modUpdateLog.serverId, env.serverId))
    .orderBy(desc(modUpdateLog.createdAt), desc(modUpdateLog.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, errorRef: parseRef(row.errorRef) }));
}
