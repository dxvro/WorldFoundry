import { eq } from 'drizzle-orm';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import { extractZip } from '../../archive/zip.js';
import type { Db } from '../../db/client.js';
import { servers, type Server } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import type { KeyedLock } from '../../lib/keyed-lock.js';
import { downloadToTmp } from '../../mods/downloader.js';
import type { ServerRuntimeGuard } from '../../mods/runtime-guard.js';
import { binaryDir } from './adapter.js';

// Satisfactory mods from ficsit.app (the Satisfactory Mod Repository, used by the Satisfactory Mod Manager). A server
// needs the server build of each mod (target LinuxServer or WindowsServer) and the Satisfactory Mod Loader (SML);
// every mod is unpacked into FactoryGame/Mods/<mod reference>.
export const FICSIT_API = 'https://api.ficsit.app';
const DOWNLOAD_HOSTS = ['api.ficsit.app', 'storage.ficsit.app'];
const MANIFEST = '.worldfoundry-mods.json';
const PAGE_SIZE = 20;
const MAX_MODS = 100;
const REFERENCE = /^[A-Za-z0-9_]{1,64}$/;

const TargetSchema = z.object({ targetName: z.string(), link: z.string(), size: z.number().nullable().optional(), hash: z.string().nullable().optional() });
const VersionSchema = z.object({
  version: z.string(),
  game_version: z.string().nullable().optional(),
  stability: z.string(),
  targets: z.array(TargetSchema).default([]),
  dependencies: z.array(z.object({ mod_reference: z.string(), condition: z.string(), optional: z.boolean() })).default([]),
});
const ModSchema = z.object({ mod_reference: z.string(), name: z.string(), versions: z.array(VersionSchema).default([]) });
const HitSchema = z.object({
  id: z.string(),
  mod_reference: z.string(),
  name: z.string(),
  short_description: z.string().nullable().optional(),
  logo: z.string().nullable().optional(),
  downloads: z.number().default(0),
});

export type FicsitVersion = z.infer<typeof VersionSchema>;
export type FicsitMod = z.infer<typeof ModSchema>;

export interface FicsitApi {
  search(query: string, offset: number): Promise<{ hits: Array<z.infer<typeof HitSchema>>; total: number }>;
  mod(reference: string): Promise<FicsitMod>;
}

export class FicsitClient implements FicsitApi {
  constructor(private readonly fetchFn: typeof fetch = fetch, private readonly userAgent = 'WorldFoundry') {}

  private async query<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${FICSIT_API}/v2/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': this.userAgent },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppError(502, 'UPSTREAM_UNREACHABLE', 'ficsit.app cannot be reached. Please check the internet connection.', undefined, { host: 'api.ficsit.app' });
    }
    if (!response.ok) throw new AppError(502, 'UPSTREAM_ERROR', `ficsit.app responded with HTTP ${response.status}.`, undefined, { host: 'api.ficsit.app' });
    const parsed = z.object({ data: schema }).safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new AppError(502, 'UPSTREAM_INVALID', 'ficsit.app returned data in an unexpected format.', undefined, { host: 'api.ficsit.app' });
    return parsed.data.data;
  }

  async search(text: string, offset: number): Promise<{ hits: Array<z.infer<typeof HitSchema>>; total: number }> {
    const trimmed = text.trim();
    const result = await this.query(
      'query($filter: ModFilter) { getMods(filter: $filter) { count mods { id mod_reference name short_description logo downloads } } }',
      { filter: { limit: PAGE_SIZE, offset, order: 'desc', order_by: trimmed === '' ? 'popularity' : 'search', ...(trimmed === '' ? {} : { search: trimmed }) } },
      z.object({ getMods: z.object({ count: z.number(), mods: z.array(HitSchema) }) }),
    );
    return { hits: result.getMods.mods, total: result.getMods.count };
  }

  async mod(reference: string): Promise<FicsitMod> {
    const result = await this.query(
      'query($ref: ModReference!) { getModByReference(modReference: $ref) { mod_reference name versions(filter: { limit: 100, order_by: created_at, order: desc }) { version game_version stability targets { targetName link size hash } dependencies { mod_reference condition optional } } } }',
      { ref: reference },
      z.object({ getModByReference: ModSchema.nullable() }),
    );
    if (result.getModByReference === null) throw new AppError(404, 'FICSIT_MOD_NOT_FOUND', `The mod "${reference}" was not found on ficsit.app.`, undefined, { name: reference });
    return result.getModByReference;
  }
}

