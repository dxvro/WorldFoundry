import { eq } from 'drizzle-orm';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modDependencies, modUpdateLog, mods, type Mod } from '../src/db/schema.js';
import { applyRenames, type ScanReport } from '../src/mods/scanner.js';
import { MsgList } from '../src/messages.js';
import type { UpdateCandidate, UpdateResult } from '../src/mods/updater.js';
import { ModEnv } from './mod-env.js';

interface ErrorBody {
  error: { code: string };
}

let env: ModEnv;
beforeEach(async () => {
  env = await ModEnv.create();
  await env.addServer('s1');
  for (const [id, title] of [['A', 'Alpha'], ['B', 'Beta'], ['D', 'Delta']] as const) env.fake.addProject(id, title);
});
afterEach(async () => {
  await env.close();
});

const dep = (project: string, type = 'required') => ({ project_id: project, dependency_type: type });
const scan = () => env.call<ScanReport>('POST', '/api/servers/s1/mods/scan');
const install = (projectId: string, versionId?: string) =>
  env.call<ErrorBody>('POST', '/api/servers/s1/mods', { projectId, ...(versionId ? { versionId } : {}) });
const modOf = async (projectId: string): Promise<Mod> => {
  const row = (await env.t.db.select().from(mods)).find((m) => m.projectId === projectId);
  if (row === undefined) throw new Error(`no mod ${projectId}`);
  return row;
};

