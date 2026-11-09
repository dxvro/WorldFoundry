import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { CurseForgeClient, type CfFile, type CfMod, type CurseForgeApi } from '../src/curseforge/client.js';
import { servers } from '../src/db/schema.js';
import { AppError } from '../src/http/errors.js';
import { pickFile } from '../src/mods/curseforge.js';
import { FakeModrinth } from './fake-modrinth.js';
import { createTestDb, serverRow, testConfig, type TestDb } from './helpers.js';

const KEY = 'test-key-0123456789';
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

const mod = (id: number, name: string, extra: Partial<CfMod> = {}): CfMod => ({
  id,
  name,
  slug: name.toLowerCase(),
  summary: `${name} summary`,
  downloadCount: 100,
  classId: 6,
  allowModDistribution: true,
  links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${name.toLowerCase()}` },
  logo: null,
  authors: [{ name: 'Author' }],
  ...extra,
});

const file = (id: number, modId: number, content: string, extra: Partial<CfFile> = {}): CfFile => ({
  id,
  modId,
  displayName: `${modId}-${id}`,
  fileName: `mod-${modId}-${id}.jar`,
  releaseType: 1,
  fileDate: '2026-10-01T00:00:00Z',
  fileLength: Buffer.byteLength(content),
  downloadUrl: `https://edge.forgecdn.net/files/${id}/mod-${modId}-${id}.jar`,
  hashes: [{ value: sha1(content), algo: 1 }],
  gameVersions: ['1.21.1', 'Fabric'],
  dependencies: [],
  ...extra,
});

class FakeCurseForge implements CurseForgeApi {
  mods = new Map<number, CfMod>();
  filesOf = new Map<number, CfFile[]>();
  contents = new Map<string, string>();
  keys: string[] = [];
  searches: unknown[] = [];

  add(m: CfMod, files: Array<{ file: CfFile; content: string }>): void {
    this.mods.set(m.id, m);
    this.filesOf.set(m.id, files.map((entry) => entry.file));
    for (const entry of files) if (entry.file.downloadUrl !== null) this.contents.set(entry.file.downloadUrl, entry.content);
  }
  private check(key: string): void {
    this.keys.push(key);
    if (key !== KEY) throw new AppError(422, 'CURSEFORGE_KEY_INVALID', 'refused');
  }
  async checkKey(key: string): Promise<void> {
    this.check(key);
  }
  async search(key: string, params: unknown): Promise<{ mods: CfMod[]; total: number }> {
    this.check(key);
    this.searches.push(params);
    return { mods: [...this.mods.values()], total: this.mods.size };
  }
  async mod(key: string, id: number): Promise<CfMod> {
    this.check(key);
    const found = this.mods.get(id);
    if (found === undefined) throw new AppError(404, 'CURSEFORGE_NOT_FOUND', 'missing');
    return found;
  }
  async files(key: string, id: number): Promise<CfFile[]> {
    this.check(key);
    return this.filesOf.get(id) ?? [];
  }
  async file(key: string, id: number, fileId: number): Promise<CfFile> {
    this.check(key);
    const found = (this.filesOf.get(id) ?? []).find((entry) => entry.id === fileId);
    if (found === undefined) throw new AppError(404, 'CURSEFORGE_NOT_FOUND', 'missing');
    return found;
  }
  fetch = (async (input: string | URL | Request): Promise<Response> => {
    const content = this.contents.get(String(input));
    return content === undefined ? new Response('missing', { status: 404 }) : new Response(content, { status: 200 });
  }) as typeof fetch;
}

let t: TestDb;
let app: FastifyInstance;
let cf: FakeCurseForge;
beforeEach(async () => {
  t = await createTestDb();
  cf = new FakeCurseForge();
  app = buildApp({
    db: t.db,
    config: testConfig(t.dir),
    modrinth: new FakeModrinth().api(),
    curseforgeApi: cf,
    runtimeGuard: { isRunning: () => false },
    javaStandardRoots: [],
    downloader: { fetch: cf.fetch, allowedHosts: ['cdn.modrinth.com'], timeoutMs: 5000 },
  });
  await t.db.insert(servers).values(serverRow('s1', { loader: 'fabric', mcVersion: '1.21.1' }));
});
afterEach(async () => {
  await app.close();
  await t.cleanup();
});