const STABILITY: Record<string, number> = { release: 0, beta: 1, alpha: 2 };

// Newest version for the server platform that fits the game build and the wanted range; releases before betas.
export function pickVersion(mod: FicsitMod, target: string, range: string | null, gameBuild: number | null): FicsitVersion | null {
  const fitting = mod.versions.filter((version) => {
    if (!version.targets.some((entry) => entry.targetName === target)) return false;
    if (semver.valid(version.version) === null) return false;
    if (range !== null && !semver.satisfies(version.version, range, { includePrerelease: true })) return false;
    if (gameBuild !== null && version.game_version !== null && version.game_version !== undefined && version.game_version !== '') {
      if (!semver.satisfies(`${gameBuild}.0.0`, version.game_version, { loose: true })) return false;
    }
    return true;
  });
  fitting.sort((a, b) => (STABILITY[a.stability] ?? 3) - (STABILITY[b.stability] ?? 3) || semver.rcompare(a.version, b.version));
  return fitting[0] ?? null;
}

export interface InstalledMod {
  reference: string;
  name: string;
  version: string;
  // installed because another mod needs it
  dependency: boolean;
  // mod references with the version ranges this mod needs
  requires: Record<string, string>;
}

export interface FicsitView {
  mods: InstalledMod[];
  gameBuild: number | null;
}

export interface FicsitHit {
  reference: string;
  name: string;
  summary: string;
  logo: string | null;
  downloads: number;
  installed: boolean;
}

// The changelist of the installed server, from the *.version file the engine ships next to the binary
export async function readGameBuild(dir: string): Promise<number | null> {
  for (const platform of ['Linux', 'Win64']) {
    const folder = path.join(binaryDir(dir), 'Engine', 'Binaries', platform);
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names.filter((entry) => entry.endsWith('.version'))) {
      try {
        const parsed = JSON.parse(await readFile(path.join(folder, name), 'utf8')) as { Changelist?: unknown; BuildId?: unknown };
        if (typeof parsed.Changelist === 'number' && parsed.Changelist > 0) return parsed.Changelist;
      } catch {
        // next file
      }
    }
  }
  return null;
}

export class FicsitService {
  constructor(
    private readonly options: { db: Db; serversDir: string; lock: KeyedLock; guard: ServerRuntimeGuard; api: FicsitApi; fetch?: typeof fetch; platform?: NodeJS.Platform },
  ) {}

  private get target(): string {
    return (this.options.platform ?? process.platform) === 'win32' ? 'WindowsServer' : 'LinuxServer';
  }

  private async server(serverId: string): Promise<Server> {
    const row = (await this.options.db.select().from(servers).where(eq(servers.id, serverId)))[0];
    if (row === undefined) throw new AppError(404, 'SERVER_NOT_FOUND', 'The server was not found.');
    if (row.game !== 'satisfactory') throw new AppError(409, 'GAME_FEATURE_UNSUPPORTED', 'ficsit.app mods are only available for Satisfactory servers.', undefined, { game: row.game });
    return row;
  }

  private dirs(server: Server): { dir: string; mods: string } {
    const dir = path.join(this.options.serversDir, server.id);
    return { dir, mods: path.join(binaryDir(dir), 'FactoryGame', 'Mods') };
  }

