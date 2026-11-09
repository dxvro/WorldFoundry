import { z } from 'zod';
import type { Loader } from '../db/enums.js';
import { AppError } from '../http/errors.js';
import type { HashAlgorithm } from '../mods/downloader.js';
import { compareMcDesc, compareNumeric, isSnapshotLike } from './mc-version.js';
import { MOJANG_DOWNLOAD_HOSTS, versionNotFound, type MojangApi } from './mojang.js';
import type { LoaderProvider, LoaderVersion, McVersion, ResolvedInstall } from './types.js';
import type { Upstream } from './upstream.js';

const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

function pickVersion(list: readonly LoaderVersion[], wanted: string | null, label: string, mcVersion: string): LoaderVersion {
  if (wanted !== null) {
    const found = list.find((entry) => entry.version === wanted);
    if (found === undefined) throw versionNotFound(`${label} version ${wanted} for Minecraft ${mcVersion} was not found.`);
    return found;
  }
  const choice = list.find((entry) => entry.recommended) ?? list.find((entry) => entry.stable) ?? list[0];
  if (choice === undefined) throw versionNotFound(`No ${label} version was found for Minecraft ${mcVersion}.`);
  return choice;
}

const numericParts = (version: string): number[] => (version.match(/\d+/g) ?? []).map((part) => Number(part));

export class VanillaProvider implements LoaderProvider {
  readonly loader: Loader = 'vanilla';
  constructor(private readonly mojang: MojangApi) {}

  mcVersions(includeSnapshots: boolean): Promise<McVersion[]> {
    return this.mojang.mcVersions(includeSnapshots);
  }

  async versions(mcVersion: string): Promise<LoaderVersion[]> {
    await this.mojang.info(mcVersion);
    return [];
  }

  async resolve(mcVersion: string): Promise<ResolvedInstall> {
    const info = await this.mojang.info(mcVersion);
    if (info.server === null) {
      throw new AppError(
        422,
        'NO_SERVER_DOWNLOAD',
        `Mojang does not provide a server download for Minecraft ${mcVersion}. Please choose a different version.`,
      );
    }
    return {
      loaderVersion: null,
      requiredJavaMajor: info.javaMajor,
      artifact: {
        url: info.server.url,
        fileName: 'server.jar',
        hash: { algorithm: 'sha1', value: info.server.sha1 },
        size: info.server.size,
        allowedHosts: MOJANG_DOWNLOAD_HOSTS,
        requireZip: true,
      },
      mode: { kind: 'jar', launchJar: 'server.jar' },
      notes: [],
    };
  }
}

const FABRIC_BASE = 'https://meta.fabricmc.net/v2/versions';
const FabricGameSchema = z.array(z.object({ version: z.string(), stable: z.boolean() }));
const FabricLoaderSchema = z.array(z.object({ loader: z.object({ version: z.string(), stable: z.boolean() }) }));
const FabricInstallerSchema = z.array(z.object({ version: z.string(), stable: z.boolean() }));

export class FabricProvider implements LoaderProvider {
  readonly loader: Loader = 'fabric';
  constructor(
    private readonly upstream: Upstream,
    private readonly mojang: MojangApi,
  ) {}

  async mcVersions(includeSnapshots: boolean): Promise<McVersion[]> {
    const games = await this.upstream.json(`${FABRIC_BASE}/game`, FabricGameSchema);
    return games
      .filter((game) => includeSnapshots || game.stable)
      .map((game): McVersion => ({ id: game.version, type: game.stable ? 'release' : 'snapshot' }));
  }

  async versions(mcVersion: string): Promise<LoaderVersion[]> {
    const list = await this.upstream.json(`${FABRIC_BASE}/loader/${encodeURIComponent(mcVersion)}`, FabricLoaderSchema, {
      notFoundStatuses: [400],
      onNotFound: () => versionNotFound(`Fabric does not support Minecraft ${mcVersion}.`),
    });
    if (list.length === 0) throw versionNotFound(`Fabric does not support Minecraft ${mcVersion}.`);
    const entries = list.map((entry) => entry.loader);
    const firstStable = entries.find((entry) => entry.stable)?.version;
    return entries.map((entry) => ({ version: entry.version, stable: entry.stable, recommended: entry.version === firstStable }));
  }

