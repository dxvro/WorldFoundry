import type { Loader } from '../db/enums.js';
import type { DownloaderOptions } from '../mods/downloader.js';
import { MojangApi } from './mojang.js';
import { FabricProvider, ForgeProvider, NeoForgeProvider, PaperProvider, VanillaProvider } from './providers.js';
import type { LoaderInfo, LoaderProvider, LoaderVersion, McVersion, ResolvedInstall } from './types.js';
import { Upstream, type UpstreamOptions } from './upstream.js';

export const LOADER_INFO: Record<Loader, LoaderInfo> = {
  vanilla: { id: 'vanilla', name: 'Vanilla', supportsMods: false, requiresInstallerJava: false },
  fabric: { id: 'fabric', name: 'Fabric', supportsMods: true, requiresInstallerJava: false },
  paper: { id: 'paper', name: 'Paper', supportsMods: true, requiresInstallerJava: false },
  neoforge: { id: 'neoforge', name: 'NeoForge', supportsMods: true, requiresInstallerJava: true },
  forge: { id: 'forge', name: 'Forge', supportsMods: true, requiresInstallerJava: true },
};

export const INSTALLER_DOWNLOAD_HOSTS: readonly string[] = [
  'piston-data.mojang.com',
  'launcher.mojang.com',
  'meta.fabricmc.net',
  'fill-data.papermc.io',
  'maven.neoforged.net',
  'maven.minecraftforge.net',
];

export interface CatalogOptions extends UpstreamOptions {
  downloadTimeoutMs?: number;
}

export class LoaderCatalog {
  private readonly providers: Record<Loader, LoaderProvider>;
  readonly downloader: DownloaderOptions;

  constructor(options: CatalogOptions) {
    const upstream = new Upstream(options);
    const mojang = new MojangApi(upstream);
    this.providers = {
      vanilla: new VanillaProvider(mojang),
      fabric: new FabricProvider(upstream, mojang),
      paper: new PaperProvider(upstream, mojang),
      neoforge: new NeoForgeProvider(upstream, mojang),
      forge: new ForgeProvider(upstream, mojang),
    };
    this.downloader = {
      fetch: options.fetch,
      allowedHosts: INSTALLER_DOWNLOAD_HOSTS,
      timeoutMs: options.downloadTimeoutMs ?? 10 * 60_000,
      headers: { 'User-Agent': options.userAgent },
    };
  }

  loaders(): LoaderInfo[] {
    return Object.values(LOADER_INFO);
  }

  mcVersions(loader: Loader, includeSnapshots: boolean): Promise<McVersion[]> {
    return this.providers[loader].mcVersions(includeSnapshots);
  }

  versions(loader: Loader, mcVersion: string): Promise<LoaderVersion[]> {
    return this.providers[loader].versions(mcVersion);
  }

  resolve(loader: Loader, mcVersion: string, loaderVersion: string | null): Promise<ResolvedInstall> {
    return this.providers[loader].resolve(mcVersion, loaderVersion);
  }
}