  private async manifest(modsDir: string): Promise<Map<string, InstalledMod>> {
    try {
      const parsed = JSON.parse(await readFile(path.join(modsDir, MANIFEST), 'utf8')) as { mods?: InstalledMod[] };
      return new Map((parsed.mods ?? []).map((mod) => [mod.reference, mod]));
    } catch {
      return new Map();
    }
  }

  private async saveManifest(modsDir: string, mods: Map<string, InstalledMod>): Promise<void> {
    await mkdir(modsDir, { recursive: true });
    const file = path.join(modsDir, MANIFEST);
    await writeFile(`${file}.part`, `${JSON.stringify({ format: 1, mods: [...mods.values()].sort((a, b) => a.reference.localeCompare(b.reference)) }, null, 2)}\n`);
    await rename(`${file}.part`, file);
  }

  async list(serverId: string): Promise<FicsitView> {
    const server = await this.server(serverId);
    const { dir, mods } = this.dirs(server);
    return { mods: [...(await this.manifest(mods)).values()].sort((a, b) => a.name.localeCompare(b.name)), gameBuild: await readGameBuild(dir) };
  }

  async search(serverId: string, query: string, offset: number): Promise<{ hits: FicsitHit[]; total: number; offset: number; limit: number }> {
    const server = await this.server(serverId);
    const installed = await this.manifest(this.dirs(server).mods);
    const result = await this.options.api.search(query, offset);
    return {
      hits: result.hits.map((hit) => ({ reference: hit.mod_reference, name: hit.name, summary: hit.short_description ?? '', logo: hit.logo ?? null, downloads: hit.downloads, installed: installed.has(hit.mod_reference) })),
      total: result.total,
      offset,
      limit: PAGE_SIZE,
    };
  }

  private assertStopped(serverId: string): void {
    if (this.options.guard.isRunning(serverId)) throw new AppError(409, 'SERVER_RUNNING', 'The server is running. Please stop it before changing its mods.');
  }