  async resolve(mcVersion: string, loaderVersion: string | null): Promise<ResolvedInstall> {
    const chosen = pickVersion(await this.versions(mcVersion), loaderVersion, 'Fabric', mcVersion);
    const installers = await this.upstream.json(`${FABRIC_BASE}/installer`, FabricInstallerSchema);
    const installer = installers.find((entry) => entry.stable) ?? installers[0];
    if (installer === undefined || !SAFE_VERSION.test(installer.version)) {
      throw new AppError(502, 'UPSTREAM_INVALID', 'Fabric did not return a valid installer version.');
    }
    const url = `${FABRIC_BASE}/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(chosen.version)}/${encodeURIComponent(installer.version)}/server/jar`;
    return {
      loaderVersion: chosen.version,
      requiredJavaMajor: await this.mojang.javaMajor(mcVersion),
      artifact: { url, fileName: 'fabric-server-launch.jar', allowedHosts: ['meta.fabricmc.net'], requireZip: true },
      mode: { kind: 'jar', launchJar: 'fabric-server-launch.jar' },
      notes: ['Fabric does not publish a checksum; only the host and the file format are verified.'],
    };
  }
}

const PAPER_BASE = 'https://fill.papermc.io/v3/projects/paper';
const PaperProjectSchema = z.object({ versions: z.record(z.string(), z.array(z.string())) });
const PaperVersionSchema = z.object({
  version: z.object({ java: z.object({ version: z.object({ minimum: z.number().int() }).optional() }).optional() }),
});
const PaperBuildsSchema = z.array(
  z.object({
    id: z.number().int(),
    channel: z.string(),
    downloads: z.record(
      z.string(),
      z.object({ name: z.string(), url: z.string(), size: z.number(), checksums: z.object({ sha256: z.string() }) }),
    ),
  }),
);
type PaperBuild = z.infer<typeof PaperBuildsSchema>[number];

function paperVersions(builds: readonly PaperBuild[]): LoaderVersion[] {
  const newestStable = builds.find((build) => build.channel === 'STABLE')?.id;
  return builds.map((build) => ({
    version: String(build.id),
    stable: build.channel === 'STABLE',
    recommended: build.id === newestStable,
  }));
}

export class PaperProvider implements LoaderProvider {
  readonly loader: Loader = 'paper';
  constructor(
    private readonly upstream: Upstream,
    private readonly mojang: MojangApi,
  ) {}

  async mcVersions(includeSnapshots: boolean): Promise<McVersion[]> {
    const project = await this.upstream.json(PAPER_BASE, PaperProjectSchema);
    return Object.values(project.versions)
      .flat()
      .map((id): McVersion => ({ id, type: isSnapshotLike(id) ? 'snapshot' : 'release' }))
      .filter((entry) => includeSnapshots || entry.type === 'release')
      .sort((a, b) => compareMcDesc(a.id, b.id));
  }

  private async builds(mcVersion: string): Promise<PaperBuild[]> {
    const builds = await this.upstream.json(`${PAPER_BASE}/versions/${encodeURIComponent(mcVersion)}/builds`, PaperBuildsSchema, {
      onNotFound: () => versionNotFound(`Paper does not support Minecraft ${mcVersion}.`),
    });
    if (builds.length === 0) throw versionNotFound(`There is no Paper build for Minecraft ${mcVersion}.`);
    return [...builds].sort((a, b) => b.id - a.id);
  }

  async versions(mcVersion: string): Promise<LoaderVersion[]> {
    return paperVersions(await this.builds(mcVersion));
  }

  async resolve(mcVersion: string, loaderVersion: string | null): Promise<ResolvedInstall> {
    const builds = await this.builds(mcVersion);
    const chosen = pickVersion(paperVersions(builds), loaderVersion, 'Paper', mcVersion);
    const build = builds.find((entry) => String(entry.id) === chosen.version);
    const download = build?.downloads['server:default'];
    if (build === undefined || download === undefined) {
      throw new AppError(502, 'UPSTREAM_INVALID', 'Paper did not provide a server download for this build.');
    }
    const meta = await this.upstream
      .json(`${PAPER_BASE}/versions/${encodeURIComponent(mcVersion)}`, PaperVersionSchema)
      .catch(() => null);
    return {
      loaderVersion: chosen.version,
      requiredJavaMajor: Math.max(await this.mojang.javaMajor(mcVersion), meta?.version.java?.version?.minimum ?? 0),
      artifact: {
        url: download.url,
        fileName: download.name,
        hash: { algorithm: 'sha256', value: download.checksums.sha256 },
        size: download.size,
        allowedHosts: ['fill-data.papermc.io'],
        requireZip: true,
      },
      mode: { kind: 'jar', launchJar: download.name },
      notes: chosen.stable
        ? []
        : [`There is no stable build for Paper ${mcVersion}; build ${build.id} (${build.channel}) is used.`],
    };
  }
}

