import type { LoaderInfo, LoaderVersion, McVersion } from '../contract.js';
import type { Loader } from '../db/enums.js';
import type { HashAlgorithm } from '../mods/downloader.js';


export interface ArtifactSpec {
  url: string;
  fileName: string;
  hash?: { algorithm: HashAlgorithm; value: string };
  size?: number;
  allowedHosts: readonly string[];
  requireZip: boolean;
}

export type InstallMode = { kind: 'jar'; launchJar: string } | { kind: 'installer'; arguments: readonly string[] };

export interface ResolvedInstall {
  loaderVersion: string | null;
  requiredJavaMajor: number;
  artifact: ArtifactSpec;
  mode: InstallMode;
  notes: string[];
}

export interface LoaderProvider {
  readonly loader: Loader;
  mcVersions(includeSnapshots: boolean): Promise<McVersion[]>;
  versions(mcVersion: string): Promise<LoaderVersion[]>;
  resolve(mcVersion: string, loaderVersion: string | null): Promise<ResolvedInstall>;
}

export type { LoaderInfo, LoaderVersion, McVersion };
