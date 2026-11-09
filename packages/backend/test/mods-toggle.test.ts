import { eq } from 'drizzle-orm';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallResult, SearchResponse, ToggleResult } from '../src/contract.js';
import { modDependencies, mods, type Mod } from '../src/db/schema.js';
import type { ScanReport } from '../src/mods/scanner.js';
import type { UpdateResult } from '../src/mods/updater.js';
import { ModEnv } from './mod-env.js';

interface ErrorBody {
  error: { code: string; message: string; details?: { dependents?: Array<{ name: string }>; mods?: string[] } };
}

let env: ModEnv;
beforeEach(async () => {
  env = await ModEnv.create();
  await env.addServer('s1');
  for (const [id, title] of [['A', 'Alpha'], ['B', 'Beta'], ['C', 'Gamma'], ['D', 'Delta'], ['X', 'Xeno']] as const) env.fake.addProject(id, title);
});
afterEach(async () => {
  await env.close();
});

const dep = (project: string, type = 'required') => ({ project_id: project, dependency_type: type });
const v = (id: string, projectId: string, extra: Partial<Parameters<typeof env.fake.addVersion>[0]> = {}) =>
  env.fake.addVersion({ id, projectId, number: '1', date: '2024-01-01T00:00:00Z', ...extra });
const install = (projectId: string) => env.call<InstallResult & ErrorBody>('POST', '/api/servers/s1/mods', { projectId });
const toggle = (mod: Mod, enabled: boolean, force?: boolean) =>
  env.call<ToggleResult & ErrorBody>('PATCH', `/api/servers/s1/mods/${mod.id}`, { enabled, ...(force === undefined ? {} : { force }) });
const rows = async (): Promise<Mod[]> => env.t.db.select().from(mods);
const modOf = async (projectId: string): Promise<Mod> => {
  const row = (await rows()).find((entry) => entry.projectId === projectId);
  if (row === undefined) throw new Error(`no mod ${projectId}`);
  return row;
};
const scan = () => env.call<ScanReport>('POST', '/api/servers/s1/mods/scan');

