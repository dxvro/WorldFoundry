import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modDependencies, mods, type Mod } from '../src/db/schema.js';
import { sanitizeJarName } from '../src/mods/downloader.js';
import { planInstall } from '../src/mods/resolver.js';
import { requireLoaderProfile } from '../src/mods/profile.js';
import { ModEnv } from './mod-env.js';

interface InstallBody {
  installed: Mod[];
  warnings: string[];
}
interface ErrorBody {
  error: { code: string; message: string; details?: { chain?: string[]; dependents?: Array<{ name: string }>; mods?: string[] } };
}

let env: ModEnv;
beforeEach(async () => {
  env = await ModEnv.create();
  await env.addServer('s1');
  for (const [id, title] of [['A', 'Alpha'], ['B', 'Beta'], ['C', 'Gamma'], ['D', 'Delta']] as const) {
    env.fake.addProject(id, title);
  }
});
afterEach(async () => {
  await env.close();
});

const dep = (project: string, type = 'required') => ({ project_id: project, dependency_type: type });
const install = (projectId: string, versionId?: string, server = 's1') =>
  env.call<InstallBody & ErrorBody>('POST', `/api/servers/${server}/mods`, { projectId, ...(versionId ? { versionId } : {}) });
const rows = () => env.t.db.select().from(mods);
const noTraces = async (): Promise<void> => {
  expect(await env.files('s1')).toEqual([]);
  expect(await rows()).toHaveLength(0);
  expect(await env.files('s1', '.tmp')).toEqual([]);
};

