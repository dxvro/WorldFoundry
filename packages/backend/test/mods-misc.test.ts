import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { servers, mods, type Mod } from '../src/db/schema.js';
import { KeyedLock } from '../src/lib/keyed-lock.js';
import type { ScanReport } from '../src/mods/scanner.js';
import { ModEnv } from './mod-env.js';

interface ErrorBody {
  error: { code: string };
}

let env: ModEnv;
beforeEach(async () => {
  env = await ModEnv.create();
  await env.addServer('s1');
  env.fake.addProject('A', 'Alpha');
  env.fake.addProject('B', 'Beta');
});
afterEach(async () => {
  await env.close();
});

const scan = () => env.call<ScanReport>('POST', '/api/servers/s1/mods/scan');
const rows = () => env.t.db.select().from(mods);

describe('scanner', () => {
  it('registers unknown files as manual and identifies them through Modrinth', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1.0', date: '2024-01-01T00:00:00Z', content: 'alpha-bytes' });
    await env.writeJar('s1', 'renamed-by-user.jar', 'alpha-bytes');
    await env.writeJar('s1', 'mystery.jar', 'unknown-bytes');
    const res = await scan();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scanned: 2, added: 2, identified: 1, modrinthAvailable: true });
    const all = await rows();
    expect(all.find((m) => m.fileName === 'renamed-by-user.jar')).toMatchObject({
      source: 'manual',
      projectId: 'A',
      versionId: 'a1',
      versionNumber: '1.0',
      name: 'Alpha',
    });
    expect(all.find((m) => m.fileName === 'mystery.jar')).toMatchObject({ projectId: null, name: 'mystery' });
  });

  it('handles rename, replaced content and removed files', async () => {
    await env.writeJar('s1', 'one.jar', '1');
    await env.writeJar('s1', 'two.jar', '2');
    await env.writeJar('s1', 'three.jar', '3');
    await scan();
    const before = await rows();
    const idOf = (name: string): string => before.find((m) => m.fileName === name)?.id ?? '';

    await rename(path.join(env.serverDir('s1'), 'mods', 'one.jar'), path.join(env.serverDir('s1'), 'mods', 'uno.jar'));
    await writeFile(path.join(env.serverDir('s1'), 'mods', 'two.jar'), 'changed');
    await rm(path.join(env.serverDir('s1'), 'mods', 'three.jar'));

    const res = await scan();
    expect(res.body).toMatchObject({ renamed: 1, replaced: 1, removed: 1, added: 0 });
    const after = await rows();
    expect(after).toHaveLength(2);
    expect(after.find((m) => m.id === idOf('one.jar'))?.fileName).toBe('uno.jar');
    const two = after.find((m) => m.id === idOf('two.jar'));
    expect(two?.sha512).not.toBe(before.find((m) => m.fileName === 'two.jar')?.sha512);
  });

  it('clears stale identity when a known file name gets new content', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await env.call('POST', '/api/servers/s1/mods', { projectId: 'A' });
    await writeFile(path.join(env.serverDir('s1'), 'mods', 'A-1.jar'), 'hand-edited');
    const res = await scan();
    expect(res.body.replaced).toBe(1);
    expect((await rows())[0]).toMatchObject({ projectId: null, versionId: null, source: 'manual', name: 'A-1' });
  });

  it('re-looks-up unidentified mods on every scan', async () => {
    await env.writeJar('s1', 'late.jar', 'late-bytes');
    expect((await scan()).body.identified).toBe(0);
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', content: 'late-bytes' });
    expect((await scan()).body.identified).toBe(1);
    expect((await rows())[0]?.projectId).toBe('A');
  });

  it('warns about duplicate content and does not crash', async () => {
    await env.writeJar('s1', 'a.jar', 'same');
    await env.writeJar('s1', 'b.jar', 'same');
    const res = await scan();
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.warnings.join(' ')).toContain('identical');
    expect(res.body).toMatchObject({ warningRefs: [{ key: 'MOD_SCAN_IDENTICAL', params: { ignored: expect.any(String), preferred: expect.any(String) } }] });
    expect(await rows()).toHaveLength(1);
  });

  it('warns when two files belong to the same project and keeps the second unidentified', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', content: 'v1' });
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z', content: 'v2' });
    await env.writeJar('s1', 'first.jar', 'v1');
    await env.writeJar('s1', 'second.jar', 'v2');
    const res = await scan();
    expect(res.status).toBe(200);
    expect(res.body.identified).toBe(1);
    expect(res.body.warnings.some((w) => w.includes('second.jar'))).toBe(true);
    const all = await rows();
    expect(all.filter((m) => m.projectId === 'A')).toHaveLength(1);
    expect(all.find((m) => m.fileName === 'second.jar')?.projectId).toBeNull();
  });

  it('succeeds locally and reports modrinthAvailable false when Modrinth is down', async () => {
    env.fake.down = true;
    await env.writeJar('s1', 'x.jar', 'x');
    const res = await scan();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 1, modrinthAvailable: false });
    expect(await rows()).toHaveLength(1);
  });

  it('ignores nested folders and non-jar files', async () => {
    await env.writeJar('s1', 'ok.jar', 'ok');
    await env.writeJar('s1', 'notes.txt', 'text');
    await env.writeJar('s1', 'inner.jar', 'inner', 'mods/sub');
    expect((await scan()).body.scanned).toBe(1);
  });
});

