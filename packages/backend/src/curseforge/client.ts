import { z } from 'zod';
import { AppError } from '../http/errors.js';

// CurseForge for Studios API (https://docs.curseforge.com/rest-api/). Every request needs an API key. WorldFoundry is
// open source and ships none: each user enters their own free key from https://console.curseforge.com.
export const CURSEFORGE_BASE_URL = 'https://api.curseforge.com';
export const MINECRAFT_GAME_ID = 432;
export const CLASS_MODS = 6;
export const CLASS_BUKKIT_PLUGINS = 5;
// where file downloads are served from (downloadUrl and its redirect)
export const CURSEFORGE_DOWNLOAD_HOSTS: readonly string[] = ['edge.forgecdn.net', 'mediafilez.forgecdn.net'];

export const MOD_LOADER_TYPE = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 } as const;
export const RELATION = { embedded: 1, optional: 2, required: 3, tool: 4, incompatible: 5, include: 6 } as const;
export const HASH_ALGO = { sha1: 1, md5: 2 } as const;

const ModSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  summary: z.string().default(''),
  downloadCount: z.number().default(0),
  classId: z.number().int().nullable().optional(),
  // false: the author does not allow downloads outside the CurseForge website and app
  allowModDistribution: z.boolean().nullable().optional(),
  links: z.object({ websiteUrl: z.string().nullable().optional() }).partial().default({}),
  logo: z.object({ thumbnailUrl: z.string().nullable().optional() }).partial().nullable().optional(),
  authors: z.array(z.object({ name: z.string() })).default([]),
  dateModified: z.string().optional(),
});

const FileSchema = z.object({
  id: z.number().int(),
  modId: z.number().int(),
  displayName: z.string(),
  fileName: z.string(),
  releaseType: z.number().int(),
  fileDate: z.string(),
  fileLength: z.number().int().nonnegative(),
  downloadUrl: z.string().nullable(),
  hashes: z.array(z.object({ value: z.string(), algo: z.number().int() })).default([]),
  gameVersions: z.array(z.string()).default([]),
  dependencies: z.array(z.object({ modId: z.number().int(), relationType: z.number().int() })).default([]),
});

const PaginationSchema = z.object({ index: z.number(), pageSize: z.number(), resultCount: z.number(), totalCount: z.number() });

export type CfMod = z.infer<typeof ModSchema>;
export type CfFile = z.infer<typeof FileSchema>;

export interface CfSearchParams {
  classId: number;
  query: string;
  gameVersion: string;
  modLoaderType: number | null;
  index: number;
  pageSize: number;
}

export interface CurseForgeApi {
  // throws CURSEFORGE_KEY_INVALID when the key is refused
  checkKey(apiKey: string): Promise<void>;
  search(apiKey: string, params: CfSearchParams): Promise<{ mods: CfMod[]; total: number }>;
  mod(apiKey: string, modId: number): Promise<CfMod>;
  files(apiKey: string, modId: number, gameVersion: string, modLoaderType: number | null): Promise<CfFile[]>;
  file(apiKey: string, modId: number, fileId: number): Promise<CfFile>;
}

export interface CurseForgeClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  userAgent: string;
}

const HOST = 'api.curseforge.com';

export class CurseForgeClient implements CurseForgeApi {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: CurseForgeClientOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? CURSEFORGE_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async get<T>(apiKey: string, pathname: string, query: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { Accept: 'application/json', 'x-api-key': apiKey, 'User-Agent': this.options.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new AppError(504, 'UPSTREAM_TIMEOUT', 'CurseForge did not respond in time.', undefined, { host: HOST });
      }
      throw new AppError(502, 'UPSTREAM_UNREACHABLE', 'CurseForge cannot be reached. Please check the internet connection.', undefined, { host: HOST });
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError(422, 'CURSEFORGE_KEY_INVALID', 'CurseForge refused the API key. Please check it under System > CurseForge.');
    }
    if (response.status === 404) throw new AppError(404, 'CURSEFORGE_NOT_FOUND', 'The project or file was not found on CurseForge.');
    if (response.status === 429) throw new AppError(503, 'CURSEFORGE_RATE_LIMITED', 'CurseForge is limiting requests at the moment. Please try again later.');
    if (!response.ok) throw new AppError(502, 'UPSTREAM_ERROR', `CurseForge responded with HTTP ${response.status}.`, undefined, { host: HOST });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AppError(502, 'UPSTREAM_INVALID', 'CurseForge returned data in an unexpected format.', undefined, { host: HOST });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new AppError(502, 'UPSTREAM_INVALID', 'CurseForge returned data in an unexpected format.', undefined, { host: HOST });
    return parsed.data;
  }

  async checkKey(apiKey: string): Promise<void> {
    await this.get(apiKey, `/v1/games/${MINECRAFT_GAME_ID}`, {}, z.object({ data: z.object({ id: z.number() }) }));
  }

  async search(apiKey: string, params: CfSearchParams): Promise<{ mods: CfMod[]; total: number }> {
    const query: Record<string, string> = {
      gameId: String(MINECRAFT_GAME_ID),
      classId: String(params.classId),
      gameVersion: params.gameVersion,
      // 2 = popularity, descending
      sortField: '2',
      sortOrder: 'desc',
      index: String(params.index),
      pageSize: String(params.pageSize),
    };
    if (params.query.trim() !== '') query['searchFilter'] = params.query.trim();
    if (params.modLoaderType !== null) query['modLoaderType'] = String(params.modLoaderType);
    const body = await this.get(apiKey, '/v1/mods/search', query, z.object({ data: z.array(ModSchema), pagination: PaginationSchema }));
    // the API refuses pages beyond 10 000 results
    return { mods: body.data, total: Math.min(body.pagination.totalCount, 10_000) };
  }

  async mod(apiKey: string, modId: number): Promise<CfMod> {
    return (await this.get(apiKey, `/v1/mods/${modId}`, {}, z.object({ data: ModSchema }))).data;
  }

  async files(apiKey: string, modId: number, gameVersion: string, modLoaderType: number | null): Promise<CfFile[]> {
    const query: Record<string, string> = { gameVersion, pageSize: '50' };
    if (modLoaderType !== null) query['modLoaderType'] = String(modLoaderType);
    return (await this.get(apiKey, `/v1/mods/${modId}/files`, query, z.object({ data: z.array(FileSchema) }))).data;
  }

  async file(apiKey: string, modId: number, fileId: number): Promise<CfFile> {
    return (await this.get(apiKey, `/v1/mods/${modId}/files/${fileId}`, {}, z.object({ data: FileSchema }))).data;
  }
}
