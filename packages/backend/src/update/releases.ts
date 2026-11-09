import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { msg, type MessageRef, type Msg } from '../messages.js';
import { fetchSmallBuffer, type UpdateHttpOptions } from './http.js';
import { compareSemver, isPrerelease, normalizeVersion, parseSemver } from './semver.js';
import { SIGNATURE_NAME, SUMS_NAME } from './verify.js';

const MAX_API_BYTES = 5 * 1024 * 1024;
export const MAX_NOTES_CHARS = 20_000;
export const MAX_ASSET_BYTES = 600 * 1024 * 1024;

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
}

export interface Release {
  tag: string;
  version: string;
  name: string | null;
  notes: string;
  prerelease: boolean;
  htmlUrl: string;
  publishedAt: string | null;
  assets: ReleaseAsset[];
}

const assetSchema = z.object({ name: z.string().max(300), size: z.number().int().nonnegative(), browser_download_url: z.string().max(2000) });
const releaseSchema = z.object({
  tag_name: z.string().max(100),
  name: z.string().max(300).nullable().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  html_url: z.string().max(2000).optional(),
  published_at: z.string().max(100).nullable().optional(),
  assets: z.array(assetSchema).max(200).optional(),
});

// the notes become text in the UI; control characters have no business in there
export function cleanNotes(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, MAX_NOTES_CHARS);
}

// "worldfoundry-<version>-setup.exe" (Windows service) or "worldfoundry-<version>-linux-<arch>.tar.gz"
export function platformAssetName(version: string, platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'win32' && arch === 'x64') return `worldfoundry-${version}-setup.exe`;
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return `worldfoundry-${version}-linux-${arch}.tar.gz`;
  return null;
}

// A download address must be exactly the release download of this repository; everything else is ignored.
// (Test builds talk to a local fake server whose paths are not GitHub's.)
export function isExpectedAssetUrl(raw: string, repo: string, tag: string, name: string, allowInsecureHttp: boolean): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (allowInsecureHttp) return url.protocol === 'http:' || url.protocol === 'https:';
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '') return false;
  const expected = `/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`.toLowerCase();
  return url.pathname.toLowerCase() === expected;
}

export function parseReleases(raw: unknown, repo: string, options: { allowInsecureHttp: boolean }): Release[] {
  const list = z.array(z.unknown()).safeParse(raw);
  if (!list.success) throw new AppError(502, 'UPDATE_RESPONSE_INVALID', 'GitHub returned an unexpected response.');
  const releases: Release[] = [];
  for (const entry of list.data) {
    const parsed = releaseSchema.safeParse(entry);
    if (!parsed.success || parsed.data.draft === true) continue;
    const version = normalizeVersion(parsed.data.tag_name);
    const semver = version === null ? null : parseSemver(version);
    if (version === null || semver === null) continue;
    // GitHub marks releases as prerelease; a version like "1.2.0-rc.1" is one in any case
    const prerelease = parsed.data.prerelease === true || isPrerelease(semver);
    const assets: ReleaseAsset[] = [];
    for (const asset of parsed.data.assets ?? []) {
      if (!isExpectedAssetUrl(asset.browser_download_url, repo, parsed.data.tag_name, asset.name, options.allowInsecureHttp)) continue;
      assets.push({ name: asset.name, size: asset.size, url: asset.browser_download_url });
    }
    releases.push({
      tag: parsed.data.tag_name,
      version,
      name: parsed.data.name ?? null,
      notes: cleanNotes(parsed.data.body ?? ''),
      prerelease,
      htmlUrl: typeof parsed.data.html_url === 'string' && /^https:\/\//.test(parsed.data.html_url) ? parsed.data.html_url : `https://github.com/${repo}/releases`,
      publishedAt: parsed.data.published_at ?? null,
      assets,
    });
  }
  return releases;
}

// The newest release of the channel; prereleases only when the channel allows them
export function pickLatest(releases: readonly Release[], channel: 'stable' | 'prerelease'): Release | null {
  let best: Release | null = null;
  for (const release of releases) {
    if (release.prerelease && channel !== 'prerelease') continue;
    const candidate = parseSemver(release.version);
    if (candidate === null) continue;
    const current = best === null ? null : parseSemver(best.version);
    if (best === null || current === null || compareSemver(candidate, current) > 0) best = release;
  }
  return best;
}

export async function fetchReleases(apiBase: string, repo: string, http: UpdateHttpOptions): Promise<Release[]> {
  const buffer = await fetchSmallBuffer(`${apiBase.replace(/\/+$/, '')}/repos/${repo}/releases?per_page=30`, http, MAX_API_BYTES, 'application/vnd.github+json');
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new AppError(502, 'UPDATE_RESPONSE_INVALID', 'GitHub returned an unexpected response.');
  }
  return parseReleases(raw, repo, { allowInsecureHttp: http.allowInsecureHttp === true });
}

export interface ReleaseFiles {
  asset: ReleaseAsset;
  sums: ReleaseAsset;
  signature: ReleaseAsset;
}

export type FilesLookup = { ok: true; files: ReleaseFiles } | { ok: false; reason: string; reasonRef: MessageRef };

const notOk = (reason: Msg): FilesLookup => ({ ok: false, reason: reason.text, reasonRef: reason.ref });

export function findFiles(release: Release, platform: NodeJS.Platform, arch: string): FilesLookup {
  const wanted = platformAssetName(release.version, platform, arch);
  if (wanted === null) return notOk(msg('UPDATE_NO_PACKAGES', { platform, arch }));
  const asset = release.assets.find((entry) => entry.name === wanted);
  if (asset === undefined) return notOk(msg('UPDATE_NO_ASSET', { version: release.version, asset: wanted }));
  const sums = release.assets.find((entry) => entry.name === SUMS_NAME);
  const signature = release.assets.find((entry) => entry.name === SIGNATURE_NAME);
  if (sums === undefined || signature === undefined) {
    return notOk(msg('UPDATE_UNSIGNED_RELEASE'));
  }
  return { ok: true, files: { asset, sums, signature } };
}
