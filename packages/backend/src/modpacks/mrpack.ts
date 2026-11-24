import { z } from 'zod';
import type { Loader } from '../db/enums.js';
import { AppError } from '../http/errors.js';
import { zipDirectory, readZipFile } from '../archive/zip-read.js';
import { entrySegments } from '../archive/safe-path.js';

// The Modrinth modpack format (.mrpack): a zip with modrinth.index.json, the files to download, and the folders
// overrides/ (client and server) and server-overrides/ (server only) that are copied over the instance.
// https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack

export const INDEX_FILE = 'modrinth.index.json';
export const OVERRIDE_DIRS = ['overrides', 'server-overrides'] as const;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 5000;

// Hosts the format allows for downloads, plus the hosts GitHub redirects its downloads to
export const MRPACK_DOWNLOAD_HOSTS: readonly string[] = [
  'cdn.modrinth.com',
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'gitlab.com',
];

const EnvSide = z.enum(['required', 'optional', 'unsupported']);

const PackFileSchema = z.object({
  path: z.string().min(1).max(1024),
  hashes: z.object({ sha1: z.string().regex(/^[0-9a-f]{40}$/i), sha512: z.string().regex(/^[0-9a-f]{128}$/i) }).loose(),
  env: z.object({ client: EnvSide.optional(), server: EnvSide.optional() }).loose().optional(),
  downloads: z.array(z.string().max(2048)).min(1),
  fileSize: z.number().int().nonnegative(),
});
export type PackFile = z.infer<typeof PackFileSchema>;

export const PackIndexSchema = z
  .object({
    formatVersion: z.literal(1),
    game: z.literal('minecraft'),
    versionId: z.string().max(200),
    name: z.string().max(200),
    summary: z.string().max(5000).optional(),
    files: z.array(PackFileSchema).max(MAX_FILES),
    dependencies: z.record(z.string(), z.string().max(100)),
  })
  .loose();
export type PackIndex = z.infer<typeof PackIndexSchema>;

export interface PackTarget {
  loader: Loader;
  mcVersion: string;
  loaderVersion: string | null;
}

const invalid = (detail: string): AppError =>
  new AppError(422, 'MODPACK_INVALID', `The modpack is not a valid Modrinth modpack (${detail}).`, undefined, { detail });

// The loader and versions a server needs for this pack. Quilt has no server loader in WorldFoundry.
export function packTarget(index: PackIndex): PackTarget {
  const deps = index.dependencies;
  const mcVersion = deps['minecraft'];
  if (mcVersion === undefined || mcVersion.trim() === '') throw invalid('no Minecraft version');
  const loaders: Array<[string, Loader]> = [
    ['fabric-loader', 'fabric'],
    ['neoforge', 'neoforge'],
    ['forge', 'forge'],
  ];
  const found = loaders.filter(([key]) => deps[key] !== undefined);
  if (deps['quilt-loader'] !== undefined && found.length === 0) {
    throw new AppError(422, 'MODPACK_LOADER_UNSUPPORTED', 'The modpack needs the Quilt loader, which WorldFoundry does not support yet.', undefined, { loader: 'Quilt' });
  }
  if (found.length > 1) throw invalid('more than one mod loader');
  const [entry] = found;
  if (entry === undefined) return { loader: 'vanilla', mcVersion, loaderVersion: null };
  return { loader: entry[1], mcVersion, loaderVersion: deps[entry[0]] ?? null };
}

// Files the server needs: everything not marked as unsupported on the server side
export const serverFiles = (index: PackIndex): PackFile[] => index.files.filter((file) => file.env?.server !== 'unsupported');

// Reads and checks modrinth.index.json, including every file path (no absolute paths, no "..").
export async function readPackIndex(archive: string): Promise<PackIndex> {
  let raw: Buffer | null;
  try {
    raw = await readZipFile(archive, await zipDirectory(archive), INDEX_FILE, MAX_INDEX_BYTES);
  } catch (error) {
    if (error instanceof AppError && error.code !== 'ARCHIVE_CORRUPT') throw error;
    throw invalid('not a zip archive');
  }
  if (raw === null) throw invalid(`${INDEX_FILE} is missing`);
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw invalid(`${INDEX_FILE} is not valid JSON`);
  }
  const parsed = PackIndexSchema.safeParse(json);
  if (!parsed.success) throw invalid(`${INDEX_FILE} has an unexpected format`);
  for (const file of parsed.data.files) entrySegments(file.path);
  return parsed.data;
}