describe('PATCH /mods/:modId', () => {
  it('switches a mod off by renaming it to .jar.disabled and back on again', async () => {
    v('a1', 'A');
    await install('A');
    const mod = await modOf('A');
    expect(mod.enabled).toBe(true);

    const off = await toggle(mod, false);
    expect(off.status).toBe(200);
    expect(off.body.mod).toMatchObject({ id: mod.id, enabled: false, fileName: 'A-1.jar' });
    expect(off.body.changed.map((entry) => entry.id)).toEqual([mod.id]);
    expect(await env.files('s1')).toEqual(['A-1.jar.disabled']);
    expect((await modOf('A')).enabled).toBe(false);

    const on = await toggle(mod, true);
    expect(on.body.mod.enabled).toBe(true);
    expect(await env.files('s1')).toEqual(['A-1.jar']);
    expect((await modOf('A')).enabled).toBe(true);
  });

  it('keeps the file bytes and the row identity; the list shows the state', async () => {
    v('a1', 'A', { content: 'content-a' });
    await install('A');
    const mod = await modOf('A');
    await toggle(mod, false);
    expect(await readFile(path.join(env.serverDir('s1'), 'mods', 'A-1.jar.disabled'), 'utf8')).toBe('content-a');
    const list = await env.call<{ mods: Mod[] }>('GET', '/api/servers/s1/mods');
    expect(list.body.mods.map((entry) => [entry.id, entry.enabled])).toEqual([[mod.id, false]]);
  });

  it('is idempotent when the mod is already in the requested state', async () => {
    v('a1', 'A');
    await install('A');
    const res = await toggle(await modOf('A'), true);
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([]);
    expect(await env.files('s1')).toEqual(['A-1.jar']);
  });

  it('is refused while the server runs and changes nothing', async () => {
    v('a1', 'A');
    await install('A');
    env.running.add('s1');
    const res = await toggle(await modOf('A'), false);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SERVER_RUNNING');
    expect(await env.files('s1')).toEqual(['A-1.jar']);
    expect((await modOf('A')).enabled).toBe(true);
  });

  it('answers 404 for unknown mods and mods of other servers, 400 for bad bodies, 409 for vanilla', async () => {
    expect((await env.call<ErrorBody>('PATCH', '/api/servers/s1/mods/nope', { enabled: false })).body.error.code).toBe('MOD_NOT_FOUND');
    expect((await env.call<ErrorBody>('PATCH', '/api/servers/s1/mods/x', { enabled: 'ja' })).status).toBe(400);
    expect((await env.call<ErrorBody>('PATCH', '/api/servers/s1/mods/x', {})).status).toBe(400);
    expect((await env.call<ErrorBody>('PATCH', '/api/servers/s1/mods/x', { enabled: true, extra: 1 })).status).toBe(400);
    await env.addServer('s2');
    v('a1', 'A');
    await install('A');
    const mod = await modOf('A');
    const other = await env.call<ErrorBody>('PATCH', `/api/servers/s2/mods/${mod.id}`, { enabled: false });
    expect(other.body.error.code).toBe('MOD_NOT_FOUND');
    await env.addServer('s3', { loader: 'vanilla' });
    expect((await env.call<ErrorBody>('PATCH', '/api/servers/s3/mods/x', { enabled: false })).body.error.code).toBe('MODS_NOT_SUPPORTED');
  });

  it('works for plugins in the plugins folder', async () => {
    await env.addServer('p1', { loader: 'paper' });
    v('a1', 'A', { loaders: ['paper'] });
    expect((await env.call('POST', '/api/servers/p1/mods', { projectId: 'A' })).status).toBe(201);
    const mod = (await rows()).find((entry) => entry.serverId === 'p1') as Mod;
    expect((await env.call('PATCH', `/api/servers/p1/mods/${mod.id}`, { enabled: false })).status).toBe(200);
    expect(await env.files('p1', 'plugins')).toEqual(['A-1.jar.disabled']);
  });

  it('answers 404 when the file is gone, because the scan before the change removes the row', async () => {
    v('a1', 'A');
    await install('A');
    const mod = await modOf('A');
    await rm(path.join(env.serverDir('s1'), 'mods', 'A-1.jar'));
    const res = await toggle(mod, false);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MOD_NOT_FOUND');
    expect(await rows()).toHaveLength(0);
  });
});

describe('dependencies when switching off', () => {
  it('blocks a mod other enabled mods require, listing them, unless forced', async () => {
    v('b1', 'B');
    v('a1', 'A', { deps: [dep('B')] });
    await install('A');
    const b = await modOf('B');
    const blocked = await toggle(b, false);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('MOD_REQUIRED_BY_OTHERS');
    expect(blocked.body.error.details?.dependents?.map((entry) => entry.name)).toEqual(['Alpha']);
    expect(await env.files('s1')).toEqual(['A-1.jar', 'B-1.jar']);

    const forced = await toggle(b, false, true);
    expect(forced.status).toBe(200);
    expect(forced.body.warnings[0]).toContain('Alpha');
    expect(await env.files('s1')).toEqual(['A-1.jar', 'B-1.jar.disabled']);
  });

  it('does not count dependents that are switched off themselves', async () => {
    v('b1', 'B');
    v('a1', 'A', { deps: [dep('B')] });
    await install('A');
    expect((await toggle(await modOf('A'), false)).status).toBe(200);
    expect((await toggle(await modOf('B'), false)).status).toBe(200);
    expect(await env.files('s1')).toEqual(['A-1.jar.disabled', 'B-1.jar.disabled']);
  });
});