const call = async <T = Record<string, unknown>>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, body: res.json<T>(), raw: res.body };
};

describe('the CurseForge API key', () => {
  it('is checked with CurseForge before it is saved, and is never sent back', async () => {
    expect((await call('GET', '/api/system/curseforge')).body).toEqual({ configured: false });
    expect((await call('PUT', '/api/system/curseforge', { apiKey: 'wrong-key-0123456789' })).body).toMatchObject({ error: { code: 'CURSEFORGE_KEY_INVALID' } });
    expect((await call('GET', '/api/system/curseforge')).body).toEqual({ configured: false });
    expect((await call('PUT', '/api/system/curseforge', { apiKey: 'short' })).status).toBe(422);

    const saved = await call('PUT', '/api/system/curseforge', { apiKey: `  ${KEY}  ` });
    expect(saved.status).toBe(200);
    expect(saved.raw).not.toContain(KEY);
    const status = await call('GET', '/api/system/curseforge');
    expect(status.body).toEqual({ configured: true });
    expect(status.raw).not.toContain(KEY);

    expect((await call('DELETE', '/api/system/curseforge')).body).toEqual({ configured: false });
  });

  it('is needed for searching', async () => {
    expect((await call('GET', '/api/servers/s1/curseforge/search?query=x')).body).toMatchObject({ error: { code: 'CURSEFORGE_NOT_CONFIGURED' } });
  });
});

