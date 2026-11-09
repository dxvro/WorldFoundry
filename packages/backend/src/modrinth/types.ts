import { z } from 'zod';

export const VERSION_TYPES = ['release', 'beta', 'alpha'] as const;
export type VersionType = (typeof VERSION_TYPES)[number];

export const VersionFileSchema = z.object({
  hashes: z.object({ sha512: z.string().optional(), sha1: z.string().optional() }),
  url: z.string(),
  filename: z.string(),
  primary: z.boolean(),
  size: z.number().int().nonnegative(),
  file_type: z.string().nullish(),
});
export type VersionFile = z.infer<typeof VersionFileSchema>;

export const DependencySchema = z.object({
  version_id: z.string().nullish(),
  project_id: z.string().nullish(),
  file_name: z.string().nullish(),
  dependency_type: z.string(),
});
export type ModrinthDependency = z.infer<typeof DependencySchema>;

export const VersionSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  version_number: z.string(),
  date_published: z.string(),
  version_type: z.enum(VERSION_TYPES),
  game_versions: z.array(z.string()),
  loaders: z.array(z.string()),
  files: z.array(VersionFileSchema),
  dependencies: z.array(DependencySchema),
});
export type Version = z.infer<typeof VersionSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  project_type: z.string(),
  client_side: z.string().nullish(),
  server_side: z.string().nullish(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const SearchHitSchema = z.object({
  project_id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  author: z.string(),
  categories: z.array(z.string()),
  downloads: z.number(),
  follows: z.number(),
  icon_url: z.string().nullish(),
  latest_version: z.string().nullish(),
  server_side: z.string().nullish(),
  client_side: z.string().nullish(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResultSchema = z.object({
  hits: z.array(SearchHitSchema),
  offset: z.number(),
  limit: z.number(),
  total_hits: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const CategorySchema = z.object({
  name: z.string(),
  project_type: z.string(),
  header: z.string(),
});
export type Category = z.infer<typeof CategorySchema>;

export const SEARCH_INDEXES = ['relevance', 'downloads', 'follows', 'newest', 'updated'] as const;
export type SearchIndex = (typeof SEARCH_INDEXES)[number];

export interface SearchParams {
  query: string;
  facets: string[][];
  index: SearchIndex;
  limit: number;
  offset: number;
}

export interface ModrinthApi {
  search(params: SearchParams): Promise<SearchResult>;
  getProject(idOrSlug: string): Promise<Project>;
  getProjects(ids: readonly string[]): Promise<Project[]>;
  listProjectVersions(
    projectId: string,
    loaders: readonly string[],
    gameVersions: readonly string[],
  ): Promise<Version[]>;
  getVersion(id: string): Promise<Version>;
  getVersions(ids: readonly string[]): Promise<Version[]>;
  versionFilesByHash(sha512Hashes: readonly string[]): Promise<Record<string, Version>>;
  versionFilesUpdate(
    sha512Hashes: readonly string[],
    loaders: readonly string[],
    gameVersions: readonly string[],
  ): Promise<Record<string, Version>>;
  categories(): Promise<Category[]>;
}
