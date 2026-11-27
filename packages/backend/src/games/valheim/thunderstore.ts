import { eq } from 'drizzle-orm';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveEntry } from '../../archive/safe-path.js';
import { zipDirectory, readZipFile } from '../../archive/zip-read.js';
import { extractZip } from '../../archive/zip.js';
import type { Db } from '../../db/client.js';
import { servers, type Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { allowedImageUrl } from '../../lib/images.js';
import type { KeyedLock } from '../../lib/keyed-lock.js';
import { downloadToTmp } from '../../mods/downloader.js';
import type { ServerRuntimeGuard } from '../../mods/runtime-guard.js';
import { binaryDir } from './adapter.js';

// Valheim mods from Thunderstore (thunderstore.io/c/valheim, the source of r2modman and the Thunderstore Mod Manager).
// Almost every mod is a BepInEx plugin and depends on the BepInEx pack, which is installed into the server folder like
// any other package. Packages carry no checksum; a download is checked for its host, the zip format and its manifest.
export const THUNDERSTORE = 'https://thunderstore.io';
export const COMMUNITY = 'valheim';
export const BEPINEX_PACK = 'denikson-BepInExPack_Valheim';
const DOWNLOAD_HOSTS = ['thunderstore.io', 'ccdn.thunderstore.io', 'gcdn.thunderstore.io'];
const MANIFEST = '.worldfoundry-thunderstore.json';
export const PAGE_SIZE = 20;
const MAX_PACKAGES = 150;
const PART = /^[A-Za-z0-9_]{1,128}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
// tools for players, not mods: they cannot run on a server
const NOT_MODS = new Set(['ebkr-r2modman', 'Thunderstore-Thunderstore_Mod_Manager']);
// files of a package that only describe it
const META_FILES = new Set(['manifest.json', 'icon.png', 'readme.md', 'changelog.md', 'license', 'license.md', 'license.txt']);

export const ORDERINGS = ['most-downloaded', 'last-updated', 'newest', 'top-rated'] as const;
export type Ordering = (typeof ORDERINGS)[number];

const VersionSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  version_number: z.string(),
  full_name: z.string(),
  description: z.string().default(''),
  icon: z.string().nullish(),
  dependencies: z.array(z.string()).default([]),
  download_url: z.string(),
});
const PackageSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  full_name: z.string(),
  is_deprecated: z.boolean().default(false),
  latest: VersionSchema,
});
export type ThunderstorePackage = z.infer<typeof PackageSchema>;

const ListingSchema = z.object({
  count: z.number(),
  results: z.array(
    z.object({
      namespace: z.string(),
      name: z.string(),
      description: z.string().nullish(),
      icon_url: z.string().nullish(),
      download_count: z.number().default(0),
      is_deprecated: z.boolean().default(false),
      categories: z.array(z.object({ slug: z.string(), name: z.string() })).default([]),
    }),
  ),
});
export type ThunderstoreListing = z.infer<typeof ListingSchema>;

export interface ThunderstoreApi {
  search(query: string, ordering: Ordering, page: number): Promise<ThunderstoreListing>;
  // the package with its newest version
  package(namespace: string, name: string): Promise<ThunderstorePackage>;
}