describe('dependency rows for scanner-identified mods', () => {
  it('protects a library required by an identified manual mod', async () => {
    env.fake.addVersion({ id: 'b1', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', content: 'manual-a', deps: [dep('B')] });
    await install('B');
    await env.writeJar('s1', 'hand-copied.jar', 'manual-a');
    expect((await scan()).body.identified).toBe(1);

    const rows = await env.t.db.select().from(modDependencies);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dependsOnModId).toBe((await modOf('B')).id);

    const blocked = await env.call<ErrorBody>('DELETE', `/api/servers/s1/mods/${(await modOf('B')).id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('MOD_REQUIRED_BY_OTHERS');
    expect(await env.files('s1')).toContain('B-1.jar');
  });

  it('does not duplicate rows on rescans', async () => {
    env.fake.addVersion({ id: 'b1', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    env.fake.addVersion({
      id: 'a1',
      projectId: 'A',
      number: '1',
      date: '2024-01-01T00:00:00Z',
      content: 'manual-a',
      deps: [dep('B'), dep('D', 'incompatible')],
    });
    await install('B');
    await env.writeJar('s1', 'hand-copied.jar', 'manual-a');
    await scan();
    await scan();
    await scan();
    expect(await env.t.db.select().from(modDependencies)).toHaveLength(2);
  });

  it('honours incompatible declarations of identified manual mods', async () => {
    env.fake.addVersion({ id: 'd1', projectId: 'D', number: '1', date: '2024-01-01T00:00:00Z' });
    env.fake.addVersion({
      id: 'a1',
      projectId: 'A',
      number: '1',
      date: '2024-01-01T00:00:00Z',
      content: 'manual-a',
      deps: [dep('D', 'incompatible')],
    });
    await env.writeJar('s1', 'hand-copied.jar', 'manual-a');
    await scan();
    const res = await install('D');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MOD_INCOMPATIBLE');
  });

  it('re-creates rows when a Modrinth jar is replaced on disk and recognized again', async () => {
    env.fake.addVersion({ id: 'b1', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', content: 'a-one', deps: [dep('B')] });
    env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z', content: 'a-two', deps: [dep('B')] });
    await install('B');
    await install('A', 'a1');
    await env.writeJar('s1', 'A-1.jar', 'a-two');
    const res = await scan();
    expect(res.body).toMatchObject({ replaced: 1, identified: 1 });
    const a = await modOf('A');
    expect(a.versionId).toBe('a2');
    const rows = await env.t.db.select().from(modDependencies).where(eq(modDependencies.modId, a.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dependsOnModId).toBe((await modOf('B')).id);
  });
});

describe('update file name', () => {
  it('reports and logs the jar that pickFile installs, not a non-jar primary file', async () => {
    env.fake.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    const v2 = env.fake.addVersion({ id: 'a2', projectId: 'A', number: '2', date: '2024-02-01T00:00:00Z' });
    const jar = v2.files[0];
    if (jar === undefined) throw new Error('setup');
    jar.primary = false;
    v2.files.unshift({
      hashes: { sha512: 'x' },
      url: 'https://cdn.modrinth.com/x.zip',
      filename: 'A-2-pack.zip',
      primary: true,
      size: 1,
      file_type: null,
    });

    const check = await env.call<{ updates: UpdateCandidate[] }>('POST', '/api/servers/s1/mods/updates/check');
    expect(check.body.updates[0]?.newFileName).toBe('A-2.jar');
    const res = await env.call<{ results: UpdateResult[] }>('POST', '/api/servers/s1/mods/updates/apply', {});
    expect(res.body.results[0]?.status).toBe('success');
    expect((await env.t.db.select().from(modUpdateLog))[0]?.toFileName).toBe('A-2.jar');
    expect(await env.files('s1')).toEqual(['A-2.jar']);
  });
});

describe('update fallback tier', () => {
  it('offers a newer beta to a beta user when the endpoint proposes an alpha', async () => {
    env.fake.addVersion({ id: 'b1', projectId: 'A', number: '1-beta', type: 'beta', date: '2024-02-01T00:00:00Z' });
    await install('A');
    env.fake.addVersion({ id: 'r0', projectId: 'A', number: '0.9', date: '2024-01-01T00:00:00Z' });
    env.fake.addVersion({ id: 'b2', projectId: 'A', number: '2-beta', type: 'beta', date: '2024-03-01T00:00:00Z' });
    env.fake.addVersion({ id: 'al', projectId: 'A', number: '3-alpha', type: 'alpha', date: '2024-04-01T00:00:00Z' });
    const res = await env.call<{ updates: UpdateCandidate[] }>('POST', '/api/servers/s1/mods/updates/check');
    expect(res.body.updates.map((u) => u.newVersionId)).toEqual(['b2']);
  });
});

describe('rename swaps', () => {
  it('follows two jars that swapped names and deletes the right file afterwards', async () => {
    await env.writeJar('s1', 'A.jar', 'content-one');
    await env.writeJar('s1', 'B.jar', 'content-two');
    await scan();
    const one = (await env.t.db.select().from(mods)).find((m) => m.fileName === 'A.jar');
    const dir = path.join(env.serverDir('s1'), 'mods');
    await rename(path.join(dir, 'A.jar'), path.join(dir, 'tmp.jar'));
    await rename(path.join(dir, 'B.jar'), path.join(dir, 'A.jar'));
    await rename(path.join(dir, 'tmp.jar'), path.join(dir, 'B.jar'));

    const res = await scan();
    expect(res.body.renamed).toBe(2);
    expect(res.body.warnings).toEqual([]);
    const after = await env.t.db.select().from(mods);
    expect(after.find((m) => m.id === one?.id)?.fileName).toBe('B.jar');
    expect(after.some((m) => m.fileName.endsWith('.rename-tmp'))).toBe(false);

    expect((await env.call('DELETE', `/api/servers/s1/mods/${one?.id}`)).status).toBe(200);
    expect(await env.files('s1')).toEqual(['A.jar']);
    expect(await readFile(path.join(dir, 'A.jar'), 'utf8')).toBe('content-two');
  });

  it('warns on a rename that conflicts with an unrelated row and leaves no temp name', async () => {
    const now = new Date();
    const base = { serverId: 's1', source: 'manual' as const, sizeBytes: 1, installedAt: now, updatedAt: now };
    await env.t.db.insert(mods).values([
      { ...base, id: 'x', name: 'x', fileName: 'x.jar', sha512: 'hx' },
      { ...base, id: 'z', name: 'z', fileName: 'taken.jar', sha512: 'hz' },
    ]);
    const x = (await env.t.db.select().from(mods)).find((m) => m.id === 'x');
    if (x === undefined) throw new Error('setup');
    const warnings = new MsgList();
    const done = await env.t.db.transaction((tx) => applyRenames(tx, [{ row: x, file: { fileName: 'taken.jar' } }], warnings));
    expect(done).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    const rows = await env.t.db.select().from(mods);
    expect(rows.map((m) => m.fileName).sort()).toEqual(['taken.jar', 'x.jar']);
  });
});