describe('dependencies when switching on', () => {
  it('switches on the disabled required dependencies recursively and reports them', async () => {
    v('c1', 'C');
    v('b1', 'B', { deps: [dep('C')] });
    v('a1', 'A', { deps: [dep('B')] });
    await install('A');
    for (const project of ['A', 'B', 'C']) expect((await toggle(await modOf(project), false, true)).status).toBe(200);
    expect(await env.files('s1')).toEqual(['A-1.jar.disabled', 'B-1.jar.disabled', 'C-1.jar.disabled']);

    const res = await toggle(await modOf('A'), true);
    expect(res.status).toBe(200);
    expect(res.body.dependencies.map((entry) => entry.name).sort()).toEqual(['Beta', 'Gamma']);
    expect(res.body.changed.map((entry) => entry.name)).toContain('Alpha');
    expect(res.body.warnings).toHaveLength(2);
    expect(res.body.warnings.join(' ')).toContain('Beta');
    expect(res.body.warnings.join(' ')).toContain('as a required dependency');
    expect(res.body).toMatchObject({ warningRefs: expect.arrayContaining([{ key: 'MOD_DEPENDENCY_ENABLED', params: { name: 'Beta' } }, { key: 'MOD_DEPENDENCY_ENABLED', params: { name: 'Gamma' } }]) });
    expect(await env.files('s1')).toEqual(['A-1.jar', 'B-1.jar', 'C-1.jar']);
    expect((await rows()).every((row) => row.enabled)).toBe(true);
  });

  it('only touches the dependencies that are actually off', async () => {
    v('b1', 'B');
    v('a1', 'A', { deps: [dep('B')] });
    await install('A');
    await toggle(await modOf('A'), false);
    const res = await toggle(await modOf('A'), true);
    expect(res.body.dependencies).toEqual([]);
    expect(res.body.warnings).toEqual([]);
  });

  it('answers MOD_INCOMPATIBLE when it collides with an enabled mod and changes nothing', async () => {
    v('x1', 'X', { deps: [dep('A', 'incompatible')] });
    v('a1', 'A');
    await install('X');
    await toggle(await modOf('X'), false);
    // A can be installed because the mod that declares the conflict is off
    expect((await install('A')).status).toBe(201);
    const res = await toggle(await modOf('X'), true);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MOD_INCOMPATIBLE');
    expect(res.body.error.details?.mods?.sort()).toEqual(['Alpha', 'Xeno']);
    expect(await env.files('s1')).toEqual(['A-1.jar', 'X-1.jar.disabled']);
    expect((await modOf('X')).enabled).toBe(false);
  });

  it('detects a collision caused by a dependency that would be switched on with the mod', async () => {
    v('x1', 'X', { deps: [dep('A', 'incompatible')] });
    v('d1', 'D');
    v('a1', 'A');
    await install('X');
    await install('D');
    await toggle(await modOf('X'), false);
    expect((await install('A')).status).toBe(201);
    // D now requires X: enabling D must pull X in, which collides with A
    await env.t.db.insert(modDependencies).values({ modId: (await modOf('D')).id, dependencyType: 'required', projectId: 'X', versionId: null, fileName: null, dependsOnModId: (await modOf('X')).id });
    await toggle(await modOf('D'), false, true);
    const res = await toggle(await modOf('D'), true);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MOD_INCOMPATIBLE');
    expect(await env.files('s1')).toEqual(['A-1.jar', 'D-1.jar.disabled', 'X-1.jar.disabled']);
  });

  it('allows enabling when the incompatible mod is switched off too', async () => {
    v('x1', 'X', { deps: [dep('A', 'incompatible')] });
    v('a1', 'A');
    await install('X');
    await toggle(await modOf('X'), false);
    await install('A');
    await toggle(await modOf('A'), false);
    expect((await toggle(await modOf('X'), true)).status).toBe(200);
  });
});

