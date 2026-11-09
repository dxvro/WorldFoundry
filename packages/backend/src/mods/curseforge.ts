import { eq } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CURSEFORGE_DOWNLOAD_HOSTS, HASH_ALGO, MOD_LOADER_TYPE, RELATION, type CfFile, type CfMod, type CurseForgeApi } from '../curseforge/client.js';
import type { Loader } from '../db/enums.js';
import { modDependencies, mods, type Mod } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { downloadToTmp, sanitizeJarName } from './downloader.js';
import { DISABLED_SUFFIX, removeQuietly } from './files.js';
import { rethrowFsError } from './fs-errors.js';
import { contentDirOf, tmpDirOf, type InstallEnv } from './installer.js';
import { relinkDependencies } from './scanner.js';

// Installed CurseForge projects are recorded with this prefix, so their numeric ids never collide with Modrinth ids.
export const cfProjectId = (modId: number): string => `cf:${modId}`;
const MAX_ITEMS = 50;

export const modLoaderTypeOf = (loader: Loader): number | null =>
  loader === 'fabric' ? MOD_LOADER_TYPE.fabric : loader === 'forge' ? MOD_LOADER_TYPE.forge : loader === 'neoforge' ? MOD_LOADER_TYPE.neoforge : null;

// The newest file for the version: releases before betas before alphas, then the newest date.
export function pickFile(files: readonly CfFile[], mcVersion: string): CfFile | null {
  const fitting = files.filter((file) => file.gameVersions.includes(mcVersion));
  const sorted = [...fitting].sort((a, b) => a.releaseType - b.releaseType || Date.parse(b.fileDate) - Date.parse(a.fileDate));
  return sorted[0] ?? null;
}

export interface CfEnv extends InstallEnv {
  loader: Loader;
  mcVersion: string;
  api: CurseForgeApi;
  apiKey: string;
}

interface Item {
  mod: CfMod;
  file: CfFile;
  isDependency: boolean;
}

const blocked = (mod: CfMod): AppError =>
  new AppError(
    409,
    'CURSEFORGE_DOWNLOAD_BLOCKED',
    `The author of "${mod.name}" allows downloads only on the CurseForge website. Please download it there and put it into the server folder by hand.`,
    undefined,
    { name: mod.name, url: mod.links.websiteUrl ?? `https://www.curseforge.com/minecraft/search?search=${encodeURIComponent(mod.slug)}` },
  );

async function fileFor(env: CfEnv, mod: CfMod, fileId: number | undefined): Promise<CfFile> {
  if (fileId !== undefined) return env.api.file(env.apiKey, mod.id, fileId);
  const file = pickFile(await env.api.files(env.apiKey, mod.id, env.mcVersion, modLoaderTypeOf(env.loader)), env.mcVersion);
  if (file === null) {
    throw new AppError(422, 'NO_COMPATIBLE_VERSION', `"${mod.name}" has no file for Minecraft ${env.mcVersion} and this loader.`, undefined, { name: mod.name });
  }
  return file;
}

// The project and every required dependency that is not installed yet, root first.
async function plan(env: CfEnv, modId: number, fileId: number | undefined, installed: ReadonlySet<string>): Promise<Item[]> {
  const items: Item[] = [];
  const seen = new Set<number>();
  const queue: Array<{ modId: number; fileId: number | undefined; isDependency: boolean }> = [{ modId, fileId, isDependency: false }];
  while (queue.length > 0) {
    const next = queue.shift() as (typeof queue)[number];
    if (seen.has(next.modId)) continue;
    seen.add(next.modId);
    if (next.isDependency && installed.has(cfProjectId(next.modId))) continue;
    if (items.length >= MAX_ITEMS) throw new AppError(422, 'CURSEFORGE_TOO_MANY', 'The project needs too many dependencies to install them at once.');
    const mod = await env.api.mod(env.apiKey, next.modId);
    const file = await fileFor(env, mod, next.fileId);
    if (file.downloadUrl === null || mod.allowModDistribution === false) throw blocked(mod);
    items.push({ mod, file, isDependency: next.isDependency });
    for (const dep of file.dependencies) {
      if (dep.relationType === RELATION.required) queue.push({ modId: dep.modId, fileId: undefined, isDependency: true });
    }
  }
  return items;
}

