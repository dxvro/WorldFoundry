import { z } from 'zod';
import { AppError } from '../http/errors.js';
import {
  CategorySchema,
  ProjectSchema,
  SearchResultSchema,
  VersionSchema,
  type Category,
  type ModrinthApi,
  type Project,
  type SearchParams,
  type SearchResult,
  type Version,
} from './types.js';

export const MODRINTH_BASE_URL = 'https://api.modrinth.com/v2';
const BATCH_SIZE = 100;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

export interface ModrinthClientOptions {
  userAgent: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class ModrinthClient implements ModrinthApi {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;
  private categoryCache: Category[] | null = null;

  constructor(options: ModrinthClientOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? MODRINTH_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.sleep = options.sleep ?? wait;
    this.userAgent = options.userAgent;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    pathname: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + pathname);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { 'User-Agent': this.userAgent, Accept: 'application/json' };
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    for (let attempt = 1; ; attempt++) {
      const last = attempt >= this.maxAttempts;
      let response: Response;
      let payload: unknown;
      try {
        response = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        if (response.status === 429 || !response.ok) {
          void response.body?.cancel().catch(() => undefined);
        } else {
          payload = await response.json();
        }
      } catch (error) {
        if (last) {
          throw isTimeout(error)
            ? new AppError(504, 'MODRINTH_TIMEOUT', 'Modrinth did not respond in time.')
            : new AppError(502, 'MODRINTH_UNREACHABLE', 'Modrinth is not reachable.');
        }
        await this.sleep(this.backoff(attempt));
        continue;
      }

      if (response.status === 429) {
        if (last) {
          throw new AppError(503, 'MODRINTH_RATE_LIMITED', 'Modrinth is currently rate limiting requests. Please try again later.');
        }
        await this.sleep(this.rateLimitWait(response));
        continue;
      }
      if (response.status >= 500) {
        if (last) throw new AppError(502, 'MODRINTH_UNREACHABLE', 'Modrinth is currently unavailable.');
        await this.sleep(this.backoff(attempt));
        continue;
      }
      if (response.status === 404) {
        throw new AppError(404, 'MOD_NOT_FOUND', 'The project or version was not found on Modrinth.');
      }
      if (!response.ok) {
        throw new AppError(502, 'MODRINTH_BAD_RESPONSE', `Modrinth rejected the request (HTTP ${response.status}).`, undefined, { status: response.status });
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new AppError(502, 'MODRINTH_BAD_RESPONSE', 'Modrinth returned an unexpected response.');
      }
      return parsed.data;
    }
  }

  private backoff(attempt: number): number {
    return Math.min(500 * 2 ** (attempt - 1), 8_000);
  }

  private rateLimitWait(response: Response): number {
    const seconds = Number(response.headers.get('x-ratelimit-reset') ?? response.headers.get('retry-after'));
    const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2_000;
    return Math.min(ms, MAX_RATE_LIMIT_WAIT_MS);
  }

  search(params: SearchParams): Promise<SearchResult> {
    return this.request('GET', '/search', SearchResultSchema, {
      query: {
        query: params.query,
        facets: JSON.stringify(params.facets),
        index: params.index,
        limit: String(params.limit),
        offset: String(params.offset),
      },
    });
  }

  getProject(idOrSlug: string): Promise<Project> {
    return this.request('GET', `/project/${encodeURIComponent(idOrSlug)}`, ProjectSchema);
  }

  async getProjects(ids: readonly string[]): Promise<Project[]> {
    const out: Project[] = [];
    for (const part of chunk([...new Set(ids)], BATCH_SIZE)) {
      out.push(...(await this.request('GET', '/projects', z.array(ProjectSchema), { query: { ids: JSON.stringify(part) } })));
    }
    return out;
  }

  listProjectVersions(projectId: string, loaders: readonly string[], gameVersions: readonly string[]): Promise<Version[]> {
    return this.request('GET', `/project/${encodeURIComponent(projectId)}/version`, z.array(VersionSchema), {
      query: { loaders: JSON.stringify(loaders), game_versions: JSON.stringify(gameVersions) },
    });
  }

  getVersion(id: string): Promise<Version> {
    return this.request('GET', `/version/${encodeURIComponent(id)}`, VersionSchema);
  }

  async getVersions(ids: readonly string[]): Promise<Version[]> {
    const out: Version[] = [];
    for (const part of chunk([...new Set(ids)], BATCH_SIZE)) {
      out.push(...(await this.request('GET', '/versions', z.array(VersionSchema), { query: { ids: JSON.stringify(part) } })));
    }
    return out;
  }

  async versionFilesByHash(sha512Hashes: readonly string[]): Promise<Record<string, Version>> {
    const out: Record<string, Version> = {};
    for (const part of chunk([...new Set(sha512Hashes)], 200)) {
      Object.assign(
        out,
        await this.request('POST', '/version_files', z.record(z.string(), VersionSchema), {
          body: { hashes: part, algorithm: 'sha512' },
        }),
      );
    }
    return out;
  }

  async versionFilesUpdate(
    sha512Hashes: readonly string[],
    loaders: readonly string[],
    gameVersions: readonly string[],
  ): Promise<Record<string, Version>> {
    const out: Record<string, Version> = {};
    for (const part of chunk([...new Set(sha512Hashes)], 200)) {
      Object.assign(
        out,
        await this.request('POST', '/version_files/update', z.record(z.string(), VersionSchema), {
          body: { hashes: part, algorithm: 'sha512', loaders, game_versions: gameVersions },
        }),
      );
    }
    return out;
  }

  async categories(): Promise<Category[]> {
    this.categoryCache ??= await this.request('GET', '/tag/category', z.array(CategorySchema));
    return this.categoryCache;
  }
}