describe('installing next to switched-off mods', () => {
  it('switches a disabled required dependency back on and says so in the warnings', async () => {
    v('b1', 'B');
    await install('B');
    await toggle(await modOf('B'), false);
    v('a1', 'A', { deps: [dep('B')] });
    const res = await install('A');
    expect(res.status).toBe(201);
    expect(res.body.reenabled.map((entry) => entry.name)).toEqual(['Beta']);
    expect(res.body.warnings.join(' ')).toContain('"Beta" was disabled and is enabled again because "Alpha" requires it');
    expect(res.body).toMatchObject({ warningRefs: [{ key: 'MOD_REENABLED', params: { name: 'Beta', by: 'Alpha' } }] });
    expect(await env.files('s1')).toEqual(['A-1.jar', 'B-1.jar']);
    expect((await modOf('B')).enabled).toBe(true);
    expect((await modOf('A')).enabled).toBe(true);
  });

  it('follows a chain of switched-off dependencies', async () => {
    v('c1', 'C');
    v('b1', 'B', { deps: [dep('C')] });
    await install('B');
    await toggle(await modOf('B'), false, true);
    await toggle(await modOf('C'), false, true);
    v('a1', 'A', { deps: [dep('B')] });
    const res = await install('A');
    expect(res.body.reenabled.map((entry) => entry.name).sort()).toEqual(['Beta', 'Gamma']);
    expect(await env.files('s1')).toEqual(['A-1.jar', 'B-1.jar', 'C-1.jar']);
  });

  it('ignores incompatibilities declared by switched-off mods and checks the ones that come back', async () => {
    v('x1', 'X', { deps: [dep('A', 'incompatible')] });
    v('a1', 'A');
    await install('X');
    await toggle(await modOf('X'), false);
    expect((await install('A')).status).toBe(201);

    // a new mod that needs X back would bring the conflict with A back as well
    v('d1', 'D', { deps: [dep('X')] });
    const res = await install('D');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MOD_INCOMPATIBLE');
    expect(await env.files('s1')).toEqual(['A-1.jar', 'X-1.jar.disabled']);
    expect((await modOf('X')).enabled).toBe(false);
  });

  it('installs a mod that is incompatible with a switched-off one', async () => {
    v('a1', 'A');
    await install('A');
    await toggle(await modOf('A'), false);
    v('x1', 'X', { deps: [dep('A', 'incompatible')] });
    expect((await install('X')).status).toBe(201);
  });

  it('rolls back the re-enabled files when the installation fails', async () => {
    v('b1', 'B');
    await install('B');
    await toggle(await modOf('B'), false);
    v('a1', 'A', { deps: [dep('B')] });
    env.fake.failUrls.add(env.fake.urlOf('a1'));
    const res = await install('A');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await env.files('s1')).toEqual(['B-1.jar.disabled']);
    expect((await modOf('B')).enabled).toBe(false);
  });

  it('refuses to install a mod that is already there but switched off', async () => {
    v('a1', 'A');
    await install('A');
    await toggle(await modOf('A'), false);
    const res = await install('A');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MOD_DISABLED');
  });

  it('marks switched-off mods in the store search', async () => {
    v('a1', 'A');
    env.fake.addProject('S', 'Suche');
    await install('A');
    await toggle(await modOf('A'), false);
    const res = await env.call<SearchResponse>('GET', '/api/servers/s1/mods/search?query=Alpha');
    const hit = res.body.hits.find((entry) => entry.projectId === 'A');
    expect(hit).toMatchObject({ installed: true, enabled: false, modId: (await modOf('A')).id });
  });
});

