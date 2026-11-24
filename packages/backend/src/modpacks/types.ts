// Types of the modpack API. Free of Node imports: the frontend reads them through contract.ts.

// What a server remembers about the pack it was created from (servers.modpack, as JSON)
export interface ModpackRef {
  projectId: string;
  versionId: string;
  title: string;
  versionNumber: string;
  iconUrl: string | null;
}

export interface ModpackHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
  categories: string[];
}

export interface ModpackSearchResponse {
  hits: ModpackHit[];
  totalHits: number;
}

export interface ModpackVersionDto {
  id: string;
  name: string;
  versionNumber: string;
  versionType: string;
  datePublished: string;
  gameVersions: string[];
  loaders: string[];
  // false when WorldFoundry cannot run the loader of this version (Quilt)
  supported: boolean;
}
