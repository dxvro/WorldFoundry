import { eq, inArray } from 'drizzle-orm';
import { msg, MsgList } from '../messages.js';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { ToggleResult } from '../contract.js';
import type { Db } from '../db/client.js';
import { mods, type Mod } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { DISABLED_SUFFIX } from './files.js';
import { incompatibleRows, requiredBy, requiredLinks } from './graph.js';
import { contentDirOf, moveAll, planEnableMoves, undoMoves, type FileMove, type InstallEnv } from './installer.js';

export type { ToggleResult };

export interface ToggleEnv extends InstallEnv {
  db: Db;
}

async function requireMod(env: ToggleEnv, modId: string): Promise<Mod> {
  const mod = (await env.db.select().from(mods).where(eq(mods.id, modId)))[0];
  if (mod === undefined || mod.serverId !== env.serverId) throw new AppError(404, 'MOD_NOT_FOUND', 'The mod was not found.');
  return mod;
}

// the mod and, recursively, every switched-off mod it requires
async function enableClosure(env: ToggleEnv, mod: Mod): Promise<Mod[]> {
  const all = await env.db.select().from(mods).where(eq(mods.serverId, env.serverId));
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const links = await requiredLinks(env.db, env.serverId);
  const closure: Mod[] = [];
  const seen = new Set<string>();
  const visit = (current: Mod): void => {
    if (seen.has(current.id)) return;
    seen.add(current.id);
    if (!current.enabled) closure.push(current);
    for (const id of links.get(current.id) ?? []) {
      const dependency = byId.get(id);
      if (dependency !== undefined) visit(dependency);
    }
  };
  visit(mod);
  return closure;
}

// Enabling must not bring two mods together that declare each other incompatible
async function assertNoConflict(env: ToggleEnv, toEnable: readonly Mod[]): Promise<void> {
  const all = await env.db.select().from(mods).where(eq(mods.serverId, env.serverId));
  const switchedOn = new Set(toEnable.map((mod) => mod.id));
  const active = all.filter((mod) => mod.enabled || switchedOn.has(mod.id));
  const byProject = new Map<string, Mod>();
  for (const mod of active) if (mod.projectId !== null) byProject.set(mod.projectId, mod);
  const activeIds = new Set(active.map((mod) => mod.id));
  const byId = new Map(all.map((mod) => [mod.id, mod]));
  for (const row of await incompatibleRows(env.db, env.serverId)) {
    const owner = byId.get(row.modId);
    const target = byProject.get(row.projectId);
    if (owner === undefined || target === undefined || owner.id === target.id || !activeIds.has(owner.id)) continue;
    if (!switchedOn.has(owner.id) && !switchedOn.has(target.id)) continue;
    throw new AppError(409, 'MOD_INCOMPATIBLE', `"${owner.name}" is not compatible with "${target.name}".`, { mods: [owner.name, target.name] }, { first: owner.name, second: target.name });
  }
}

async function setFlag(db: Db, ids: readonly string[], enabled: boolean): Promise<void> {
  await db.transaction((tx) => tx.update(mods).set({ enabled, updatedAt: new Date() }).where(inArray(mods.id, [...ids])));
}

export async function setModEnabled(env: ToggleEnv, modId: string, enabled: boolean, force: boolean): Promise<ToggleResult> {
  const mod = await requireMod(env, modId);
  if (mod.enabled === enabled) return { mod, changed: [], dependencies: [], warnings: [], warningRefs: [] };
  const dir = contentDirOf(env);
  const warnings = new MsgList();
  let affected: Mod[];
  let moves: FileMove[];

  if (enabled) {
    affected = await enableClosure(env, mod);
    await assertNoConflict(env, affected);
    moves = await planEnableMoves(env, affected);
    for (const dependency of affected.filter((entry) => entry.id !== mod.id)) {
      warnings.push(msg('MOD_DEPENDENCY_ENABLED', { name: dependency.name }));
    }
  } else {
    const dependents = await requiredBy(env.db, mod.id, true);
    if (dependents.length > 0 && !force) {
      throw new AppError(
        409,
        'MOD_REQUIRED_BY_OTHERS',
        `"${mod.name}" is required by other mods: ${dependents.map((entry) => entry.name).join(', ')}.`,
        { dependents: dependents.map((entry) => ({ id: entry.id, name: entry.name })) },
        { name: mod.name, dependents: dependents.map((entry) => entry.name).join(', ') },
      );
    }
    if (dependents.length > 0) {
      warnings.push(msg('MOD_DISABLED_ANYWAY', { name: mod.name, dependents: dependents.map((entry) => `"${entry.name}"`).join(', ') }));
    }
    affected = [mod];
    const from = path.join(dir, mod.fileName);
    const to = `${from}${DISABLED_SUFFIX}`;
    moves = [{ from, to }];
    await assertDisableMove(from, to, mod);
  }

  const moved: FileMove[] = [];
  await moveAll(moves, moved);
  try {
    await setFlag(env.db, affected.map((entry) => entry.id), enabled);
  } catch (error) {
    await undoMoves(moved);
    throw error;
  }
  const changed = affected.map((entry) => ({ ...entry, enabled }));
  return {
    mod: { ...mod, enabled },
    changed,
    dependencies: changed.filter((entry) => entry.id !== mod.id),
    warnings: warnings.texts,
    warningRefs: warnings.refs,
  };
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

async function assertDisableMove(from: string, to: string, mod: Mod): Promise<void> {
  if (!(await exists(from))) {
    throw new AppError(409, 'MOD_FILE_MISSING', `The file "${mod.fileName}" of "${mod.name}" is missing. Please rescan the mod list.`, { modId: mod.id }, { file: mod.fileName, name: mod.name });
  }
  if (await exists(to)) {
    throw new AppError(409, 'FILE_EXISTS', `The file "${mod.fileName}${DISABLED_SUFFIX}" already exists in the server folder, so "${mod.name}" cannot be disabled.`, undefined, { file: `${mod.fileName}${DISABLED_SUFFIX}`, name: mod.name });
  }
}