describe('updates and deletion of switched-off mods', () => {
  it('updates a disabled mod in place: it stays disabled, name, backup and log included', async () => {
    v('a1', 'A');
    await install('A');
    await toggle(await modOf('A'), false);
    v('a2', 'A', { number: '2', date: '2024-02-01T00:00:00Z' });
    const res = await env.call<{ results: UpdateResult[] }>('POST', '/api/servers/s1/mods/updates/apply');
    expect(res.body.results[0]?.status).toBe('success');
    expect(await env.files('s1')).toEqual(['A-2.jar.disabled']);
    expect(await env.files('s1', 'mods_backup')).toEqual(['A-1.jar.disabled']);
    const mod = await modOf('A');
    expect(mod).toMatchObject({ enabled: false, fileName: 'A-2.jar', versionId: 'a2' });
    // switching it on afterwards uses the new name
    await toggle(mod, true);
    expect(await env.files('s1')).toEqual(['A-2.jar']);
  });

  it('rolls a failed update of a disabled mod back to the disabled file', async () => {
    v('a1', 'A', { content: 'a-one' });
    v('b1', 'B', { content: 'collide' });
    await install('A');
    await install('B');
    await toggle(await modOf('A'), false);
    v('a2', 'A', { number: '2', date: '2024-02-01T00:00:00Z', content: 'collide' });
    const res = await env.call<{ results: UpdateResult[] }>('POST', '/api/servers/s1/mods/updates/apply', { projectIds: ['A'] });
    expect(res.body.results[0]?.status).toBe('rolled_back');
    expect(await env.files('s1')).toEqual(['A-1.jar.disabled', 'B-1.jar']);
    expect(await env.files('s1', 'mods_backup')).toEqual([]);
    expect((await modOf('A'))).toMatchObject({ enabled: false, versionId: 'a1' });
  });

  it('leaves a disabled mod untouched when its download fails', async () => {
    v('a1', 'A');
    await install('A');
    await toggle(await modOf('A'), false);
    v('a2', 'A', { number: '2', date: '2024-02-01T00:00:00Z' });
    env.fake.failUrls.add(env.fake.urlOf('a2'));
    const res = await env.call<{ results: UpdateResult[] }>('POST', '/api/servers/s1/mods/updates/apply');
    expect(res.body.results[0]?.status).toBe('failed');
    expect(await env.files('s1')).toEqual(['A-1.jar.disabled']);
  });

  it('switches a disabled dependency on when an update of an enabled mod needs it', async () => {
    v('b1', 'B');
    v('a1', 'A');
    await install('A');
    await install('B');
    await toggle(await modOf('B'), false);
    v('a2', 'A', { number: '2', date: '2024-02-01T00:00:00Z', deps: [dep('B')] });
    const res = await env.call<{ results: UpdateResult[] }>('POST', '/api/servers/s1/mods/updates/apply');
    expect(res.body.results[0]?.status).toBe('success');
    expect(await env.files('s1')).toEqual(['A-2.jar', 'B-1.jar']);
    expect((await modOf('B')).enabled).toBe(true);
  });

  it('deletes a disabled mod together with its .disabled file, also when it was switched by hand', async () => {
    v('a1', 'A');
    v('b1', 'B');
    await install('A');
    await install('B');
    await toggle(await modOf('A'), false);
    const a = await modOf('A');
    expect((await env.call('DELETE', `/api/servers/s1/mods/${a.id}`)).status).toBe(200);
    expect(await env.files('s1')).toEqual(['B-1.jar']);

    const b = await modOf('B');
    await rename(path.join(env.serverDir('s1'), 'mods', 'B-1.jar'), path.join(env.serverDir('s1'), 'mods', 'B-1.jar.disabled'));
    expect((await env.call('DELETE', `/api/servers/s1/mods/${b.id}`)).status).toBe(200);
    expect(await env.files('s1')).toEqual([]);
    expect(await rows()).toHaveLength(0);
  });
});