describe('search', () => {
  it('always applies the hard filters and cannot be overridden', async () => {
    const url = '/api/servers/s1/mods/search?query=alp&categories=optimization,forge&facets=%5B%5B%22versions:1.0%22%5D%5D&limit=5';
    const res = await env.call<{ hits: unknown[] }>('GET', url);
    expect(res.status).toBe(200);
    const request = env.fake.searchRequests().at(-1);
    const facets = JSON.parse(request?.searchParams.get('facets') ?? '[]') as string[][];
    expect(facets.slice(0, 4)).toEqual([
      ['project_type:mod'],
      ['versions:1.21.1'],
      ['categories:fabric'],
      ['server_side:required', 'server_side:optional'],
    ]);
    expect(facets.slice(4)).toEqual([['categories:optimization'], ['categories:forge']]);
    expect(request?.searchParams.get('limit')).toBe('5');
  });

  it('rejects categories that try to smuggle other facets', async () => {
    const res = await env.call<ErrorBody>('GET', '/api/servers/s1/mods/search?categories=server_side:unsupported');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(env.fake.searchRequests()).toHaveLength(0);
  });

  it('flags installed projects in the hits', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await env.call('POST', '/api/servers/s1/mods', { projectId: 'A' });
    const res = await env.call<{ hits: Array<{ projectId: string; installed: boolean }> }>('GET', '/api/servers/s1/mods/search');
    expect(res.body.hits.find((h) => h.projectId === 'A')?.installed).toBe(true);
    expect(res.body.hits.find((h) => h.projectId === 'B')?.installed).toBe(false);
  });
});