describe('install and dependency resolution', () => {
  it('installs recursive dependencies with is_dependency flags and linked rows', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('C'), dep('D', 'optional')] });
    env.fake.addVersion({ id: 'vc', projectId: 'C', number: '1', date: '2024-01-01T00:00:00Z' });

    const res = await install('A');
    expect(res.status).toBe(201);
    expect(res.body.installed.map((m) => [m.projectId, m.isDependency]).sort()).toEqual([
      ['A', false],
      ['B', true],
      ['C', true],
    ]);
    expect(await env.files('s1')).toEqual(['A-1.jar', 'B-1.jar', 'C-1.jar']);
    expect(await env.files('s1', '.tmp')).toEqual([]);

    const all = await rows();
    const idOf = (p: string): string => all.find((m) => m.projectId === p)?.id ?? '';
    const deps = await env.t.db.select().from(modDependencies);
    expect(deps).toHaveLength(3);
    expect(deps.find((d) => d.modId === idOf('A'))?.dependsOnModId).toBe(idOf('B'));
    expect(deps.find((d) => d.dependencyType === 'optional')?.dependsOnModId).toBeNull();
  });

  it('survives dependency cycles', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('A')] });
    const res = await install('A');
    expect(res.status).toBe(201);
    expect(await rows()).toHaveLength(2);
  });

  it('installs a diamond dependency once', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B'), dep('C')] });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('D')] });
    env.fake.addVersion({ id: 'vc', projectId: 'C', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('D')] });
    env.fake.addVersion({ id: 'vd', projectId: 'D', number: '1', date: '2024-01-01T00:00:00Z' });
    const res = await install('A');
    expect(res.status).toBe(201);
    expect(res.body.installed).toHaveLength(4);
    expect(await env.files('s1')).toEqual(['A-1.jar', 'B-1.jar', 'C-1.jar', 'D-1.jar']);
  });

  it('treats a dependency present as a manual file on disk as installed', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z', content: 'beta-bytes' });
    await env.writeJar('s1', 'my-own-name.jar', 'beta-bytes');

    const res = await install('A');
    expect(res.status).toBe(201);
    expect(res.body.installed.map((m) => m.projectId)).toEqual(['A']);
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.find((m) => m.fileName === 'my-own-name.jar')).toMatchObject({ source: 'manual', projectId: 'B' });
    expect(env.fake.requests.some((u) => u.pathname.includes('/B/versions/'))).toBe(false);
  });

  it('fails with the dependency chain and writes nothing when no compatible version exists', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('C')] });
    env.fake.addVersion({ id: 'vc', projectId: 'C', number: '1', date: '2024-01-01T00:00:00Z', gameVersions: ['1.20.1'] });
    const res = await install('A');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEPENDENCY_UNRESOLVABLE');
    expect(res.body.error.details?.chain).toEqual(['Alpha', 'Beta', 'Gamma']);
    await noTraces();
    expect(env.fake.requests.some((u) => u.hostname === 'cdn.modrinth.com')).toBe(false);
  });

  it('rejects incompatible mods in both directions', async () => {
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B', 'incompatible')] });
    expect((await install('B')).status).toBe(201);
    const forward = await install('A');
    expect(forward.status).toBe(409);
    expect(forward.body.error.code).toBe('MOD_INCOMPATIBLE');
    expect(forward.body.error.details?.mods).toEqual(['Alpha', 'Beta']);

    env.fake.addVersion({ id: 'vc', projectId: 'C', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('D', 'incompatible')] });
    env.fake.addVersion({ id: 'vd', projectId: 'D', number: '1', date: '2024-01-01T00:00:00Z' });
    expect((await install('C')).status).toBe(201);
    const reverse = await install('D');
    expect(reverse.status).toBe(409);
    expect(reverse.body.error.code).toBe('MOD_INCOMPATIBLE');
    expect(await env.files('s1')).toEqual(['B-1.jar', 'C-1.jar']);
  });

  it('first pin wins and adds a warning', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B'), dep('C')] });
    env.fake.addVersion({ id: 'vb1', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    env.fake.addVersion({ id: 'vb2', projectId: 'B', number: '2', date: '2024-02-01T00:00:00Z' });
    env.fake.addVersion({
      id: 'vc',
      projectId: 'C',
      number: '1',
      date: '2024-01-01T00:00:00Z',
      deps: [{ project_id: 'B', version_id: 'vb1', dependency_type: 'required' }],
    });
    const res = await install('A');
    expect(res.status).toBe(201);
    expect(res.body.warnings).toHaveLength(1);
    expect(res.body.installed.find((m) => m.projectId === 'B')?.versionId).toBe('vb2');
  });

  it('warns about external file-only dependencies without failing', async () => {
    env.fake.addVersion({
      id: 'va',
      projectId: 'A',
      number: '1',
      date: '2024-01-01T00:00:00Z',
      deps: [{ file_name: 'external-lib.jar', dependency_type: 'required' }],
    });
    const res = await install('A');
    expect(res.status).toBe(201);
    expect(res.body.warnings[0]).toContain('external-lib.jar');
  });

  it('resolves a version-only dependency through the version', async () => {
    env.fake.addVersion({
      id: 'va',
      projectId: 'A',
      number: '1',
      date: '2024-01-01T00:00:00Z',
      deps: [{ version_id: 'vb', dependency_type: 'required' }],
    });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    const res = await install('A');
    expect(res.body.installed.map((m) => m.projectId).sort()).toEqual(['A', 'B']);
  });

  it('flips an installed dependency to explicit, and rejects repeats and other versions', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
    const flipped = await install('B');
    expect(flipped.status).toBe(201);
    expect(flipped.body.installed[0]?.isDependency).toBe(false);
    expect((await rows()).find((m) => m.projectId === 'B')?.isDependency).toBe(false);

    const again = await install('B');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('MOD_ALREADY_INSTALLED');

    env.fake.addVersion({ id: 'vb2', projectId: 'B', number: '2', date: '2024-02-01T00:00:00Z' });
    const other = await install('B');
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('MOD_VERSION_DIFFERS');
  });

  it('chooses release over newer beta and ignores non-jar files', async () => {
    env.fake.addVersion({ id: 'r', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    env.fake.addVersion({ id: 'b', projectId: 'A', number: '2-beta', type: 'beta', date: '2024-03-01T00:00:00Z' });
    env.fake.addVersion({ id: 'p', projectId: 'A', number: '3', date: '2024-04-01T00:00:00Z', fileType: 'required-resource-pack' });
    const res = await install('A');
    expect(res.status).toBe(201);
    expect(res.body.installed[0]?.versionId).toBe('r');
  });

  it('refuses an explicit version that does not fit the server', async () => {
    env.fake.addVersion({ id: 'old', projectId: 'A', number: '0', date: '2023-01-01T00:00:00Z', gameVersions: ['1.19.2'] });
    const res = await install('A', 'old');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VERSION_INCOMPATIBLE');
  });

  it('caps the plan size', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('C')] });
    env.fake.addVersion({ id: 'vc', projectId: 'C', number: '1', date: '2024-01-01T00:00:00Z' });
    await expect(
      planInstall(
        {
          modrinth: env.fake.api(),
          profile: requireLoaderProfile('fabric'),
          mcVersion: '1.21.1',
          installed: [],
          installedIncompatibilities: [],
          requiredLinks: new Map(),
          maxPlanSize: 2,
        },
        'A',
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_TOO_LARGE' });
  });
});

