import { z } from 'zod';
import { LOADERS } from '../db/enums.js';
import { AppError } from '../http/errors.js';

export const EXPORT_MANIFEST_NAME = 'worldfoundry-export.json';
export const EXPORT_MANIFEST_FORMAT = 1;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

const hexOrNull = (length: number): z.ZodType<string | null> => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`, 'i')).transform((v) => v.toLowerCase()).nullable();

export const ManifestModSchema = z.object({
  name: z.string().min(1).max(300),
  // file name as in the mods/plugins folder, without the .disabled suffix
  fileName: z.string().min(1).max(260),
  enabled: z.boolean(),
  sha1: hexOrNull(40).default(null),
  sha512: hexOrNull(128).default(null),
  sizeBytes: z.number().int().nonnegative().default(0),
  modId: z.string().max(200).nullable().default(null),
  version: z.string().max(200).nullable().default(null),
  projectId: z.string().max(64).nullable().default(null),
  versionId: z.string().max(64).nullable().default(null),
  source: z.enum(['modrinth', 'manual']).default('manual'),
  side: z.enum(['both', 'server', 'client', 'unknown']).default('unknown'),
  dir: z.enum(['mods', 'plugins']).default('mods'),
  // the jar itself is part of the archive
  included: z.boolean().default(false),
});
export type ManifestMod = z.infer<typeof ManifestModSchema>;

export const ExportManifestSchema = z.object({
  format: z.literal(EXPORT_MANIFEST_FORMAT),
  kind: z.literal('worldfoundry-world-export'),
  appVersion: z.string().max(64),
  createdAt: z.string().max(40),
  source: z.enum(['server', 'backup']).default('server'),
  server: z.object({
    name: z.string().max(200),
    mcVersion: z.string().max(64),
    loader: z.enum(LOADERS),
    loaderVersion: z.string().max(64).nullable(),
  }),
  world: z.object({
    levelName: z.string().min(1).max(100),
    folders: z.array(z.string().min(1).max(120)).max(10),
    // vanilla/Fabric/Forge keep the Nether and the End inside the world folder, Paper next to it
    layout: z.enum(['inside', 'split']),
    dataVersion: z.number().int().nullable().default(null),
  }),
  includes: z.object({
    config: z.boolean(),
    mods: z.enum(['none', 'manifest', 'jars']),
  }),
  mods: z.array(ManifestModSchema).max(5000),
});
export type ExportManifest = z.infer<typeof ExportManifestSchema>;

export function serializeManifest(manifest: ExportManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function parseManifest(data: Buffer): ExportManifest {
  if (data.length > MAX_MANIFEST_BYTES) {
    throw new AppError(422, 'EXPORT_MANIFEST_INVALID', `The file ${EXPORT_MANIFEST_NAME} is too large.`, undefined, { file: EXPORT_MANIFEST_NAME, problem: 'too-large' });
  }
  let json: unknown;
  try {
    json = JSON.parse(data.toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw new AppError(422, 'EXPORT_MANIFEST_INVALID', `The file ${EXPORT_MANIFEST_NAME} is not valid JSON.`, undefined, { file: EXPORT_MANIFEST_NAME, problem: 'not-json' });
  }
  const parsed = ExportManifestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? '' : ` (${first.path.join('.') || 'root'}: ${first.message})`;
    throw new AppError(422, 'EXPORT_MANIFEST_INVALID', `The file ${EXPORT_MANIFEST_NAME} was not recognized${where}. It probably comes from a newer version.`, undefined, { file: EXPORT_MANIFEST_NAME, problem: 'unrecognized', where: first === undefined ? '' : `${first.path.join('.') || 'root'}: ${first.message}` });
  }
  return parsed.data;
}
