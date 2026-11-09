import type { z } from 'zod';
import { AppError } from '../http/errors.js';
import { fetchAllowed, isTimeoutError } from '../mods/downloader.js';

export const METADATA_HOSTS: readonly string[] = [
  'piston-meta.mojang.com',
  'meta.fabricmc.net',
  'fill.papermc.io',
  'maven.neoforged.net',
  'maven.minecraftforge.net',
  'files.minecraftforge.net',
];

export interface UpstreamOptions {
  fetch: typeof fetch;
  userAgent: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  hosts?: readonly string[];
}

export interface RequestHints {
  notFoundStatuses?: readonly number[];
  onNotFound?: () => AppError;
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

export class Upstream {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly hosts: readonly string[];

  constructor(private readonly options: UpstreamOptions) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.ttlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.hosts = options.hosts ?? METADATA_HOSTS;
  }

  clearCache(): void {
    this.cache.clear();
  }

  json<T>(url: string, schema: z.ZodType<T>, hints: RequestHints = {}): Promise<T> {
    return this.cached(url, async () => {
      const text = await this.fetchText(url, hints, 'application/json');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw this.invalid(url);
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw this.invalid(url);
      return parsed.data;
    });
  }

  // uncached: checksum files are small and must reflect the current state
  text(url: string, hints: RequestHints = {}): Promise<string> {
    return this.fetchText(url, hints, 'text/plain');
  }

  private invalid(url: string): AppError {
    return new AppError(502, 'UPSTREAM_INVALID', `The response from "${new URL(url).hostname}" has an unexpected format.`, undefined, { host: new URL(url).hostname });
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit !== undefined && hit.expires > this.now()) return hit.value as T;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending as Promise<T>;
    const task = load()
      .then((value) => {
        this.cache.set(key, { expires: this.now() + this.ttlMs, value });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, task);
    return task;
  }

  private async fetchText(url: string, hints: RequestHints, accept: string): Promise<string> {
    const host = new URL(url).hostname;
    let response: Response;
    try {
      response = await fetchAllowed(
        url,
        this.hosts,
        { fetch: this.options.fetch, timeoutMs: this.timeoutMs, headers: { 'User-Agent': this.options.userAgent } },
        { Accept: accept },
      );
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === 'DOWNLOAD_TIMEOUT') {
          throw new AppError(504, 'UPSTREAM_TIMEOUT', `The service "${host}" did not respond in time.`, undefined, { host });
        }
        if (error.code === 'DOWNLOAD_URL_REJECTED') throw error;
        throw new AppError(502, 'UPSTREAM_UNREACHABLE', `The service "${host}" is not reachable. Please check the internet connection.`, undefined, { host });
      }
      throw error;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 404 || hints.notFoundStatuses?.includes(response.status) === true) {
        throw hints.onNotFound?.() ?? new AppError(404, 'VERSION_NOT_FOUND', 'The requested version was not found.');
      }
      throw new AppError(502, 'UPSTREAM_ERROR', `The service "${host}" responded with HTTP ${response.status}.`, undefined, { host, status: response.status });
    }
    try {
      return await response.text();
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new AppError(504, 'UPSTREAM_TIMEOUT', `The service "${host}" did not respond in time.`, undefined, { host });
      }
      throw new AppError(502, 'UPSTREAM_UNREACHABLE', `The connection to "${host}" was interrupted.`, undefined, { host });
    }
  }
}