describe('loader profiles and guards', () => {
  it('uses plugins/ and plugin filters for paper', async () => {
    await env.addServer('p1', { loader: 'paper' });
    env.fake.addVersion({ id: 'pa', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', loaders: ['spigot'] });
    const res = await env.call<{ installed: Mod[] }>('POST', '/api/servers/p1/mods', { projectId: 'A' });
    expect(res.status).toBe(201);
    expect(await env.files('p1', 'plugins')).toEqual(['A-1.jar']);
    expect(await env.files('p1', 'mods')).toEqual([]);

    await env.call('GET', '/api/servers/p1/mods/search');
    const facets = JSON.parse(env.fake.searchRequests().at(-1)?.searchParams.get('facets') ?? '[]') as string[][];
    expect(facets[0]).toEqual(['project_type:plugin']);
    expect(facets[2]).toEqual(['categories:paper', 'categories:spigot', 'categories:bukkit']);

    env.fake.addVersion({ id: 'pa2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z', loaders: ['paper'] });
    await env.call('POST', '/api/servers/p1/mods/updates/apply', {});
    expect(await env.files('p1', 'plugins_backup')).toEqual(['A-1.jar']);
  });

  it('rejects every mod endpoint for vanilla with 409', async () => {
    await env.addServer('v1', { loader: 'vanilla' });
    for (const [method, url] of [
      ['GET', '/api/servers/v1/mods'],
      ['GET', '/api/servers/v1/mods/search'],
      ['POST', '/api/servers/v1/mods/scan'],
      ['POST', '/api/servers/v1/mods/updates/check'],
      ['GET', '/api/servers/v1/mods/update-log'],
    ] as const) {
      const res = await env.call<ErrorBody>(method, url);
      expect(res.status, url).toBe(409);
      expect(res.body.error.code).toBe('MODS_NOT_SUPPORTED');
    }
    const post = await env.call<ErrorBody>('POST', '/api/servers/v1/mods', { projectId: 'A' });
    expect(post.body.error.code).toBe('MODS_NOT_SUPPORTED');
  });

  it('returns SERVER_NOT_FOUND for unknown servers', async () => {
    const res = await env.call<ErrorBody>('GET', '/api/servers/nope/mods');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SERVER_NOT_FOUND');
  });

  it('blocks mutations on a running server but allows scan and check', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await env.call('POST', '/api/servers/s1/mods', { projectId: 'A' });
    const mod = (await rows())[0] as Mod;
    env.running.add('s1');

    for (const [method, url, body] of [
      ['POST', '/api/servers/s1/mods', { projectId: 'B' }],
      ['DELETE', `/api/servers/s1/mods/${mod.id}`, undefined],
      ['POST', '/api/servers/s1/mods/updates/apply', {}],
    ] as const) {
      const res = await env.call<ErrorBody>(method, url, body);
      expect(res.status, url).toBe(409);
      expect(res.body.error.code).toBe('SERVER_RUNNING');
    }
    expect((await scan()).status).toBe(200);
    expect((await env.call('POST', '/api/servers/s1/mods/updates/check')).status).toBe(200);
    expect(await env.files('s1')).toEqual(['A-1.jar']);
  });

  it('serves categories', async () => {
    const res = await env.call<{ categories: Array<{ name: string }> }>('GET', '/api/modrinth/categories');
    expect(res.body.categories[0]?.name).toBe('optimization');
  });
});

describe('concurrency', () => {
  it('serializes tasks per key and runs different keys in parallel', async () => {
    const lock = new KeyedLock();
    const events: string[] = [];
    const task = (key: string, label: string, ms: number) =>
      lock.run(key, async () => {
        events.push(`start ${label}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        events.push(`end ${label}`);
      });
    await Promise.all([task('x', '1', 30), task('x', '2', 5), task('y', '3', 5)]);
    expect(events.indexOf('end 1')).toBeLessThan(events.indexOf('start 2'));
    expect(events.indexOf('start 3')).toBeLessThan(events.indexOf('end 1'));
  });

  it('serializes simultaneous installs on one server', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    const results = await Promise.all([
      env.call<ErrorBody>('POST', '/api/servers/s1/mods', { projectId: 'A' }),
      env.call<ErrorBody>('POST', '/api/servers/s1/mods', { projectId: 'A' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await rows()).toHaveLength(1);
  });

  it('commits installs on two servers against the same database without SQLITE_BUSY', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `srv${i}`);
    for (const id of ids) await env.t.db.insert(servers).values({ id, name: id, loader: 'fabric', mcVersion: '1.21.1', createdAt: new Date(), updatedAt: new Date() });
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [{ project_id: 'B', dependency_type: 'required' }] });
    env.fake.addVersion({ id: 'b1', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(ids.map((id) => env.call('POST', `/api/servers/${id}/mods`, { projectId: 'A' })));
      expect(results.map((r) => r.status)).toEqual(ids.map(() => 201));
      await Promise.all(
        ids.map(async (id) => {
          const mod = (await env.t.db.select().from(mods)).find((m) => m.serverId === id && m.projectId === 'A');
          await env.call('DELETE', `/api/servers/${id}/mods/${mod?.id}?force=true`);
          const dep = (await env.t.db.select().from(mods)).find((m) => m.serverId === id && m.projectId === 'B');
          await env.call('DELETE', `/api/servers/${id}/mods/${dep?.id}?force=true`);
        }),
      );
    }
    expect(await rows()).toHaveLength(0);
  });
});