describe('download safety and all-or-nothing', () => {
  it('rolls back everything on a hash mismatch', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')], content: 'aaaa' });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z', content: 'good' });
    env.fake.blobs.set(env.fake.urlOf('vb'), Buffer.from('evil'));
    const res = await install('A');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('DOWNLOAD_HASH_MISMATCH');
    await noTraces();
  });

  it('rejects oversized downloads', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', content: 'short' });
    env.fake.blobs.set(env.fake.urlOf('va'), Buffer.from('much longer than declared'));
    const res = await install('A');
    expect(res.body.error.code).toBe('DOWNLOAD_HASH_MISMATCH');
    await noTraces();
  });

  it('removes already downloaded files when a later download fails', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    env.fake.failUrls.add(env.fake.urlOf('vb'));
    const res = await install('A');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('DOWNLOAD_FAILED');
    await noTraces();
  });

  it('undoes placed files when the database commit fails', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')], content: 'same' });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z', content: 'same' });
    const res = await install('A');
    expect(res.status).toBe(500);
    await noTraces();
  });

  it('rejects unsafe file names from the API', async () => {
    for (const bad of ['..\\..\\evil.jar', '../evil.jar', 'C:\\evil.jar']) {
      env.fake.addVersion({ id: `v${bad.length}`, projectId: 'A', number: bad, date: '2024-01-01T00:00:00Z', fileName: bad });
      const res = await install('A');
      expect(res.body.error.code).toBe('UNSAFE_FILENAME');
      env.fake.versions.length = 0;
    }
    await noTraces();
  });

  it('sanitizeJarName accepts plain names and rejects traversal and Windows forms', () => {
    expect(sanitizeJarName('fabric-api-0.100.0+1.21.1.jar')).toBe('fabric-api-0.100.0+1.21.1.jar');
    for (const bad of [
      '../a.jar',
      '..\\a.jar',
      'a/b.jar',
      'a\\b.jar',
      'C:evil.jar',
      'C:\\evil.jar',
      '/abs.jar',
      'con.jar',
      'NUL.jar',
      'lpt1.jar',
      'a.txt',
      '.jar',
      '',
      'trailing-dot..jar',
      'name.jar:stream',
      'bad\u0000.jar',
      'a|b.jar',
    ]) {
      expect(() => sanitizeJarName(bad), bad).toThrow();
    }
  });

  it('only downloads from allowlisted https hosts and refuses foreign redirects', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    const version = env.fake.versions[0];
    if (version?.files[0] === undefined) throw new Error('setup');

    version.files[0].url = 'https://evil.example/a.jar';
    let res = await install('A');
    expect(res.body.error.code).toBe('DOWNLOAD_URL_REJECTED');

    version.files[0].url = 'http://cdn.modrinth.com/a.jar';
    res = await install('A');
    expect(res.body.error.code).toBe('DOWNLOAD_URL_REJECTED');

    version.files[0].url = 'https://cdn.modrinth.com/data/A/versions/va/A-1.jar';
    env.fake.blobs.set(version.files[0].url, Buffer.from('jar:A:1'));
    env.fake.redirects.set(version.files[0].url, 'https://evil.example/payload');
    res = await install('A');
    expect(res.body.error.code).toBe('DOWNLOAD_URL_REJECTED');
    expect(env.fake.requests.some((u) => u.hostname === 'evil.example')).toBe(false);
    await noTraces();
  });

  it('follows redirects within the allowlist', async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z' });
    const url = env.fake.urlOf('va');
    const target = 'https://cdn.modrinth.com/data/redirected.jar';
    env.fake.blobs.set(target, env.fake.blobs.get(url) ?? Buffer.alloc(0));
    env.fake.redirects.set(url, target);
    const res = await install('A');
    expect(res.status).toBe(201);
  });
});

describe('removal', () => {
  beforeEach(async () => {
    env.fake.addVersion({ id: 'va', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', deps: [dep('B')] });
    env.fake.addVersion({ id: 'vb', projectId: 'B', number: '1', date: '2024-01-01T00:00:00Z' });
    await install('A');
  });

  it('blocks removal of a required mod unless forced', async () => {
    const b = (await rows()).find((m) => m.projectId === 'B');
    const blocked = await env.call<ErrorBody>('DELETE', `/api/servers/s1/mods/${b?.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('MOD_REQUIRED_BY_OTHERS');
    expect(blocked.body.error.details?.dependents?.map((d) => d.name)).toEqual(['Alpha']);
    expect(await env.files('s1')).toContain('B-1.jar');

    const forced = await env.call('DELETE', `/api/servers/s1/mods/${b?.id}?force=true`);
    expect(forced.status).toBe(200);
    expect(await env.files('s1')).toEqual(['A-1.jar']);
  });

  it('lists orphaned dependencies without deleting them', async () => {
    const a = (await rows()).find((m) => m.projectId === 'A');
    const res = await env.call<{ removed: Mod; orphaned: Mod[] }>('DELETE', `/api/servers/s1/mods/${a?.id}`);
    expect(res.status).toBe(200);
    expect(res.body.orphaned.map((m) => m.projectId)).toEqual(['B']);
    expect(await env.files('s1')).toEqual(['B-1.jar']);
    const left = await env.t.db.select().from(mods).where(eq(mods.projectId, 'B'));
    expect(left).toHaveLength(1);
  });
});
