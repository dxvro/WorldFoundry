import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const locked = vi.hoisted(() => ({ rename: new Set<string>(), rm: new Set<string>() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const isLocked = (set: Set<string>, target: unknown): boolean =>
    typeof target === 'string' && [...set].some((fragment) => target.includes(fragment));
  const busy = (target: string): Error => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY', path: target });
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (isLocked(locked.rename, from)) throw busy(from);
      return actual.rename(from, to);
    },
    rm: async (target: string, options?: Parameters<typeof actual.rm>[1]) => {
      if (isLocked(locked.rm, target)) throw busy(target);
      return actual.rm(target, options);
    },
  };
});

import { ModService } from '../src/mods/service.js';
import { lockedFileError } from '../src/mods/fs-errors.js';
import { modUpdateLog, mods, type Mod } from '../src/db/schema.js';
import { noRunningServers } from '../src/mods/runtime-guard.js';
import { ModEnv } from './mod-env.js';

interface ErrorBody {
  error: { code: string; message: string };
}

let env: ModEnv;
beforeEach(async () => {
  env = await ModEnv.create();
  await env.addServer('s1');
  env.fake.addProject('A', 'Alpha');
});
afterEach(async () => {
  locked.rename.clear();
  locked.rm.clear();
  await env.close();
});

describe('locked files', () => {
  it('maps EBUSY/EPERM/EACCES to FILE_LOCKED and leaves other errors alone', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const mapped = lockedFileError(Object.assign(new Error(code), { code, path: 'C:\\x\\mods\\foo.jar' }));
      expect(mapped).toMatchObject({ statusCode: 409, code: 'FILE_LOCKED' });
      expect(mapped?.message).toContain('foo.jar');
      expect(mapped?.message).toContain('another program');
    }
    expect(lockedFileError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeNull();
  });

  it('logs failed with a readable message, keeps the old jar and logs the cause', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    expect((await env.call('POST', '/api/servers/s1/mods', { projectId: 'A' })).status).toBe(201);
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z' });

    const logged: Array<{ object: Record<string, unknown>; message: string }> = [];
    const service = new ModService({
      db: env.t.db,
      modrinth: env.fake.api(),
      guard: noRunningServers,
      serversDir: env.serversDir,
      downloader: { fetch: env.fake.fetch, allowedHosts: ['cdn.modrinth.com'], timeoutMs: 5000 },
      logger: { error: (object, message) => void logged.push({ object, message }) },
    });

    locked.rename.add('A-1.jar');
    const { results } = await service.applyUpdates('s1');
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toContain('A-1.jar');
    expect(results[0]?.error).toContain('another program');
    expect(await env.files('s1')).toEqual(['A-1.jar']);
    expect(await env.files('s1', '.tmp')).toEqual([]);
    expect((await env.t.db.select().from(modUpdateLog))[0]).toMatchObject({ status: 'failed' });
    expect(logged).toHaveLength(1);
    expect(String((logged[0]?.object['err'] as Error).message)).toContain('EBUSY');
  });

  it('returns 409 FILE_LOCKED when the file to delete is in use', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await env.call('POST', '/api/servers/s1/mods', { projectId: 'A' });
    const mod = (await env.t.db.select().from(mods))[0] as Mod;
    locked.rm.add('A-1.jar');
    const res = await env.call<ErrorBody>('DELETE', `/api/servers/s1/mods/${mod.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FILE_LOCKED');
    expect(await env.t.db.select().from(mods)).toHaveLength(1);
  });

  it('returns 409 FILE_LOCKED when a mod cannot be switched off or on, and changes nothing', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await env.call('POST', '/api/servers/s1/mods', { projectId: 'A' });
    const mod = (await env.t.db.select().from(mods))[0] as Mod;
    locked.rename.add('A-1.jar');
    const off = await env.call<ErrorBody>('PATCH', `/api/servers/s1/mods/${mod.id}`, { enabled: false });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('FILE_LOCKED');
    expect(await env.files('s1')).toEqual(['A-1.jar']);
    expect((await env.t.db.select().from(mods))[0]?.enabled).toBe(true);

    locked.rename.clear();
    expect((await env.call('PATCH', `/api/servers/s1/mods/${mod.id}`, { enabled: false })).status).toBe(200);
    locked.rename.add('A-1.jar.disabled');
    const on = await env.call<ErrorBody>('PATCH', `/api/servers/s1/mods/${mod.id}`, { enabled: true });
    expect(on.body.error.code).toBe('FILE_LOCKED');
    expect(await env.files('s1')).toEqual(['A-1.jar.disabled']);
    expect((await env.t.db.select().from(mods))[0]?.enabled).toBe(false);
  });

  it('returns 409 FILE_LOCKED and no leftovers when moving a download into place fails', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    locked.rename.add('.part');
    const res = await env.call<ErrorBody>('POST', '/api/servers/s1/mods', { projectId: 'A' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FILE_LOCKED');
    expect(await env.files('s1')).toEqual([]);
    expect(await env.files('s1', '.tmp')).toEqual([]);
    expect(await env.t.db.select().from(mods)).toHaveLength(0);
  });
});