describe('scanner and .jar.disabled', () => {
  it('recognizes a hand-made rename as the same mod and flips the state both ways', async () => {
    v('a1', 'A');
    await install('A');
    const mod = await modOf('A');
    const dir = path.join(env.serverDir('s1'), 'mods');
    await rename(path.join(dir, 'A-1.jar'), path.join(dir, 'A-1.jar.disabled'));
    const first = await scan();
    expect(first.body).toMatchObject({ toggled: 1, added: 0, removed: 0, renamed: 0 });
    expect(await rows()).toHaveLength(1);
    expect((await modOf('A'))).toMatchObject({ id: mod.id, enabled: false, fileName: 'A-1.jar' });

    await rename(path.join(dir, 'A-1.jar.disabled'), path.join(dir, 'A-1.jar'));
    expect((await scan()).body.toggled).toBe(1);
    expect((await modOf('A'))).toMatchObject({ id: mod.id, enabled: true });
    expect((await scan()).body.toggled).toBe(0);
  });

  it('follows a rename of a disabled file to a new name', async () => {
    v('a1', 'A');
    await install('A');
    const mod = await modOf('A');
    await toggle(mod, false);
    const dir = path.join(env.serverDir('s1'), 'mods');
    await rename(path.join(dir, 'A-1.jar.disabled'), path.join(dir, 'new.jar.disabled'));
    expect((await scan()).body).toMatchObject({ renamed: 1, added: 0, removed: 0 });
    expect(await modOf('A')).toMatchObject({ id: mod.id, fileName: 'new.jar', enabled: false });
    // renaming to an active name switches it on in the same step
    await rename(path.join(dir, 'new.jar.disabled'), path.join(dir, 'active.jar'));
    const report = await scan();
    expect(report.body).toMatchObject({ renamed: 1, toggled: 1 });
    expect(await modOf('A')).toMatchObject({ id: mod.id, fileName: 'active.jar', enabled: true });
  });

  it('adds unknown .jar.disabled files as switched-off manual mods', async () => {
    await env.writeJar('s1', 'hand.jar.disabled', 'handmade');
    const report = await scan();
    expect(report.body.added).toBe(1);
    expect((await rows())[0]).toMatchObject({ fileName: 'hand.jar', enabled: false, source: 'manual', name: 'hand' });
    expect((await scan()).body).toMatchObject({ added: 0, removed: 0, toggled: 0 });
  });

  it('warns about a.jar next to a.jar.disabled, keeps the active file and loses no row', async () => {
    v('a1', 'A', { content: 'content' });
    await install('A');
    const mod = await modOf('A');
    await env.writeJar('s1', 'A-1.jar.disabled', 'content');
    const same = await scan();
    expect(same.body.warnings.join(' ')).toContain('A-1.jar');
    expect(same.body.warnings.join(' ')).toContain('A-1.jar.disabled');
    expect(await rows()).toHaveLength(1);
    expect(await modOf('A')).toMatchObject({ id: mod.id, enabled: true });

    // different content in the disabled copy: ignored with a warning, the row stays
    await env.writeJar('s1', 'A-1.jar.disabled', 'completely different content');
    const different = await scan();
    expect(different.body.warnings.join(' ')).toContain('different content');
    expect(await rows()).toHaveLength(1);
    expect(await modOf('A')).toMatchObject({ id: mod.id, enabled: true, versionId: 'a1' });
  });

  it('keeps a switched-off mod when its disabled twin appears under another name (duplicate content)', async () => {
    v('a1', 'A', { content: 'content' });
    await install('A');
    await toggle(await modOf('A'), false);
    await env.writeJar('s1', 'copy.jar', 'content');
    const report = await scan();
    expect(report.body.warnings.join(' ')).toContain('identical');
    expect(await rows()).toHaveLength(1);
  });

  it('removes the row when a disabled file disappears', async () => {
    v('a1', 'A');
    await install('A');
    await toggle(await modOf('A'), false);
    await rm(path.join(env.serverDir('s1'), 'mods', 'A-1.jar.disabled'));
    expect((await scan()).body.removed).toBe(1);
    expect(await rows()).toHaveLength(0);
  });

  it('treats a changed disabled file as a replacement and keeps its state', async () => {
    v('a1', 'A');
    await install('A');
    await toggle(await modOf('A'), false);
    await writeFile(path.join(env.serverDir('s1'), 'mods', 'A-1.jar.disabled'), 'new content');
    expect((await scan()).body.replaced).toBe(1);
    expect(await modOf('A').catch(() => null)).toBeNull();
    const row = (await rows())[0];
    expect(row).toMatchObject({ fileName: 'A-1.jar', enabled: false, source: 'manual' });
  });

  it('upgrades rows and relationships untouched: existing dependencies survive toggling', async () => {
    v('b1', 'B');
    v('a1', 'A', { deps: [dep('B')] });
    await install('A');
    const before = await env.t.db.select().from(modDependencies);
    await toggle(await modOf('A'), false);
    await toggle(await modOf('A'), true);
    expect(await env.t.db.select().from(modDependencies)).toEqual(before);
    expect((await env.t.db.select().from(mods).where(eq(mods.projectId, 'A'))).length).toBe(1);
  });
});
