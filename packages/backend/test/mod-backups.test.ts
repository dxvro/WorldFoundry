import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModBackupList } from '../src/contract.js';
import { modUpdateLog } from '../src/db/schema.js';
import { pruneModBackups } from '../src/mods/mod-backups.js';
import { requireLoaderProfile } from '../src/mods/profile.js';
import { ModEnv } from './mod-env.js';

let env: ModEnv;
afterEach(async () => {
  await env.close();
});

async function setup(keep: number): Promise<void> {
  env = await ModEnv.create({ modBackupKeep: keep });
  await env.addServer('s1');
  env.fake.addProject('A', 'Alpha');
  env.fake.addProject('B', 'Beta');
}

const install = (projectId: string) => env.call('POST', '/api/servers/s1/mods', { projectId });
const update = () => env.call('POST', '/api/servers/s1/mods/updates/apply');
const versions = (projectId: string, count: number): void => {
  for (let index = 1; index <= count; index++) {
    env.fake.addVersion({ id: `${projectId.toLowerCase()}${index}`, projectId, number: String(index), date: `2024-0${index}-01T00:00:00Z` });
  }
};

describe('retention after updates', () => {
  it('keeps only the newest N backups of a mod and never deletes the one just created', async () => {
    await setup(2);
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    for (const index of [2, 3, 4, 5]) {
      env.fake.addVersion({ id: `a${index}`, projectId: 'A', number: String(index), date: `2024-0${index}-01T00:00:00Z` });
      expect(((await update()).body as { results: Array<{ status: string }> }).results[0]?.status).toBe('success');
    }
    // four updates made four backups (A-1 ... A-4); only the newest two remain
    expect(await env.files('s1', 'mods_backup')).toEqual(['A-3.jar', 'A-4.jar']);
    expect(await env.files('s1')).toEqual(['A-5.jar']);
    const log = await env.t.db.select().from(modUpdateLog);
    expect(log.filter((entry) => entry.backupPath !== null)).toHaveLength(2);
  });

  it('with the smallest setting the backup of the last update is the one that stays', async () => {
    await setup(1);
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    for (const index of [2, 3]) {
      env.fake.addVersion({ id: `a${index}`, projectId: 'A', number: String(index), date: `2024-0${index}-01T00:00:00Z` });
      await update();
    }
    expect(await env.files('s1', 'mods_backup')).toEqual(['A-2.jar']);
  });

  it('counts every mod on its own', async () => {
    await setup(1);
    versions('A', 1);
    versions('B', 1);
    await install('A');
    await install('B');
    for (const index of [2, 3]) {
      versions('A', index);
      versions('B', index);
      await update();
    }
    expect(await env.files('s1', 'mods_backup')).toEqual(['A-2.jar', 'B-2.jar']);
  });

  it('keeps backups it cannot assign to a mod', async () => {
    await setup(1);
    await env.writeJar('s1', 'handmade.jar', 'x', 'mods_backup');
    versions('A', 1);
    await install('A');
    for (const index of [2, 3]) {
      versions('A', index);
      await update();
    }
    expect(await env.files('s1', 'mods_backup')).toEqual(['A-2.jar', 'handmade.jar']);
  });

  it('does not let a failing cleanup turn a successful update into an error', async () => {
    await setup(1);
    versions('A', 1);
    await install('A');
    versions('A', 2);
    // a folder where a backup file is expected is not a regular file and is ignored, not an error
    await mkdir(path.join(env.serverDir('s1'), 'mods_backup', 'folder.jar'), { recursive: true });
    expect(((await update()).body as { results: Array<{ status: string }> }).results[0]?.status).toBe('success');
  });
});