export class ThunderstoreClient implements ThunderstoreApi {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly userAgent = 'WorldFoundry',
  ) {}

  private async get<T>(url: string, schema: z.ZodType<T>, notFound: () => AppError): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(url, { headers: { Accept: 'application/json', 'User-Agent': this.userAgent }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new AppError(502, 'UPSTREAM_UNREACHABLE', 'Thunderstore cannot be reached. Please check the internet connection.', undefined, { host: 'thunderstore.io' });
    }
    if (response.status === 404) throw notFound();
    if (!response.ok) throw new AppError(502, 'UPSTREAM_ERROR', `Thunderstore responded with HTTP ${response.status}.`, undefined, { host: 'thunderstore.io', status: response.status });
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new AppError(502, 'UPSTREAM_INVALID', 'Thunderstore returned data in an unexpected format.', undefined, { host: 'thunderstore.io' });
    return parsed.data;
  }

  search(query: string, ordering: Ordering, page: number): Promise<ThunderstoreListing> {
    const url = new URL(`${THUNDERSTORE}/api/cyberstorm/listing/${COMMUNITY}/`);
    url.searchParams.set('q', query.trim());
    url.searchParams.set('ordering', ordering);
    url.searchParams.set('page', String(page));
    url.searchParams.set('deprecated', 'False');
    url.searchParams.set('nsfw', 'False');
    // page 2 of a search with fewer hits is a 404; that is an empty page, not a missing package
    return this.get(url.href, ListingSchema, () => new AppError(404, 'THUNDERSTORE_PAGE_NOT_FOUND', 'There are no more results.'));
  }

  package(namespace: string, name: string): Promise<ThunderstorePackage> {
    return this.get(`${THUNDERSTORE}/api/experimental/package/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/`, PackageSchema, () => notFoundPackage(`${namespace}-${name}`));
  }
}

const notFoundPackage = (fullName: string): AppError =>
  new AppError(404, 'THUNDERSTORE_PACKAGE_NOT_FOUND', `The package "${fullName}" was not found on Thunderstore.`, undefined, { name: fullName });

