import { createHash } from 'node:crypto';
import { ModrinthClient } from '../src/modrinth/client.js';
import type {
  ModrinthApi,
  ModrinthDependency,
  Project,
  Version,
  VersionType,
} from '../src/modrinth/types.js';

export interface FakeVersionInput {
  id: string;
  projectId: string;
  number: string;
  type?: VersionType;
  date: string;
  gameVersions?: string[];
  loaders?: string[];
  deps?: Array<Partial<ModrinthDependency> & { dependency_type: string }>;
  fileName?: string;
  content?: string;
  fileType?: string | null;
}

export const sha512Of = (content: string | Buffer): string => createHash('sha512').update(content).digest('hex');

export class FakeModrinth {
  readonly projects = new Map<string, Project>();
  readonly versions: Version[] = [];
  readonly blobs = new Map<string, Buffer>();
  readonly requests: URL[] = [];
  readonly failUrls = new Set<string>();
  readonly redirects = new Map<string, string>();
  down = false;
  status500 = false;

  addProject(id: string, title: string, serverSide = 'required'): void {
    this.projects.set(id, {
      id,
      slug: id,
      title,
      project_type: 'mod',
      client_side: 'optional',
      server_side: serverSide,
    });
  }

  addVersion(input: FakeVersionInput): Version {
    const fileName = input.fileName ?? `${input.projectId}-${input.number}.jar`;
    const content = input.content ?? `jar:${input.projectId}:${input.number}`;
    const url = `https://cdn.modrinth.com/data/${input.projectId}/versions/${input.id}/${encodeURIComponent(fileName)}`;
    const buffer = Buffer.from(content);
    this.blobs.set(url, buffer);
    const version: Version = {
      id: input.id,
      project_id: input.projectId,
      name: `${input.projectId} ${input.number}`,
      version_number: input.number,
      date_published: input.date,
      version_type: input.type ?? 'release',
      game_versions: input.gameVersions ?? ['1.21.1'],
      loaders: input.loaders ?? ['fabric'],
      files: [
        {
          hashes: { sha512: sha512Of(buffer), sha1: 'unused' },
          url,
          filename: fileName,
          primary: true,
          size: buffer.length,
          file_type: input.fileType ?? null,
        },
      ],
      dependencies: (input.deps ?? []).map((dep) => ({
        version_id: dep.version_id ?? null,
        project_id: dep.project_id ?? null,
        file_name: dep.file_name ?? null,
        dependency_type: dep.dependency_type,
      })),
    };
    this.versions.push(version);
    return version;
  }

  urlOf(versionId: string): string {
    const version = this.versions.find((v) => v.id === versionId);
    if (version === undefined || version.files[0] === undefined) throw new Error(`unknown version ${versionId}`);
    return version.files[0].url;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : (input as Request).url);
    this.requests.push(url);
    if (this.down) throw new TypeError('fetch failed');
    if (url.hostname !== 'api.modrinth.com') return this.cdn(url);
    if (this.status500) return new Response('boom', { status: 500 });
    const route = url.pathname.replace(/^\/v2/, '');
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return this.handleApi(route, url, body);
  };

  private cdn(url: URL): Response {
    const redirect = this.redirects.get(url.href);
    if (redirect !== undefined) return new Response(null, { status: 302, headers: { location: redirect } });
    if (this.failUrls.has(url.href)) return new Response('nope', { status: 500 });
    const blob = this.blobs.get(url.href);
    return blob === undefined ? new Response('missing', { status: 404 }) : new Response(blob);
  }

  private json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  }

  private forProject(projectId: string, loaders: string[] | null, games: string[] | null): Version[] {
    return this.versions
      .filter((v) => v.project_id === projectId)
      .filter((v) => loaders === null || v.loaders.some((l) => loaders.includes(l)))
      .filter((v) => games === null || v.game_versions.some((g) => games.includes(g)))
      .sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published));
  }

  private handleApi(route: string, url: URL, body: unknown): Response {
    const parseList = (name: string): string[] | null => {
      const raw = url.searchParams.get(name);
      return raw === null ? null : (JSON.parse(raw) as string[]);
    };
    let match = /^\/project\/([^/]+)\/version$/.exec(route);
    if (match?.[1] !== undefined) {
      const id = decodeURIComponent(match[1]);
      return this.projects.has(id)
        ? this.json(this.forProject(id, parseList('loaders'), parseList('game_versions')))
        : this.json({ error: 'not_found' }, 404);
    }
    match = /^\/project\/([^/]+)$/.exec(route);
    if (match?.[1] !== undefined) {
      const project = this.projects.get(decodeURIComponent(match[1]));
      return project === undefined ? this.json({ error: 'not_found' }, 404) : this.json(project);
    }
    match = /^\/version\/([^/]+)$/.exec(route);
    if (match?.[1] !== undefined) {
      const version = this.versions.find((v) => v.id === decodeURIComponent(match?.[1] ?? ''));
      return version === undefined ? this.json({ error: 'not_found' }, 404) : this.json(version);
    }
    if (route === '/projects') {
      const ids = parseList('ids') ?? [];
      return this.json(ids.flatMap((id) => this.projects.get(id) ?? []));
    }
    if (route === '/versions') {
      const ids = parseList('ids') ?? [];
      return this.json(this.versions.filter((v) => ids.includes(v.id)));
    }
    if (route === '/search') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const hits = [...this.projects.values()]
        .filter((p) => p.title.toLowerCase().includes(query))
        .map((p) => ({
          project_id: p.id,
          slug: p.slug,
          title: p.title,
          description: `${p.title} description`,
          author: 'tester',
          categories: ['fabric'],
          downloads: 10,
          follows: 1,
          icon_url: null,
          latest_version: null,
          server_side: p.server_side,
          client_side: p.client_side,
        }));
      return this.json({ hits, offset: 0, limit: hits.length, total_hits: hits.length });
    }
    if (route === '/tag/category') {
      return this.json([{ name: 'optimization', project_type: 'mod', header: 'categories', icon: '' }]);
    }
    if (route === '/version_files' || route === '/version_files/update') {
      const request = body as { hashes: string[]; loaders?: string[]; game_versions?: string[] };
      const out: Record<string, Version> = {};
      for (const hash of request.hashes) {
        const current = this.versions.find((v) => v.files.some((f) => f.hashes.sha512 === hash));
        if (current === undefined) continue;
        if (route === '/version_files') out[hash] = current;
        else {
          const latest = this.forProject(current.project_id, request.loaders ?? null, request.game_versions ?? null)[0];
          if (latest !== undefined) out[hash] = latest;
        }
      }
      return this.json(out);
    }
    return this.json({ error: 'not_found' }, 404);
  }

  api(): ModrinthApi {
    return new ModrinthClient({ userAgent: 'WorldFoundry/test', fetch: this.fetch, sleep: async () => undefined });
  }

  searchRequests(): URL[] {
    return this.requests.filter((u) => u.pathname === '/v2/search');
  }
}
