import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { fetchAllowed, isTimeoutError, type DownloaderOptions } from '../mods/downloader.js';

export const ADOPTIUM_API = 'https://api.adoptium.net';
// api.adoptium.net answers with metadata; the archives sit on GitHub releases, which redirect to GitHub's asset host
export const ADOPTIUM_METADATA_HOSTS: readonly string[] = ['api.adoptium.net'];
export const ADOPTIUM_DOWNLOAD_HOSTS: readonly string[] = ['api.adoptium.net', 'github.com', 'release-assets.githubusercontent.com'];

export type ImageType = 'jre' | 'jdk';

export interface TemurinTarget {
  os: 'windows' | 'linux' | 'mac';
  arch: 'x64' | 'aarch64';
  archive: 'zip' | 'tar.gz';
  label: string;
}

const OS_LABEL = { windows: 'Windows', linux: 'Linux', mac: 'macOS' } as const;

export function temurinTarget(platform: NodeJS.Platform, arch: string): TemurinTarget {
  const os = platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : platform === 'darwin' ? 'mac' : null;
  const mapped = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'aarch64' : null;
  if (os === null || mapped === null) {
    throw new AppError(
      422,
      'JAVA_PLATFORM_UNSUPPORTED',
      `Eclipse Temurin does not offer a Java runtime for ${platform} (${arch}). Please install Java manually and enter the path in the server settings.`,
    );
  }
  return { os, arch: mapped, archive: os === 'windows' ? 'zip' : 'tar.gz', label: `${OS_LABEL[os]} (${arch})` };
}

export interface TemurinAsset {
  major: number;
  release: string;
  version: string;
  image: ImageType;
  url: string;
  fileName: string;
  sha256: string;
  size: number;
}

const AssetsSchema = z.array(
  z.object({
    binary: z.object({
      architecture: z.string(),
      os: z.string(),
      image_type: z.string(),
      package: z.object({
        checksum: z.string().regex(/^[0-9a-f]{64}$/i),
        link: z.string().min(1),
        name: z.string().min(1),
        size: z.number().int().positive(),
      }),
    }),
    release_name: z.string(),
    version: z.object({ major: z.number().int(), openjdk_version: z.string() }),
  }),
);

export interface AdoptiumOptions {
  fetch: typeof fetch;
  userAgent: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class AdoptiumApi {
  constructor(private readonly options: AdoptiumOptions) {}

  private fetchOptions(signal: AbortSignal | undefined): Pick<DownloaderOptions, 'fetch' | 'timeoutMs' | 'headers' | 'signal'> {
    const active = signal ?? this.options.signal;
    return {
      fetch: this.options.fetch,
      timeoutMs: this.options.timeoutMs ?? 20_000,
      headers: { 'User-Agent': this.options.userAgent },
      ...(active === undefined ? {} : { signal: active }),
    };
  }

  private async json(url: string, signal: AbortSignal | undefined): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetchAllowed(url, ADOPTIUM_METADATA_HOSTS, this.fetchOptions(signal), { Accept: 'application/json' });
    } catch (error) {
      if (error instanceof AppError && error.code === 'DOWNLOAD_URL_REJECTED') throw error;
      if (error instanceof AppError && error.code === 'DOWNLOAD_TIMEOUT') {
        throw new AppError(504, 'UPSTREAM_TIMEOUT', 'The service "api.adoptium.net" did not respond in time.', undefined, { host: 'api.adoptium.net' });
      }
      throw new AppError(502, 'UPSTREAM_UNREACHABLE', 'The service "api.adoptium.net" is not reachable. Please check the internet connection.', undefined, { host: 'api.adoptium.net' });
    }
    try {
      const text = await response.text();
      if (response.status === 404) return { status: 404, body: null };
      if (!response.ok) throw new AppError(502, 'UPSTREAM_ERROR', `The service "api.adoptium.net" responded with HTTP ${response.status}.`, undefined, { host: 'api.adoptium.net', status: response.status });
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isTimeoutError(error)) throw new AppError(504, 'UPSTREAM_TIMEOUT', 'The service "api.adoptium.net" did not respond in time.', undefined, { host: 'api.adoptium.net' });
      throw new AppError(502, 'UPSTREAM_INVALID', 'The response from "api.adoptium.net" has an unexpected format.', undefined, { host: 'api.adoptium.net' });
    }
  }

  // newest GA build of the given feature release, or null when Temurin has none for this platform
  async latest(major: number, target: TemurinTarget, image: ImageType, signal?: AbortSignal): Promise<TemurinAsset | null> {
    const query = new URLSearchParams({ architecture: target.arch, image_type: image, os: target.os, vendor: 'eclipse' });
    const { body } = await this.json(`${ADOPTIUM_API}/v3/assets/latest/${major}/hotspot?${query.toString()}`, signal);
    if (body === null) return null;
    const parsed = AssetsSchema.safeParse(body);
    if (!parsed.success) throw new AppError(502, 'UPSTREAM_INVALID', 'The response from "api.adoptium.net" has an unexpected format.', undefined, { host: 'api.adoptium.net' });
    const entry = parsed.data.find(
      (item) =>
        item.version.major === major &&
        item.binary.os === target.os &&
        item.binary.architecture === target.arch &&
        item.binary.image_type === image &&
        item.binary.package.name.toLowerCase().endsWith(target.archive === 'zip' ? '.zip' : '.tar.gz'),
    );
    if (entry === undefined) return null;
    return {
      major,
      release: entry.release_name,
      version: entry.version.openjdk_version,
      image,
      url: entry.binary.package.link,
      fileName: entry.binary.package.name,
      sha256: entry.binary.package.checksum.toLowerCase(),
      size: entry.binary.package.size,
    };
  }
}
