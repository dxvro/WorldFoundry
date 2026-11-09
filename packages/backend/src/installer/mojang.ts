import { z } from 'zod';
import { AppError } from '../http/errors.js';
import type { McVersion } from './types.js';
import type { Upstream } from './upstream.js';

export const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const MOJANG_DOWNLOAD_HOSTS: readonly string[] = ['piston-data.mojang.com', 'launcher.mojang.com'];
const FIRST_SERVER_RELEASE = '1.2.5';

const ManifestSchema = z.object({
  versions: z.array(z.object({ id: z.string(), type: z.string(), url: z.string(), releaseTime: z.string() })),
});

const VersionJsonSchema = z.object({
  downloads: z
    .object({ server: z.object({ url: z.string(), sha1: z.string(), size: z.number() }).optional() })
    .optional(),
  javaVersion: z.object({ majorVersion: z.number().int() }).optional(),
});

export interface MojangVersionInfo {
  javaMajor: number;
  server: { url: string; sha1: string; size: number } | null;
}

export const versionNotFound = (message: string): AppError => new AppError(404, 'VERSION_NOT_FOUND', message);

export class MojangApi {
  constructor(private readonly upstream: Upstream) {}

  private manifest(): Promise<z.infer<typeof ManifestSchema>> {
    return this.upstream.json(MOJANG_MANIFEST_URL, ManifestSchema);
  }

  async mcVersions(includeSnapshots: boolean): Promise<McVersion[]> {
    const { versions } = await this.manifest();
    const cutoff = versions.find((v) => v.id === FIRST_SERVER_RELEASE)?.releaseTime;
    return versions
      .filter(
        (v) =>
          (v.type === 'release' || (includeSnapshots && v.type === 'snapshot')) &&
          (cutoff === undefined || v.releaseTime >= cutoff),
      )
      .map((v): McVersion => ({ id: v.id, type: v.type === 'release' ? 'release' : 'snapshot' }));
  }

  async info(mcVersion: string): Promise<MojangVersionInfo> {
    const entry = (await this.manifest()).versions.find((v) => v.id === mcVersion);
    if (entry === undefined) throw versionNotFound(`Minecraft ${mcVersion} was not found.`);
    const json = await this.upstream.json(entry.url, VersionJsonSchema);
    return { javaMajor: json.javaVersion?.majorVersion ?? 8, server: json.downloads?.server ?? null };
  }

  async javaMajor(mcVersion: string): Promise<number> {
    return (await this.info(mcVersion)).javaMajor;
  }
}