// 21.1.172 -> 1.21.1, 20.4.5-beta -> 1.20.4, 26.1.2.7 -> 26.1.2, 26.3.0.9 -> 26.3
export function neoForgeMcVersion(version: string): string | null {
  const legacy = /^(20|21)\.(\d+)\.\d+(?:-beta)?$/.exec(version);
  if (legacy?.[1] !== undefined && legacy[2] !== undefined) {
    return legacy[2] === '0' ? `1.${legacy[1]}` : `1.${legacy[1]}.${legacy[2]}`;
  }
  const yearBased = /^(\d{2,})\.(\d+)\.(\d+)\.\d+(?:-beta)?$/.exec(version);
  if (yearBased?.[1] !== undefined && Number(yearBased[1]) >= 26) {
    return yearBased[3] === '0' ? `${yearBased[1]}.${yearBased[2]}` : `${yearBased[1]}.${yearBased[2]}.${yearBased[3]}`;
  }
  return null;
}

const NEOFORGE_VERSIONS_URL = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const NEOFORGE_FILES = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const NeoForgeListSchema = z.object({ versions: z.array(z.string()) });
const CHECKSUM_ORDER: readonly HashAlgorithm[] = ['sha512', 'sha256', 'sha1'];
const HEX_LENGTH: Record<HashAlgorithm, number> = { sha1: 40, sha256: 64, sha512: 128 };

async function fetchChecksum(upstream: Upstream, jarUrl: string): Promise<{ algorithm: HashAlgorithm; value: string }> {
  for (const algorithm of CHECKSUM_ORDER) {
    let text: string;
    try {
      text = await upstream.text(`${jarUrl}.${algorithm}`);
    } catch (error) {
      if (error instanceof AppError && error.code === 'VERSION_NOT_FOUND') continue;
      throw error;
    }
    const value = (text.trim().split(/\s+/)[0] ?? '').toLowerCase();
    if (new RegExp(`^[0-9a-f]{${HEX_LENGTH[algorithm]}}$`).test(value)) return { algorithm, value };
    throw new AppError(502, 'UPSTREAM_INVALID', 'The published checksum has an unexpected format.');
  }
  throw new AppError(
    502,
    'CHECKSUM_UNAVAILABLE',
    'No checksum is published for the installer. The download is cancelled for security reasons.',
  );
}

export class NeoForgeProvider implements LoaderProvider {
  readonly loader: Loader = 'neoforge';
  constructor(
    private readonly upstream: Upstream,
    private readonly mojang: MojangApi,
  ) {}

  private async all(): Promise<Array<{ version: string; mc: string; stable: boolean }>> {
    const { versions } = await this.upstream.json(NEOFORGE_VERSIONS_URL, NeoForgeListSchema);
    const out: Array<{ version: string; mc: string; stable: boolean }> = [];
    for (const version of versions) {
      const mc = neoForgeMcVersion(version);
      if (mc !== null) out.push({ version, mc, stable: !version.endsWith('-beta') });
    }
    return out;
  }

  async mcVersions(): Promise<McVersion[]> {
    const ids = [...new Set((await this.all()).map((entry) => entry.mc))];
    return ids.sort(compareMcDesc).map((id): McVersion => ({ id, type: 'release' }));
  }

  async versions(mcVersion: string): Promise<LoaderVersion[]> {
    if (mcVersion === '1.20.1') {
      throw new AppError(
        404,
        'VERSION_NOT_FOUND',
        'NeoForge is not supported for Minecraft 1.20.1 (there it is a separate legacy branch). Please use Forge.',
      );
    }
    const list = (await this.all())
      .filter((entry) => entry.mc === mcVersion)
      .sort((a, b) => compareNumeric(numericParts(b.version), numericParts(a.version)));
    if (list.length === 0) throw versionNotFound(`NeoForge does not support Minecraft ${mcVersion}.`);
    const newestStable = list.find((entry) => entry.stable)?.version;
    return list.map((entry) => ({ version: entry.version, stable: entry.stable, recommended: entry.version === newestStable }));
  }

