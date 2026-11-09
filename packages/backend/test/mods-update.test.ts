import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modUpdateLog, mods, type Mod, type ModUpdateLogEntry } from '../src/db/schema.js';
import type { ScanReport } from '../src/mods/scanner.js';
import type { UpdateCandidate, UpdateResult } from '../src/mods/updater.js';
import { ModEnv } from './mod-env.js';

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

const dep = (project: string, type = 'required') => ({ project_id: project, dependency_type: type });
const install = (projectId: string, versionId?: string) =>
  env.call<{ installed: Mod[] }>('POST', '/api/servers/s1/mods', { projectId, ...(versionId ? { versionId } : {}) });
const check = () => env.call<{ updates: UpdateCandidate[] }>('POST', '/api/servers/s1/mods/updates/check');
const apply = (projectIds?: string[]) =>
  env.call<{ results: UpdateResult[] }>('POST', '/api/servers/s1/mods/updates/apply', projectIds ? { projectIds } : {});
const log = () => env.t.db.select().from(modUpdateLog);

describe('update check', () => {
  it('offers a newer version and nothing when up to date', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    expect((await check()).body.updates).toEqual([]);
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z' });
    const res = await check();
    expect(res.body.updates).toHaveLength(1);
    expect(res.body.updates[0]).toMatchObject({ projectId: 'A', currentVersionId: 'a1', newVersionId: 'a2' });
  });

  it('never moves a release to a newer beta and falls back to a release', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    env.fake.addVersion({ id: 'a2b', projectId: 'A', number: '2-beta', type: 'beta', date: '2024-03-01T00:00:00Z' });
    expect((await check()).body.updates).toEqual([]);
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z' });
    expect((await check()).body.updates[0]?.newVersionId).toBe('a2');
  });

  it('allows a beta to move to a newer beta and ignores older versions', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1-beta', type: 'beta', date: '2024-02-01T00:00:00Z' });
    await install('A');
    env.fake.addVersion({ id: 'a0', projectId: 'A', number: '0.5', date: '2024-01-01T00:00:00Z' });
    expect((await check()).body.updates[0]?.newVersionId).toBeUndefined();
    env.fake.addVersion({ id: 'a2b', projectId: 'A', number: '2-beta', type: 'beta', date: '2024-03-01T00:00:00Z' });
    expect((await check()).body.updates[0]?.newVersionId).toBe('a2b');
  });
});

describe('update apply', () => {
  it('replaces the jar, keeps a backup, updates the row and logs success', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z' });
    const res = await apply();
    expect(res.body.results).toMatchObject([{ status: 'success' }]);
    expect(await env.files('s1')).toEqual(['A-2.jar']);
    expect(await env.files('s1', 'mods_backup')).toEqual(['A-1.jar']);
    const [row] = await env.t.db.select().from(mods);
    expect(row).toMatchObject({ versionId: 'a2', fileName: 'A-2.jar' });
    const [entry] = await log();
    expect(entry).toMatchObject({
      status: 'success',
      fromVersionId: 'a1',
      toVersionId: 'a2',
      fromFileName: 'A-1.jar',
      toFileName: 'A-2.jar',
      backupPath: 'mods_backup/A-1.jar',
    });

    const next = await env.call<ScanReport>('POST', '/api/servers/s1/mods/scan');
    expect(next.body).toMatchObject({ added: 0, replaced: 0, removed: 0, renamed: 0 });
    expect(await env.t.db.select().from(mods)).toHaveLength(1);
  });

  it('uses a timestamp suffix when the backup name collides', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', fileName: 'same.jar', content: 'one' });
    await install('A');
    await env.writeJar('s1', 'same.jar', 'one', 'mods_backup');
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z', fileName: 'same2.jar', content: 'two' });
    await apply();
    const backups = await env.files('s1', 'mods_backup');
    expect(backups).toHaveLength(2);
    expect(backups.some((name) => /^same-\d+\.jar$/.test(name))).toBe(true);
  });

  it('keeps is_dependency and updates only selected projects', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'b1', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'b2', projectId: 'B', number: '2', date: '2024-02-01T00:00:00Z' });
    const res = await apply(['B']);
    expect(res.body.results).toHaveLength(1);
    const all = await env.t.db.select().from(mods);
    expect(all.find((m) => m.projectId === 'B')).toMatchObject({ versionId: 'b2', isDependency: true });
    expect(all.find((m) => m.projectId === 'A')).toMatchObject({ versionId: 'a1', isDependency: false });
  });

  it('brings in a new required dependency of the new version', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'b1', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    const res = await apply();
    expect(res.body.results[0]?.status).toBe('success');
    expect(await env.files('s1')).toEqual(['A-2.jar', 'B-1.jar']);
    const all = await env.t.db.select().from(mods);
    expect(all.find((m) => m.projectId === 'B')?.isDependency).toBe(true);
  });

  it('logs failed and changes nothing when the download fails', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z' });
    env.fake.failUrls.add(env.fake.urlOf('a2'));
    const res = await apply();
    expect(res.body.results[0]?.status).toBe('failed');
    expect(await env.files('s1')).toEqual(['A-1.jar']);
    expect(await env.files('s1', 'mods_backup')).toEqual([]);
    expect(await env.files('s1', '.tmp')).toEqual([]);
    expect((await env.t.db.select().from(mods))[0]?.versionId).toBe('a1');
    expect((await log())[0]).toMatchObject({ status: 'failed', modName: 'Alpha' });
  });

  it('moves the old jar back and logs rolled_back when the commit fails', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', content: 'a-one' });
    env.fake.addVersion({ id: 'b1', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z', content: 'collide' });
    await install('A');
    await install('B');
    // the new A has the same bytes as B, so the unique sha512 constraint fails after the files moved
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z', content: 'collide' });
    const res = await apply(['A']);
    expect(res.body.results[0]?.status).toBe('rolled_back');
    expect(await env.files('s1')).toEqual(['A-1.jar', 'B-1.jar']);
    expect(await env.files('s1', 'mods_backup')).toEqual([]);
    const a = (await env.t.db.select().from(mods).where(eq(mods.projectId, 'A')))[0];
    expect(a?.versionId).toBe('a1');
    expect((await log())[0]).toMatchObject({ status: 'rolled_back' });
  });

  it('handles each mod independently', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    env.fake.addVersion({ id: 'b1', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    await install('B');
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z' });
    env.fake.addVersion({ id: 'b2', projectId: 'B', number: '2', date: '2024-02-01T00:00:00Z' });
    env.fake.failUrls.add(env.fake.urlOf('a2'));
    const res = await apply();
    expect(res.body.results.map((r) => r.status).sort()).toEqual(['failed', 'success']);
    expect((await log())).toHaveLength(2);
  });

  it('exposes the update log through the API', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z' });
    await apply();
    const res = await env.call<{ entries: ModUpdateLogEntry[] }>('GET', '/api/servers/s1/mods/update-log?limit=5');
    expect(res.body.entries).toHaveLength(1);
  });
});