async function sha512Of(file: string): Promise<string> {
  const hash = createHash('sha512');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

export interface CfInstallResult {
  installed: Mod[];
}

export async function installFromCurseForge(env: CfEnv, modId: number, fileId?: number): Promise<CfInstallResult> {
  const rows = await env.db.select().from(mods).where(eq(mods.serverId, env.serverId));
  const installedProjects = new Set(rows.map((row) => row.projectId).filter((id): id is string => id !== null));
  if (installedProjects.has(cfProjectId(modId))) {
    throw new AppError(409, 'MOD_ALREADY_INSTALLED', 'This project is already installed.');
  }
  const items = await plan(env, modId, fileId, installedProjects);

  const downloaded: Array<{ item: Item; tmp: string; sha512: string; name: string }> = [];
  const placed: string[] = [];
  try {
    for (const item of items) {
      const name = sanitizeJarName(item.file.fileName);
      for (const taken of [name, `${name}${DISABLED_SUFFIX}`]) {
        if (rows.some((row) => row.fileName === taken)) {
          throw new AppError(409, 'FILE_EXISTS', `The file "${taken}" already exists in the server folder.`, undefined, { file: taken });
        }
      }
      const sha1 = item.file.hashes.find((hash) => hash.algo === HASH_ALGO.sha1)?.value;
      if (sha1 === undefined) throw new AppError(502, 'DOWNLOAD_HASH_MISMATCH', 'No checksum is available for the file.');
      const tmp = await downloadToTmp(
        {
          url: item.file.downloadUrl as string,
          fileName: name,
          hash: { algorithm: 'sha1', value: sha1 },
          size: item.file.fileLength,
          allowedHosts: CURSEFORGE_DOWNLOAD_HOSTS,
        },
        tmpDirOf(env),
        env.downloader,
      );
      const sha512 = await sha512Of(tmp);
      downloaded.push({ item, tmp, sha512, name });
      if (rows.some((row) => row.sha512 === sha512)) {
        throw new AppError(409, 'MOD_ALREADY_INSTALLED', `The file of "${item.mod.name}" is already installed.`);
      }
    }
    await mkdir(contentDirOf(env), { recursive: true });
    for (const entry of downloaded) {
      const target = path.join(contentDirOf(env), entry.name);
      try {
        await rename(entry.tmp, target);
      } catch (error) {
        rethrowFsError(error, entry.name);
      }
      placed.push(target);
    }
    const installed = await env.db.transaction(async (tx) => {
      const now = new Date();
      const newRows: Mod[] = downloaded.map(({ item, sha512, name }) => ({
        id: randomUUID(),
        serverId: env.serverId,
        source: 'curseforge',
        projectId: cfProjectId(item.mod.id),
        versionId: String(item.file.id),
        versionNumber: item.file.displayName,
        name: item.mod.name,
        fileName: name,
        sha512,
        sizeBytes: item.file.fileLength,
        isDependency: item.isDependency,
        enabled: true,
        installedAt: now,
        updatedAt: now,
      }));
      await tx.insert(mods).values(newRows);
      for (const [index, { item }] of downloaded.entries()) {
        const required = item.file.dependencies.filter((dep) => dep.relationType === RELATION.required);
        if (required.length === 0) continue;
        await tx.insert(modDependencies).values(
          required.map((dep) => ({ modId: (newRows[index] as Mod).id, dependencyType: 'required' as const, projectId: cfProjectId(dep.modId), versionId: null, fileName: null })),
        );
      }
      await relinkDependencies(tx, env.serverId);
      return newRows;
    });
    return { installed };
  } catch (error) {
    await removeQuietly(...placed);
    throw error;
  } finally {
    await removeQuietly(...downloaded.map((entry) => entry.tmp));
  }
}