  async install(serverId: string, reference: string): Promise<{ installed: InstalledMod[] }> {
    if (!REFERENCE.test(reference)) throw new AppError(422, 'FICSIT_MOD_INVALID', 'Invalid mod reference.');
    this.assertStopped(serverId);
    return this.options.lock.run(serverId, async () => {
      this.assertStopped(serverId);
      const server = await this.server(serverId);
      const { dir, mods: modsDir } = this.dirs(server);
      const installed = await this.manifest(modsDir);
      if (installed.has(reference) && !installed.get(reference)?.dependency) throw new AppError(409, 'MOD_ALREADY_INSTALLED', 'This mod is already installed.');
      const gameBuild = await readGameBuild(dir);

      // what to install: the mod and every required dependency that is missing or does not fit
      const plan = new Map<string, { mod: FicsitMod; version: FicsitVersion; dependency: boolean }>();
      const queue: Array<{ reference: string; range: string | null; dependency: boolean; neededBy: string | null }> = [{ reference, range: null, dependency: false, neededBy: null }];
      while (queue.length > 0) {
        const next = queue.shift() as (typeof queue)[number];
        const planned = plan.get(next.reference);
        if (planned !== undefined) {
          if (next.range !== null && !semver.satisfies(planned.version.version, next.range, { includePrerelease: true })) {
            throw new AppError(409, 'FICSIT_CONFLICT', `"${next.neededBy}" needs ${next.reference} ${next.range}, which conflicts with ${planned.version.version}.`);
          }
          continue;
        }
        const current = installed.get(next.reference);
        if (next.dependency && current !== undefined && (next.range === null || semver.satisfies(current.version, next.range, { includePrerelease: true }))) continue;
        if (plan.size >= MAX_MODS) throw new AppError(422, 'FICSIT_TOO_MANY', 'The mod needs too many dependencies to install them at once.');
        const mod = await this.options.api.mod(next.reference);
        const version = pickVersion(mod, this.target, next.range, gameBuild);
        if (version === null) {
          throw new AppError(
            422,
            'NO_COMPATIBLE_VERSION',
            `"${mod.name}" has no version for this server${next.range === null ? '' : ` that matches ${next.range}`}${gameBuild === null ? '' : ` (game build ${gameBuild})`}.`,
            undefined,
            { name: mod.name },
          );
        }
        plan.set(next.reference, { mod, version, dependency: next.dependency && (current === undefined || current.dependency) });
        for (const dep of version.dependencies) {
          if (dep.optional || !REFERENCE.test(dep.mod_reference)) continue;
          queue.push({ reference: dep.mod_reference, range: dep.condition, dependency: true, neededBy: mod.name });
        }
      }

      const staging = path.join(dir, '.tmp', 'ficsit');
      await rm(staging, { recursive: true, force: true });
      try {
        const unpacked = new Map<string, string>();
        for (const [ref, entry] of plan) {
          const target = entry.version.targets.find((candidate) => candidate.targetName === this.target);
          if (target === undefined || target.hash === null || target.hash === undefined) throw new AppError(502, 'DOWNLOAD_HASH_MISMATCH', 'No checksum is available for the file.');
          const archive = await downloadToTmp(
            {
              url: new URL(target.link, FICSIT_API).href,
              fileName: `${ref}-${entry.version.version.replace(/[^0-9A-Za-z.-]/g, '_')}.zip`,
              hash: { algorithm: 'sha256', value: target.hash },
              ...(target.size === null || target.size === undefined ? {} : { size: target.size }),
              fileKind: 'archive',
              requireZip: true,
              allowedHosts: DOWNLOAD_HOSTS,
            },
            path.join(staging, 'downloads'),
            { fetch: this.options.fetch ?? fetch, allowedHosts: DOWNLOAD_HOSTS, timeoutMs: 10 * 60_000 },
          );
          const into = path.join(staging, 'unpacked', ref);
          await extractZip(archive, into, { maxBytes: 4 * 1024 * 1024 * 1024, maxEntries: 50_000 });
          unpacked.set(ref, into);
        }
        await mkdir(modsDir, { recursive: true });
        for (const [ref, from] of unpacked) {
          const to = path.join(modsDir, ref);
          await rm(to, { recursive: true, force: true });
          await rename(from, to);
          const entry = plan.get(ref) as { mod: FicsitMod; version: FicsitVersion; dependency: boolean };
          installed.set(ref, {
            reference: ref,
            name: entry.mod.name,
            version: entry.version.version,
            dependency: entry.dependency,
            requires: Object.fromEntries(entry.version.dependencies.filter((dep) => !dep.optional).map((dep) => [dep.mod_reference, dep.condition])),
          });
        }
        await this.saveManifest(modsDir, installed);
        return { installed: [...plan.keys()].map((ref) => installed.get(ref) as InstalledMod) };
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async remove(serverId: string, reference: string): Promise<{ removed: string }> {
    if (!REFERENCE.test(reference)) throw new AppError(422, 'FICSIT_MOD_INVALID', 'Invalid mod reference.');
    this.assertStopped(serverId);
    return this.options.lock.run(serverId, async () => {
      this.assertStopped(serverId);
      const server = await this.server(serverId);
      const { mods: modsDir } = this.dirs(server);
      const installed = await this.manifest(modsDir);
      if (!installed.has(reference)) throw new AppError(404, 'MOD_NOT_FOUND', 'The mod was not found.');
      const dependents = [...installed.values()].filter((mod) => mod.reference !== reference && reference in mod.requires);
      if (dependents.length > 0) {
        throw new AppError(409, 'MOD_REQUIRED_BY_OTHERS', `"${reference}" is required by other mods: ${dependents.map((mod) => mod.name).join(', ')}.`, { dependents: dependents.map((mod) => ({ id: mod.reference, name: mod.name })) });
      }
      await rm(path.join(modsDir, reference), { recursive: true, force: true });
      installed.delete(reference);
      await this.saveManifest(modsDir, installed);
      return { removed: reference };
    });
  }
}
