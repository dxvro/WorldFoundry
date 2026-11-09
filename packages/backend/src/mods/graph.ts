import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { modDependencies, mods, type Mod } from '../db/schema.js';

// mods that list `modId` as a required dependency, optionally only those that are switched on
export async function requiredBy(db: Db, modId: string, onlyEnabled = false): Promise<Mod[]> {
  const rows = await db
    .select({ modId: modDependencies.modId })
    .from(modDependencies)
    .where(and(eq(modDependencies.dependsOnModId, modId), eq(modDependencies.dependencyType, 'required')));
  const ids = [...new Set(rows.map((row) => row.modId))].filter((id) => id !== modId);
  if (ids.length === 0) return [];
  const found = await db.select().from(mods).where(inArray(mods.id, ids));
  return onlyEnabled ? found.filter((mod) => mod.enabled) : found;
}

// modId -> ids of installed mods it requires
export async function requiredLinks(db: Db, serverId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ modId: modDependencies.modId, target: modDependencies.dependsOnModId })
    .from(modDependencies)
    .innerJoin(mods, eq(mods.id, modDependencies.modId))
    .where(and(eq(mods.serverId, serverId), eq(modDependencies.dependencyType, 'required')));
  const links = new Map<string, string[]>();
  for (const row of rows) {
    if (row.target === null) continue;
    links.set(row.modId, [...(links.get(row.modId) ?? []), row.target]);
  }
  return links;
}

export interface IncompatibleRow {
  modId: string;
  projectId: string;
}

export async function incompatibleRows(db: Db, serverId: string): Promise<IncompatibleRow[]> {
  const rows = await db
    .select({ modId: modDependencies.modId, projectId: modDependencies.projectId })
    .from(modDependencies)
    .innerJoin(mods, eq(mods.id, modDependencies.modId))
    .where(and(eq(mods.serverId, serverId), eq(modDependencies.dependencyType, 'incompatible')));
  return rows.flatMap((row) => (row.projectId === null ? [] : [{ modId: row.modId, projectId: row.projectId }]));
}