  async resolve(mcVersion: string, loaderVersion: string | null): Promise<ResolvedInstall> {
    const chosen = pickVersion(await this.versions(mcVersion), loaderVersion, 'NeoForge', mcVersion);
    const fileName = `neoforge-${chosen.version}-installer.jar`;
    const url = `${NEOFORGE_FILES}/${chosen.version}/${fileName}`;
    return {
      loaderVersion: chosen.version,
      requiredJavaMajor: await this.mojang.javaMajor(mcVersion),
      artifact: {
        url,
        fileName,
        hash: await fetchChecksum(this.upstream, url),
        allowedHosts: ['maven.neoforged.net'],
        requireZip: true,
      },
      mode: { kind: 'installer', arguments: ['--install-server'] },
      notes: chosen.stable ? [] : [`NeoForge ${chosen.version} is a pre-release (beta).`],
    };
  }
}

const FORGE_META_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json';
const FORGE_PROMOS_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_FILES = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const ForgeMetaSchema = z.record(z.string(), z.array(z.string()));
const ForgePromosSchema = z.object({ promos: z.record(z.string(), z.string()) });
const FORGE_MIN_MC = [1, 7, 2];

export class ForgeProvider implements LoaderProvider {
  readonly loader: Loader = 'forge';
  constructor(
    private readonly upstream: Upstream,
    private readonly mojang: MojangApi,
  ) {}

  // installers exist from 1.5.2 on, but only 1.7.2 and newer are offered
  private supported(mc: string): boolean {
    return /^\d+(\.\d+)*$/.test(mc) && compareNumeric(numericParts(mc), FORGE_MIN_MC) >= 0;
  }

  async mcVersions(): Promise<McVersion[]> {
    const meta = await this.upstream.json(FORGE_META_URL, ForgeMetaSchema);
    return Object.keys(meta)
      .filter((id) => this.supported(id))
      .sort(compareMcDesc)
      .map((id): McVersion => ({ id, type: 'release' }));
  }

  async versions(mcVersion: string): Promise<LoaderVersion[]> {
    const meta = await this.upstream.json(FORGE_META_URL, ForgeMetaSchema);
    const entries = meta[mcVersion];
    if (entries === undefined || !this.supported(mcVersion)) throw versionNotFound(`Forge does not support Minecraft ${mcVersion}.`);
    const promos = (await this.upstream.json(FORGE_PROMOS_URL, ForgePromosSchema)).promos;
    const recommended = promos[`${mcVersion}-recommended`];
    const latest = promos[`${mcVersion}-latest`];
    const prefix = `${mcVersion}-`;
    const matches = (version: string, promo: string | undefined): boolean =>
      promo !== undefined && (version === promo || version.startsWith(`${promo}-`));
    const versions = entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length))
      .filter((version) => SAFE_VERSION.test(version))
      .sort((a, b) => compareNumeric(numericParts(b), numericParts(a)));
    const preferred = versions.find((v) => matches(v, recommended)) ?? versions.find((v) => matches(v, latest)) ?? versions[0];
    return versions.map((version) => ({ version, stable: true, recommended: version === preferred }));
  }

  async resolve(mcVersion: string, loaderVersion: string | null): Promise<ResolvedInstall> {
    const chosen = pickVersion(await this.versions(mcVersion), loaderVersion, 'Forge', mcVersion);
    const full = `${mcVersion}-${chosen.version}`;
    const fileName = `forge-${full}-installer.jar`;
    const url = `${FORGE_FILES}/${full}/${fileName}`;
    return {
      loaderVersion: chosen.version,
      requiredJavaMajor: await this.mojang.javaMajor(mcVersion),
      artifact: {
        url,
        fileName,
        hash: await fetchChecksum(this.upstream, url),
        allowedHosts: ['maven.minecraftforge.net'],
        requireZip: true,
      },
      mode: { kind: 'installer', arguments: ['--installServer'] },
      notes: [],
    };
  }
}
