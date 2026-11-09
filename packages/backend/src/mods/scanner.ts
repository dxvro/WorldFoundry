import { and, eq, isNull, sql } from 'drizzle-orm';
import { msg, MsgList } from '../messages.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ScanReport } from '../contract.js';
import type { Db, Tx } from '../db/client.js';
import { modDependencies, mods, type Mod } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import type { ModrinthApi } from '../modrinth/types.js';
import { dependencyRowsFor } from './dependency-rows.js';
import { baseName, hashFile, listModFiles, mapLimit, type HashedFile } from './files.js';
import type { LoaderProfile } from './profile.js';

const HASH_CONCURRENCY = 4;

export interface ScanContext {
  db: Db;
  modrinth: ModrinthApi;
  profile: LoaderProfile;
  serverDir: string;
  serverId: string;
}

export type { ScanReport };

export async function relinkDependencies(tx: Tx, serverId: string): Promise<void> {
  await tx.run(sql`
    UPDATE mod_dependencies
    SET depends_on_mod_id = (
      SELECT m2.id FROM mods m2
      WHERE m2.server_id = ${serverId} AND m2.project_id = mod_dependencies.project_id
    )
    WHERE depends_on_mod_id IS NULL
      AND project_id IS NOT NULL
      AND mod_id IN (SELECT id FROM mods WHERE server_id = ${serverId})
      AND EXISTS (
        SELECT 1 FROM mods m3
        WHERE m3.server_id = ${serverId} AND m3.project_id = mod_dependencies.project_id
      )
  `);
}

async function hashDirectory(
  dir: string,
  warnings: MsgList,
): Promise<{ files: HashedFile[]; unreadable: Set<string> }> {
  const names = await listModFiles(dir);
  const unreadable = new Set<string>();
  const results = await mapLimit(names, HASH_CONCURRENCY, async (entry) => {
    try {
      return { ...entry, ...(await hashFile(path.join(dir, entry.diskName))) };
    } catch {
      unreadable.add(entry.fileName);
      warnings.push(msg('MOD_SCAN_UNREADABLE', { file: entry.diskName }));
      return null;
    }
  });
  return { files: results.filter((file): file is HashedFile => file !== null), unreadable };
}

// Two steps through a temporary unique name, so swaps and chains do not trip over unique(server_id, file_name).
export async function applyRenames(
  tx: Tx,
  renames: ReadonlyArray<{ row: Mod; file: { fileName: string; enabled?: boolean } }>,
  warnings: MsgList,
): Promise<number> {
  for (const entry of renames) {
    await tx.update(mods).set({ fileName: `${entry.row.id}.rename-tmp` }).where(eq(mods.id, entry.row.id));
  }
  let done = 0;
  for (const { row, file } of renames) {
    try {
      await tx
        .update(mods)
        .set({ fileName: file.fileName, ...(file.enabled === undefined ? {} : { enabled: file.enabled }), updatedAt: new Date() })
        .where(eq(mods.id, row.id));
      done++;
    } catch {
      warnings.push(msg('MOD_SCAN_RENAME_CONFLICT', { file: file.fileName }));
      try {
        await tx.update(mods).set({ fileName: row.fileName }).where(eq(mods.id, row.id));
      } catch {
        await tx.delete(mods).where(eq(mods.id, row.id));
        warnings.push(msg('MOD_SCAN_ENTRY_REMOVED', { file: row.fileName }));
      }
    }
  }
  return done;
}