describe('listing and cleaning up', () => {
  async function withLog(names: string[]): Promise<void> {
    await setup(2);
    const dir = path.join(env.serverDir('s1'), 'mods_backup');
    await mkdir(dir, { recursive: true });
    let time = Date.UTC(2024, 0, 1);
    for (const name of names) {
      await writeFile(path.join(dir, name), 'x'.repeat(100));
      await env.t.db.insert(modUpdateLog).values({
        serverId: 's1',
        modId: null,
        modName: 'Xeno',
        backupPath: `mods_backup/${name}`,
        status: 'success',
        createdAt: new Date((time += 86_400_000)),
      });
    }
  }

  it('lists sizes, the owning mod and which files the cleanup would remove', async () => {
    await withLog(['X-1.jar', 'X-2.jar', 'X-3.jar', 'X-4.jar']);
    await env.writeJar('s1', 'foreign.jar', 'abc', 'mods_backup');
    const res = await env.call<ModBackupList>('GET', '/api/servers/s1/mods/backups');
    expect(res.status).toBe(200);
    expect(res.body.keep).toBe(2);
    expect(res.body.totalBytes).toBe(403);
    const removable = res.body.backups.filter((entry) => entry.removable).map((entry) => entry.fileName).sort();
    expect(removable).toEqual(['X-1.jar', 'X-2.jar']);
    expect(res.body.backups.find((entry) => entry.fileName === 'foreign.jar')).toMatchObject({ modName: null, removable: false, sizeBytes: 3 });
    expect(res.body.backups.find((entry) => entry.fileName === 'X-4.jar')).toMatchObject({ modName: 'Xeno', sizeBytes: 100 });
  });

  it('the cleanup removes exactly those, reports the freed space and keeps the log entries', async () => {
    await withLog(['X-1.jar', 'X-2.jar', 'X-3.jar', 'X-4.jar']);
    const res = await env.call<{ removed: number; freedBytes: number }>('POST', '/api/servers/s1/mods/backups/cleanup');
    expect(res.body).toEqual({ removed: 2, freedBytes: 200 });
    expect(await env.files('s1', 'mods_backup')).toEqual(['X-3.jar', 'X-4.jar']);
    const log = await env.t.db.select().from(modUpdateLog);
    expect(log).toHaveLength(4);
    expect(log.filter((entry) => entry.backupPath === null)).toHaveLength(2);
    expect((await env.call<ModBackupList>('GET', '/api/servers/s1/mods/backups')).body.backups.some((entry) => entry.removable)).toBe(false);
    expect(((await env.call('POST', '/api/servers/s1/mods/backups/cleanup')).body as { removed: number }).removed).toBe(0);
  });

  it('works while the server runs, because the folder is not read by the game', async () => {
    await withLog(['X-1.jar', 'X-2.jar', 'X-3.jar']);
    env.running.add('s1');
    expect(((await env.call('POST', '/api/servers/s1/mods/backups/cleanup')).body as { removed: number }).removed).toBe(1);
  });

  it('never removes the protected file even when it is the oldest', async () => {
    await withLog(['X-1.jar', 'X-2.jar', 'X-3.jar']);
    const server = { db: env.t.db, profile: requireLoaderProfile('fabric'), serverDir: env.serverDir('s1'), serverId: 's1' };
    const result = await pruneModBackups(server, 1, path.join(server.serverDir, 'mods_backup', 'X-1.jar'));
    expect(result.removed).toBe(1);
    expect(await env.files('s1', 'mods_backup')).toEqual(['X-1.jar', 'X-3.jar']);
  });

  it('handles a missing backup folder and unknown servers', async () => {
    await setup(2);
    const empty = await env.call<ModBackupList>('GET', '/api/servers/s1/mods/backups');
    expect(empty.body).toEqual({ backups: [], totalBytes: 0, keep: 2 });
    expect((await env.call('GET', '/api/servers/nope/mods/backups')).status).toBe(404);
    expect((await env.call('POST', '/api/servers/nope/mods/backups/cleanup')).status).toBe(404);
    await env.addServer('v1', { loader: 'vanilla' });
    expect((await env.call('GET', '/api/servers/v1/mods/backups')).status).toBe(409);
  });

  it('is exposed through the folder size on disk', async () => {
    await withLog(['X-1.jar']);
    const info = await stat(path.join(env.serverDir('s1'), 'mods_backup', 'X-1.jar'));
    expect((await readdir(path.join(env.serverDir('s1'), 'mods_backup'))).length).toBe(1);
    expect((await env.call<ModBackupList>('GET', '/api/servers/s1/mods/backups')).body.totalBytes).toBe(info.size);
  });
});
