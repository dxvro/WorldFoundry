import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { extractTarGz } from '../../archive/tar.js';
import { AppError } from '../../http/errors.js';
import { msg } from '../../messages.js';
import { downloadToTmp, fetchAllowed } from '../../mods/downloader.js';
import { exists } from '../steam-game.js';
import type { InstallContext } from '../types.js';

// GE-Proton (https://github.com/GloriousEggroll/proton-ge-custom, open source): runs the Windows-only ARK: Survival
// Ascended server on Linux. The newest release is downloaded once into <data>/runtimes/proton and checked against the
// SHA-512 the release publishes next to it.
const RELEASES = 'https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/latest';
const HOSTS = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const ASSET = /^GE-Proton[\w.-]*-x86_64\.tar\.gz$/;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

// the newest proton that is already unpacked, or null
export async function installedProton(root: string): Promise<string | null> {
  const names = (await readdir(root).catch(() => [])).filter((name) => name.startsWith('GE-Proton')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const name of names) if (await exists(path.join(root, name, 'proton'))) return path.join(root, name, 'proton');
  return null;
}

export async function ensureProton(root: string, ctx: InstallContext, fetcher: typeof fetch = fetch): Promise<string> {
  const present = await installedProton(root);
  if (present !== null) return present;
  ctx.log('GE-Proton: looking up the newest release on GitHub');
  const options = { fetch: fetcher, timeoutMs: 30_000, signal: ctx.signal };
  const release = (await (await fetchAllowed(RELEASES, HOSTS, options, { Accept: 'application/vnd.github+json' })).json().catch(() => null)) as { tag_name?: unknown; assets?: ReleaseAsset[] } | null;
  const tarball = release?.assets?.find((asset) => ASSET.test(asset.name));
  const sums = release?.assets?.find((asset) => asset.name === tarball?.name.replace(/\.tar\.gz$/, '.sha512sum'));
  if (tarball === undefined || sums === undefined) throw new AppError(502, 'UPSTREAM_UNREACHABLE', 'The GE-Proton release on GitHub could not be read.', undefined, { service: 'github.com' });
  const sumText = await (await fetchAllowed(sums.browser_download_url, HOSTS, options)).text();
  const sha512 = /^([0-9a-f]{128})\s/m.exec(sumText)?.[1];
  if (sha512 === undefined) throw new AppError(502, 'DOWNLOAD_HASH_MISMATCH', 'The checksum file of GE-Proton is invalid.');
  ctx.log(`GE-Proton: ${tarball.name}`);
  const tmp = path.join(root, '.download');
  await rm(tmp, { recursive: true, force: true });
  try {
    const archive = await downloadToTmp(
      {
        url: tarball.browser_download_url,
        fileName: tarball.name,
        fileKind: 'archive',
        hash: { algorithm: 'sha512', value: sha512 },
        onProgress: (received, total) => ctx.progress('download', total === null ? null : (received / total) * 100, msg('INSTALL_STEP_DOWNLOAD', { fileName: tarball.name, kib: Math.round(received / 1024) })),
      },
      tmp,
      { fetch: fetcher, allowedHosts: HOSTS, timeoutMs: 30 * 60_000, signal: ctx.signal },
    );
    const unpacked = path.join(tmp, 'unpacked');
    // Proton ships symlinks between its libraries; extraction still keeps every path inside the folder
    await extractTarGz(archive, unpacked, { maxBytes: 4 * 1024 * 1024 * 1024, maxEntries: 200_000, allowSymlinks: true, checkpoint: () => ctx.signal.throwIfAborted() });
    const top = (await readdir(unpacked)).find((name) => name.startsWith('GE-Proton'));
    if (top === undefined || !(await exists(path.join(unpacked, top, 'proton')))) throw new AppError(502, 'DOWNLOAD_INVALID_FILE', 'The GE-Proton download does not contain proton.');
    await mkdir(root, { recursive: true });
    await rm(path.join(root, top), { recursive: true, force: true });
    await rename(path.join(unpacked, top), path.join(root, top));
    return path.join(root, top, 'proton');
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const protonVersion = async (protonScript: string): Promise<string> => (await readFile(path.join(path.dirname(protonScript), 'version'), 'utf8').catch(() => path.basename(path.dirname(protonScript)))).trim();