export async function scanServer(ctx: ScanContext): Promise<ScanReport> {
  const { db, serverId } = ctx;
  const warnings = new MsgList();
  const report: ScanReport = {
    scanned: 0,
    added: 0,
    renamed: 0,
    toggled: 0,
    replaced: 0,
    removed: 0,
    identified: 0,
    modrinthAvailable: true,
    warnings: [],
    warningRefs: [],
  };
  const { files, unreadable } = await hashDirectory(path.join(ctx.serverDir, ctx.profile.contentDir), warnings);
  report.scanned = files.length;

  await db.transaction(async (tx) => {
    const rows = await tx.select().from(mods).where(eq(mods.serverId, serverId));
    const rowsByHash = new Map(rows.map((row) => [row.sha512, row]));
    const rowsByName = new Map(rows.map((row) => [row.fileName, row]));

    // "a.jar" next to "a.jar.disabled" would be the same mod twice: the active file wins
    const candidates: HashedFile[] = [];
    const sameName = new Map<string, HashedFile[]>();
    for (const file of files) sameName.set(file.fileName, [...(sameName.get(file.fileName) ?? []), file]);
    for (const group of sameName.values()) {
      const winner = group.find((file) => file.enabled) ?? group[0];
      if (winner === undefined) continue;
      candidates.push(winner);
      for (const ignored of group) {
        if (ignored === winner) continue;
        const same = ignored.sha512 === winner.sha512 ? 'identical' : 'different';
        warnings.push(msg('MOD_SCAN_TWIN_FILES', { kept: winner.diskName, ignored: ignored.diskName, content: same }));
      }
    }

    // identical content under several names: keep the file the DB already knows, else the first by name
    const byHash = new Map<string, HashedFile>();
    for (const file of candidates) {
      const known = byHash.get(file.sha512);
      if (known === undefined) {
        byHash.set(file.sha512, file);
        continue;
      }
      const preferred = rowsByHash.get(file.sha512)?.fileName === file.fileName ? file : known;
      const ignored = preferred === file ? known : file;
      byHash.set(file.sha512, preferred);
      warnings.push(msg('MOD_SCAN_IDENTICAL', { ignored: ignored.diskName, preferred: preferred.diskName }));
    }

    const matched = new Set<string>();
    const renames: Array<{ row: Mod; file: HashedFile }> = [];
    const toggles: Array<{ row: Mod; file: HashedFile }> = [];
    const unknown: HashedFile[] = [];
    for (const file of byHash.values()) {
      const row = rowsByHash.get(file.sha512);
      if (row === undefined) unknown.push(file);
      else {
        matched.add(row.id);
        if (row.fileName !== file.fileName) renames.push({ row, file });
        else if (row.enabled !== file.enabled) toggles.push({ row, file });
      }
    }

    const claimed = new Set<string>();
    const replacements: Array<{ row: Mod; file: HashedFile }> = [];
    const additions: HashedFile[] = [];
    for (const file of unknown) {
      const row = rowsByName.get(file.fileName);
      if (row !== undefined && !matched.has(row.id) && !claimed.has(row.id)) {
        claimed.add(row.id);
        replacements.push({ row, file });
      } else additions.push(file);
    }

    const removals = rows.filter(
      (row) => !matched.has(row.id) && !claimed.has(row.id) && !unreadable.has(row.fileName),
    );

    const attempt = async (description: { kind: 'changed' | 'new'; file: string }, action: () => Promise<void>): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch {
        warnings.push(msg('MOD_SCAN_CONFLICT', description));
        return false;
      }
    };

    for (const row of removals) {
      await tx.delete(mods).where(eq(mods.id, row.id));
      report.removed++;
    }
    report.renamed += await applyRenames(tx, renames, warnings);
    report.toggled += renames.filter(({ row, file }) => row.enabled !== file.enabled).length;
    for (const { row, file } of toggles) {
      await tx.update(mods).set({ enabled: file.enabled, updatedAt: new Date() }).where(eq(mods.id, row.id));
      report.toggled++;
    }
    for (const { row, file } of replacements) {
      const ok = await attempt({ kind: 'changed', file: file.fileName }, async () => {
        await tx
          .update(mods)
          .set({
            sha512: file.sha512,
            sizeBytes: file.size,
            source: 'manual',
            projectId: null,
            versionId: null,
            versionNumber: null,
            name: baseName(file.fileName),
            isDependency: false,
            enabled: file.enabled,
            updatedAt: new Date(),
          })
          .where(eq(mods.id, row.id));
        await tx.delete(modDependencies).where(eq(modDependencies.modId, row.id));
        await tx.update(modDependencies).set({ dependsOnModId: null }).where(eq(modDependencies.dependsOnModId, row.id));
      });
      if (ok) report.replaced++;
    }
    for (const file of additions) {
      const now = new Date();
      const ok = await attempt({ kind: 'new', file: file.fileName }, async () => {
        await tx.insert(mods).values({
          id: randomUUID(),
          serverId,
          source: 'manual',
          name: baseName(file.fileName),
          fileName: file.fileName,
          sha512: file.sha512,
          sizeBytes: file.size,
          enabled: file.enabled,
          installedAt: now,
          updatedAt: now,
        });
      });
      if (ok) report.added++;
    }
  });

  await identifyUnknownMods(ctx, report, warnings);
  report.warnings = warnings.texts;
  report.warningRefs = warnings.refs;
  return report;
}

async function identifyUnknownMods(ctx: ScanContext, report: ScanReport, warnings: MsgList): Promise<void> {
  const { db, serverId } = ctx;
  const pending = await db.select().from(mods).where(and(eq(mods.serverId, serverId), isNull(mods.projectId)));
  if (pending.length === 0) return;

  let found: Awaited<ReturnType<ModrinthApi['versionFilesByHash']>>;
  let titles: Map<string, string>;
  try {
    found = await ctx.modrinth.versionFilesByHash(pending.map((row) => row.sha512));
    const projects = await ctx.modrinth.getProjects([...new Set(Object.values(found).map((v) => v.project_id))]);
    titles = new Map(projects.map((project) => [project.id, project.title]));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    report.modrinthAvailable = false;
    warnings.push(msg('MOD_SCAN_MODRINTH_DOWN'));
    return;
  }

  await db.transaction(async (tx) => {
    const used = new Set(
      (await tx.select({ projectId: mods.projectId }).from(mods).where(eq(mods.serverId, serverId)))
        .map((row) => row.projectId)
        .filter((id): id is string => id !== null),
    );
    for (const row of pending) {
      const version = found[row.sha512];
      if (version === undefined) continue;
      if (used.has(version.project_id)) {
        warnings.push(msg('MOD_SCAN_PROJECT_INSTALLED', { file: row.fileName, project: titles.get(version.project_id) ?? version.project_id }));
        continue;
      }
      used.add(version.project_id);
      await tx
        .update(mods)
        .set({
          projectId: version.project_id,
          versionId: version.id,
          versionNumber: version.version_number,
          name: titles.get(version.project_id) ?? row.name,
          updatedAt: new Date(),
        })
        .where(eq(mods.id, row.id));
      await tx.delete(modDependencies).where(eq(modDependencies.modId, row.id));
      const dependencyRows = dependencyRowsFor(row.id, version.dependencies);
      if (dependencyRows.length > 0) await tx.insert(modDependencies).values(dependencyRows);
      report.identified++;
    }
    await relinkDependencies(tx, serverId);
  });
}