// "Namespace-Name-1.2.3" (a dependency) or "Namespace-Name" (a package)
export function parseReference(value: string): { namespace: string; name: string; version: string | null } | null {
  const parts = value.split('-');
  if (parts.length < 2 || parts.length > 3) return null;
  const [namespace, name, version] = parts as [string, string, string | undefined];
  if (!PART.test(namespace) || !PART.test(name)) return null;
  if (version !== undefined && !VERSION.test(version)) return null;
  return { namespace, name, version: version ?? null };
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface InstalledPackage {
  // Namespace-Name
  fullName: string;
  name: string;
  version: string;
  // installed because another package needs it
  dependency: boolean;
  // Namespace-Name of the packages it needs, with the version it asked for
  requires: Record<string, string>;
  // files and folders it put into the server folder (relative to it); removed with the package. Configs stay.
  paths: string[];
}

export interface ThunderstoreView {
  mods: InstalledPackage[];
  bepinex: boolean;
}

export interface ThunderstoreHit {
  fullName: string;
  name: string;
  owner: string;
  summary: string;
  icon: string | null;
  downloads: number;
  // Thunderstore's own labels: does the mod belong on the server, on the players' computers or both
  serverSide: boolean;
  clientSide: boolean;
  installed: boolean;
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

// BepInEx is in place once its preloader is: the adapter then starts the server through Doorstop
export const bepinexInstalled = (serverDir: string): Promise<boolean> => exists(path.join(binaryDir(serverDir), 'BepInEx', 'core', 'BepInEx.Preloader.dll'));

// Every file below `from`, relative to it
async function listFiles(from: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(from, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(from, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// Copies the files below `from` to `to`; a config that already exists is kept (the user may have changed it)
async function mergeFiles(from: string, to: string, keepExisting: (rel: string) => boolean): Promise<string[]> {
  const written: string[] = [];
  for (const rel of await listFiles(from)) {
    const target = path.join(to, rel);
    if (keepExisting(rel) && (await exists(target))) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(from, rel), target, { force: true });
    written.push(rel);
  }
  return written;
}

const isConfig = (rel: string): boolean => rel.split(path.sep)[0]?.toLowerCase() === 'config';

export class ThunderstoreService {
  constructor(
    private readonly options: { db: Db; serversDir: string; lock: KeyedLock; guard: ServerRuntimeGuard; api: ThunderstoreApi; fetch?: typeof fetch },
  ) {}

  private async server(serverId: string): Promise<Server> {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    if (row.game !== 'valheim') throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', 'Thunderstore mods are only available for Valheim servers.', undefined, { game: row.game });
    return row;
  }

  private root(server: Server): string {
    return binaryDir(path.join(this.options.serversDir, server.id));
  }

  private async manifest(root: string): Promise<Map<string, InstalledPackage>> {
    try {
      const parsed = JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8')) as { mods?: InstalledPackage[] };
      return new Map((parsed.mods ?? []).map((mod) => [mod.fullName, mod]));
    } catch {
      return new Map();
    }
  }

  private async saveManifest(root: string, mods: Map<string, InstalledPackage>): Promise<void> {
    await mkdir(root, { recursive: true });
    const file = path.join(root, MANIFEST);
    await writeFile(`${file}.part`, `${JSON.stringify({ format: 1, mods: [...mods.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)) }, null, 2)}\n`);
    await rename(`${file}.part`, file);
  }

  async list(serverId: string): Promise<ThunderstoreView> {
    const server = await this.server(serverId);
    const root = this.root(server);
    return {
      mods: [...(await this.manifest(root)).values()].sort((a, b) => Number(a.dependency) - Number(b.dependency) || a.name.localeCompare(b.name)),
      bepinex: await bepinexInstalled(path.join(this.options.serversDir, server.id)),
    };
  }

  async search(serverId: string, query: string, ordering: Ordering, offset: number): Promise<{ hits: ThunderstoreHit[]; total: number; offset: number; limit: number }> {
    const server = await this.server(serverId);
    const installed = await this.manifest(this.root(server));
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    let listing: ThunderstoreListing;
    try {
      listing = await this.options.api.search(query, ordering, page);
    } catch (error) {
      if (error instanceof AppError && error.code === 'THUNDERSTORE_PAGE_NOT_FOUND') return { hits: [], total: 0, offset, limit: PAGE_SIZE };
      throw error;
    }
    return {
      hits: listing.results
        .filter((hit) => !hit.is_deprecated && !NOT_MODS.has(`${hit.namespace}-${hit.name}`))
        .map((hit) => {
          const slugs = new Set(hit.categories.map((category) => category.slug));
          const fullName = `${hit.namespace}-${hit.name}`;
          return {
            fullName,
            name: hit.name.replaceAll('_', ' '),
            owner: hit.namespace,
            summary: hit.description ?? '',
            icon: allowedImageUrl(hit.icon_url),
            downloads: hit.download_count,
            serverSide: slugs.has('server-side'),
            clientSide: slugs.has('client-side'),
            installed: installed.has(fullName),
          };
        }),
      total: listing.count,
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    };
  }

  private assertStopped(serverId: string): void {
    if (this.options.guard.isRunning(serverId)) throw new AppError(409, 'SERVER_RUNNING', 'The server is running. Please stop it before changing its mods.');
  }

  // Installs a package with every dependency that is missing or older than asked for. A modpack is a package that only
  // has dependencies, so it installs the same way.
  async install(serverId: string, fullName: string): Promise<{ installed: InstalledPackage[] }> {
    const wanted = parseReference(fullName);
    if (wanted === null || wanted.version !== null) throw new AppError(422, 'THUNDERSTORE_PACKAGE_INVALID', 'Invalid package name.');
    if (NOT_MODS.has(fullName)) throw new AppError(422, 'THUNDERSTORE_NOT_A_MOD', 'This package is a program for players, not a server mod.');
    this.assertStopped(serverId);
    return this.options.lock.run(serverId, async () => {
      this.assertStopped(serverId);
      const server = await this.server(serverId);
      const root = this.root(server);
      const installed = await this.manifest(root);
      const current = installed.get(fullName);
      if (current !== undefined && !current.dependency) throw new AppError(409, 'MOD_ALREADY_INSTALLED', 'This mod is already installed.', undefined, { name: current.name });

      const plan = new Map<string, { pkg: ThunderstorePackage; dependency: boolean }>();
      const queue: Array<{ namespace: string; name: string; minimum: string | null; dependency: boolean }> = [{ namespace: wanted.namespace, name: wanted.name, minimum: null, dependency: false }];
      while (queue.length > 0) {
        const next = queue.shift() as (typeof queue)[number];
        const key = `${next.namespace}-${next.name}`;
        if (plan.has(key)) continue;
        const have = installed.get(key);
        if (next.dependency && have !== undefined && (next.minimum === null || compareVersions(have.version, next.minimum) >= 0)) continue;
        if (plan.size >= MAX_PACKAGES) throw new AppError(422, 'THUNDERSTORE_TOO_MANY', 'The mod needs too many dependencies to install them at once.');
        const pkg = await this.options.api.package(next.namespace, next.name);
        if (next.minimum !== null && compareVersions(pkg.latest.version_number, next.minimum) < 0) {
          throw new AppError(422, 'NO_COMPATIBLE_VERSION', `"${pkg.name}" has no version ${next.minimum} or newer.`, undefined, { name: pkg.name });
        }
        plan.set(key, { pkg, dependency: next.dependency && (have === undefined || have.dependency) });
        for (const dep of pkg.latest.dependencies) {
          const ref = parseReference(dep);
          if (ref === null || ref.version === null) continue;
          queue.push({ namespace: ref.namespace, name: ref.name, minimum: ref.version, dependency: true });
        }
      }

      const staging = path.join(path.dirname(root), '.tmp', 'thunderstore');
      await rm(staging, { recursive: true, force: true });
      try {
        // everything is downloaded and checked before the first file of the server changes
        const unpacked = new Map<string, string>();
        for (const [key, { pkg }] of plan) {
          const version = pkg.latest;
          const archive = await downloadToTmp(
            {
              url: version.download_url,
              fileName: `${key}-${version.version_number}.zip`,
              fileKind: 'archive',
              requireZip: true,
              allowedHosts: DOWNLOAD_HOSTS,
            },
            path.join(staging, 'downloads'),
            { fetch: this.options.fetch ?? fetch, allowedHosts: DOWNLOAD_HOSTS, timeoutMs: 10 * 60_000 },
          );
          await this.checkManifest(archive, version.name, version.version_number);
          const into = path.join(staging, 'unpacked', key);
          await extractZip(archive, into, { maxBytes: 2 * 1024 * 1024 * 1024, maxEntries: 50_000 });
          unpacked.set(key, into);
        }
        // the BepInEx pack first: the plugin folders of the others live inside it
        const order = [...unpacked.keys()].sort((a, b) => Number(b === BEPINEX_PACK) - Number(a === BEPINEX_PACK));
        for (const key of order) {
          const entry = plan.get(key) as { pkg: ThunderstorePackage; dependency: boolean };
          const old = installed.get(key);
          if (old !== undefined) await this.removePaths(root, old.paths);
          const paths = key === BEPINEX_PACK ? await this.placeBepInEx(unpacked.get(key) as string, root) : await this.placePlugin(unpacked.get(key) as string, root, key);
          installed.set(key, {
            fullName: key,
            name: entry.pkg.name.replaceAll('_', ' '),
            version: entry.pkg.latest.version_number,
            dependency: entry.dependency,
            requires: Object.fromEntries(
              entry.pkg.latest.dependencies.flatMap((dep) => {
                const ref = parseReference(dep);
                return ref === null || ref.version === null ? [] : [[`${ref.namespace}-${ref.name}`, ref.version]];
              }),
            ),
            paths,
          });
        }
        await this.saveManifest(root, installed);
        return { installed: [...plan.keys()].map((key) => installed.get(key) as InstalledPackage) };
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  // The package's manifest.json must name what was asked for; a wrong or broken download stops here
  private async checkManifest(archive: string, name: string, version: string): Promise<void> {
    const raw = await readZipFile(archive, await zipDirectory(archive), 'manifest.json', 1024 * 1024).catch(() => null);
    let manifest: { name?: unknown; version_number?: unknown } | null = null;
    try {
      manifest = raw === null ? null : (JSON.parse(raw.toString('utf8').replace(/^﻿/, '')) as { name?: unknown; version_number?: unknown });
    } catch {
      manifest = null;
    }
    if (manifest === null || manifest.name !== name || manifest.version_number !== version) {
      throw new AppError(502, 'DOWNLOAD_INVALID_FILE', `The download of "${name}" is not the expected Thunderstore package.`, undefined, { name });
    }
  }

  // BepInExPack_Valheim/ holds BepInEx/, doorstop_libs/, winhttp.dll and doorstop_config.ini for the server folder
  private async placeBepInEx(from: string, root: string): Promise<string[]> {
    const content = path.join(from, 'BepInExPack_Valheim');
    if (!(await exists(content))) throw new AppError(502, 'DOWNLOAD_INVALID_FILE', 'The BepInEx pack has an unexpected layout.', undefined, { name: 'BepInExPack_Valheim' });
    const written = await mergeFiles(content, root, (rel) => rel.startsWith(path.join('BepInEx', 'config')));
    return written.filter((rel) => !rel.startsWith(path.join('BepInEx', 'config')));
  }

  // The layout r2modman uses for Valheim: plugins/, patchers/ and monomod/ into a folder of the package, config/ into
  // BepInEx/config, a BepInEx/ folder over the server's, and loose files into the package's plugin folder
  private async placePlugin(from: string, root: string, key: string): Promise<string[]> {
    const bepinex = path.join(root, 'BepInEx');
    const paths: string[] = [];
    const own = (folder: string): string => path.join('BepInEx', folder, key);
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const lower = entry.name.toLowerCase();
      const source = path.join(from, entry.name);
      if (entry.isFile() && META_FILES.has(lower)) continue;
      if (entry.isDirectory() && ['plugins', 'patchers', 'monomod'].includes(lower)) {
        await mergeFiles(source, path.join(root, own(lower)), () => false);
        if (!paths.includes(own(lower))) paths.push(own(lower));
      } else if (entry.isDirectory() && lower === 'config') {
        await mergeFiles(source, path.join(bepinex, 'config'), () => true);
      } else if (entry.isDirectory() && lower === 'bepinex') {
        const written = await mergeFiles(source, bepinex, isConfig);
        paths.push(...written.filter((rel) => !isConfig(rel)).map((rel) => path.join('BepInEx', rel)));
      } else if (entry.isDirectory()) {
        // any other folder (assets, translations ...) goes next to the plugin
        await mergeFiles(source, path.join(root, own('plugins'), entry.name), () => false);
        if (!paths.includes(own('plugins'))) paths.push(own('plugins'));
      } else if (entry.isFile()) {
        await mkdir(path.join(root, own('plugins')), { recursive: true });
        await cp(source, path.join(root, own('plugins'), entry.name), { force: true });
        if (!paths.includes(own('plugins'))) paths.push(own('plugins'));
      }
    }
    return paths;
  }

  private async removePaths(root: string, paths: readonly string[]): Promise<void> {
    for (const rel of paths) {
      // a manifest edited by hand must not reach outside the server folder
      const { target } = resolveEntry(root, rel);
      const info = await lstat(target).catch(() => null);
      if (info !== null) await rm(target, { recursive: true, force: true });
    }
  }

  async remove(serverId: string, fullName: string): Promise<{ removed: string }> {
    if (parseReference(fullName) === null) throw new AppError(422, 'THUNDERSTORE_PACKAGE_INVALID', 'Invalid package name.');
    this.assertStopped(serverId);
    return this.options.lock.run(serverId, async () => {
      this.assertStopped(serverId);
      const server = await this.server(serverId);
      const root = this.root(server);
      const installed = await this.manifest(root);
      const mod = installed.get(fullName);
      if (mod === undefined) throw new AppError(404, 'MOD_NOT_FOUND', 'The mod was not found.');
      const dependents = [...installed.values()].filter((other) => other.fullName !== fullName && fullName in other.requires);
      if (dependents.length > 0) {
        throw new AppError(409, 'MOD_REQUIRED_BY_OTHERS', `"${mod.name}" is required by other mods: ${dependents.map((other) => other.name).join(', ')}.`, { dependents: dependents.map((other) => ({ id: other.fullName, name: other.name })) }, {
          name: mod.name,
          dependents: dependents.map((other) => other.name).join(', '),
        });
      }
      await this.removePaths(root, mod.paths);
      installed.delete(fullName);
      await this.saveManifest(root, installed);
      return { removed: fullName };
    });
  }
}