describe('CurseForge for a server', () => {
  beforeEach(async () => {
    await call('PUT', '/api/system/curseforge', { apiKey: KEY });
  });

  it('searches mods for the version and loader of the server, and marks what cannot be downloaded', async () => {
    cf.add(mod(10, 'Alpha'), []);
    cf.add(mod(11, 'Locked', { allowModDistribution: false }), []);
    const res = await call<{ hits: Array<{ id: number; downloadable: boolean; installed: boolean }> }>('GET', '/api/servers/s1/curseforge/search?query=al');
    expect(res.status).toBe(200);
    expect(cf.searches[0]).toMatchObject({ classId: 6, query: 'al', gameVersion: '1.21.1', modLoaderType: 4, index: 0 });
    expect(res.body.hits.map((hit) => [hit.id, hit.downloadable, hit.installed])).toEqual([
      [10, true, false],
      [11, false, false],
    ]);
  });

  it('searches Bukkit plugins for a Paper server', async () => {
    await t.db.insert(servers).values(serverRow('p1', { loader: 'paper', mcVersion: '1.21.1' }));
    await call('GET', '/api/servers/p1/curseforge/search');
    expect(cf.searches[0]).toMatchObject({ classId: 5, modLoaderType: null });
  });

  it('installs the newest fitting file with its required dependencies, checks the checksum and records the source', async () => {
    cf.add(mod(10, 'Alpha'), [
      { file: file(101, 10, 'old', { fileDate: '2026-01-01T00:00:00Z' }), content: 'old' },
      { file: file(102, 10, 'alpha-new', { dependencies: [{ modId: 20, relationType: 3 }, { modId: 30, relationType: 2 }] }), content: 'alpha-new' },
      { file: file(103, 10, 'beta', { releaseType: 2, fileDate: '2026-12-01T00:00:00Z' }), content: 'beta' },
      { file: file(104, 10, 'other', { gameVersions: ['1.20.1'] }), content: 'other' },
    ]);
    cf.add(mod(20, 'Library'), [{ file: file(201, 20, 'lib'), content: 'lib' }]);
    cf.add(mod(30, 'Optional'), [{ file: file(301, 30, 'opt'), content: 'opt' }]);

    const res = await call<{ installed: Array<{ name: string; source: string; projectId: string; versionId: string; isDependency: boolean }> }>(
      'POST',
      '/api/servers/s1/curseforge/install',
      { modId: 10 },
    );
    expect(res.status).toBe(201);
    expect(res.body.installed.map((row) => [row.name, row.source, row.projectId, row.versionId, row.isDependency])).toEqual([
      ['Alpha', 'curseforge', 'cf:10', '102', false],
      ['Library', 'curseforge', 'cf:20', '201', true],
    ]);
    const dir = path.join(t.dir, 'servers', 's1', 'mods');
    expect(await readFile(path.join(dir, 'mod-10-102.jar'), 'utf8')).toBe('alpha-new');
    expect(await readFile(path.join(dir, 'mod-20-201.jar'), 'utf8')).toBe('lib');

    const listed = await call<{ mods: Array<{ name: string }> }>('GET', '/api/servers/s1/mods');
    expect(listed.body.mods.map((row) => row.name)).toEqual(['Alpha', 'Library']);
    // removing the dependency is refused while Alpha needs it: the link was recorded
    const library = (await call<{ mods: Array<{ id: string; name: string }> }>('GET', '/api/servers/s1/mods')).body.mods.find((row) => row.name === 'Library');
    expect((await call('DELETE', `/api/servers/s1/mods/${library?.id}`)).body).toMatchObject({ error: { code: 'MOD_REQUIRED_BY_OTHERS' } });

    expect((await call('POST', '/api/servers/s1/curseforge/install', { modId: 10 })).body).toMatchObject({ error: { code: 'MOD_ALREADY_INSTALLED' } });
    const search = await call<{ hits: Array<{ id: number; installed: boolean }> }>('GET', '/api/servers/s1/curseforge/search');
    expect(search.body.hits.find((hit) => hit.id === 10)?.installed).toBe(true);
  });

  it('refuses a project whose author allows downloads only on CurseForge, and links to it', async () => {
    cf.add(mod(40, 'Locked', { allowModDistribution: false }), [{ file: file(401, 40, 'x', { downloadUrl: null }), content: 'x' }]);
    const res = await call('POST', '/api/servers/s1/curseforge/install', { modId: 40 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'CURSEFORGE_DOWNLOAD_BLOCKED', params: { name: 'Locked', url: 'https://www.curseforge.com/minecraft/mc-mods/locked' } } });
  });

  it('installs nothing when a dependency is blocked or the checksum is wrong', async () => {
    cf.add(mod(10, 'Alpha'), [{ file: file(102, 10, 'a', { dependencies: [{ modId: 40, relationType: 3 }] }), content: 'a' }]);
    cf.add(mod(40, 'Locked', { allowModDistribution: false }), [{ file: file(401, 40, 'x', { downloadUrl: null }), content: 'x' }]);
    expect((await call('POST', '/api/servers/s1/curseforge/install', { modId: 10 })).body).toMatchObject({ error: { code: 'CURSEFORGE_DOWNLOAD_BLOCKED' } });

    cf.add(mod(50, 'Broken'), [{ file: file(501, 50, 'expected'), content: 'tampered' }]);
    expect((await call('POST', '/api/servers/s1/curseforge/install', { modId: 50 })).body).toMatchObject({ error: { code: 'DOWNLOAD_HASH_MISMATCH' } });
    expect((await call<{ mods: unknown[] }>('GET', '/api/servers/s1/mods')).body.mods).toEqual([]);
  });

  it('says so when no file fits the server', async () => {
    cf.add(mod(60, 'Old'), [{ file: file(601, 60, 'o', { gameVersions: ['1.12.2'] }), content: 'o' }]);
    expect((await call('POST', '/api/servers/s1/curseforge/install', { modId: 60 })).body).toMatchObject({ error: { code: 'NO_COMPATIBLE_VERSION' } });
  });
});

describe('CurseForge client', () => {
  it('sends the key as x-api-key, maps a refused key and keeps the key out of the URL', async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const client = new CurseForgeClient({
      userAgent: 'WorldFoundry/test',
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), key: new Headers(init?.headers).get('x-api-key') });
        return new Response('{}', { status: 403 });
      }) as typeof fetch,
    });
    await expect(client.checkKey('secret-key-1234')).rejects.toMatchObject({ code: 'CURSEFORGE_KEY_INVALID' });
    expect(seen).toEqual([{ url: 'https://api.curseforge.com/v1/games/432', key: 'secret-key-1234' }]);
  });

  it('picks releases first, then the newest date, and only files for the version', () => {
    const files = [file(1, 1, 'a', { releaseType: 2, fileDate: '2026-12-01T00:00:00Z' }), file(2, 1, 'b', { fileDate: '2026-01-01T00:00:00Z' }), file(3, 1, 'c', { fileDate: '2026-06-01T00:00:00Z' }), file(4, 1, 'd', { gameVersions: ['1.20.1'] })];
    expect(pickFile(files, '1.21.1')?.id).toBe(3);
    expect(pickFile(files, '1.19')).toBeNull();
  });
});
