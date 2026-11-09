import type { VersionType, Version, VersionFile } from '../modrinth/types.js';
import type { LoaderProfile } from './profile.js';

const RANK: Record<VersionType, number> = { release: 2, beta: 1, alpha: 0 };

export const stabilityRank = (type: VersionType): number => RANK[type];

export function pickFile(version: Version): VersionFile | null {
  const jars = version.files.filter(
    (file) => file.file_type == null && /\.jar$/i.test(file.filename) && file.hashes.sha512 !== undefined,
  );
  return jars.find((file) => file.primary) ?? jars[0] ?? null;
}

export function isCompatible(version: Version, profile: LoaderProfile, mcVersion: string): boolean {
  return (
    version.game_versions.includes(mcVersion) &&
    version.loaders.some((loader) => profile.loaders.includes(loader)) &&
    pickFile(version) !== null
  );
}

export const publishedAt = (version: Version): number => Date.parse(version.date_published);

export function chooseNewest(
  versions: readonly Version[],
  profile: LoaderProfile,
  mcVersion: string,
  minRank = 0,
): Version | null {
  const candidates = versions
    .filter((v) => isCompatible(v, profile, mcVersion) && stabilityRank(v.version_type) >= minRank)
    .sort((a, b) => stabilityRank(b.version_type) - stabilityRank(a.version_type) || publishedAt(b) - publishedAt(a));
  return candidates[0] ?? null;
}

// update path: newest by date among versions that are at least as stable as the installed one
export function chooseNewestByDate(
  versions: readonly Version[],
  profile: LoaderProfile,
  mcVersion: string,
  minRank: number,
): Version | null {
  const candidates = versions
    .filter((v) => isCompatible(v, profile, mcVersion) && stabilityRank(v.version_type) >= minRank)
    .sort((a, b) => publishedAt(b) - publishedAt(a));
  return candidates[0] ?? null;
}
