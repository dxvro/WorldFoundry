import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packTarget, PackIndexSchema } from '../src/modpacks/mrpack.js';
import { buildZip } from './archive-builders.js';
import { sha512Of } from './fake-modrinth.js';
import { ServerEnv } from './server-env.js';

interface ServerBody {
  server: {
    id: string;
    loader: string;
    mcVersion: string;
    loaderVersion: string | null;
    installState: string;
    installError: string | null;
    modpack: { projectId: string; versionId: string; title: string; versionNumber: string } | null;
  };
}
interface ErrorBody {
  error: { code: string; params?: Record<string, unknown> };
}

let env: ServerEnv;
beforeEach(async () => {
  env = await ServerEnv.create();
});
afterEach(async () => {
  await env.close();
});

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );
const sha1 = (data: Buffer | string): string => createHash('sha1').update(data).digest('hex');

interface PackFileInput {
  path: string;
  content: string;
  server?: 'required' | 'optional' | 'unsupported';
  url?: string;
  badHash?: boolean;
}

// a mod on the fake Modrinth, so the scan after the installation can identify it
function addMod(projectId: string): { fileName: string; content: string } {
  env.modrinth.addProject(projectId, `Mod ${projectId}`);
  const fileName = `${projectId}-1.0.jar`;
  const content = `jar:${projectId}`;
  env.modrinth.addVersion({ id: `v-${projectId}`, projectId, number: '1.0', date: '2024-01-01T00:00:00Z', fileName, content });
  return { fileName, content };
}

function addPack(options: { files: PackFileInput[]; dependencies?: Record<string, string>; overrides?: Record<string, string>; serverOverrides?: Record<string, string> }): { projectId: string; versionId: string } {
  const files = options.files.map((file) => {
    const url = file.url ?? `https://cdn.modrinth.com/data/files/${encodeURIComponent(file.path)}`;
    env.modrinth.blobs.set(url, Buffer.from(file.content));
    return {
      path: file.path,
      hashes: { sha1: sha1(file.content), sha512: file.badHash === true ? sha512Of('other') : sha512Of(file.content) },
      env: { client: 'required', server: file.server ?? 'required' },
      downloads: [url],
      fileSize: Buffer.byteLength(file.content),
    };
  });
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '2.0.0',
    name: 'Test Pack',
    files,
    dependencies: options.dependencies ?? { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
  };
  const entries = [
    { name: 'modrinth.index.json', content: JSON.stringify(index) },
    ...Object.entries(options.overrides ?? {}).map(([name, content]) => ({ name: `overrides/${name}`, content })),
    ...Object.entries(options.serverOverrides ?? {}).map(([name, content]) => ({ name: `server-overrides/${name}`, content })),
  ];
  env.modrinth.addProject('PACK', 'Test Pack');
  const project = env.modrinth.projects.get('PACK');
  if (project !== undefined) project.project_type = 'modpack';
  const version = env.modrinth.addVersion({
    id: 'packv2',
    projectId: 'PACK',
    number: '2.0.0',
    date: '2024-02-01T00:00:00Z',
    fileName: 'Test Pack 2.0.0.mrpack',
    loaders: ['fabric'],
  });
  // addVersion stores the content as text; the pack is binary
  const zip = buildZip(entries);
  const file = version.files[0];
  if (file !== undefined) {
    env.modrinth.blobs.set(file.url, zip);
    file.hashes.sha512 = sha512Of(zip);
    file.size = zip.length;
  }
  return { projectId: 'PACK', versionId: 'packv2' };
}

const create = (modpack: { projectId: string; versionId: string }) =>
  env.call<ServerBody & ErrorBody>('POST', '/api/servers', { name: 'Pack server', modpack, eulaAccepted: true });
const settled = async (id: string): Promise<ServerBody['server']> => {
  await env.services.install.idle();
  return (await env.call<ServerBody>('GET', `/api/servers/${id}`)).body.server;
};

describe('the pack index', () => {
  const base = { formatVersion: 1, game: 'minecraft', versionId: '1', name: 'x', files: [] };
  it('maps the dependencies to a loader', () => {
    expect(packTarget(PackIndexSchema.parse({ ...base, dependencies: { minecraft: '1.20.1', forge: '47.3.0' } }))).toEqual({ loader: 'forge', mcVersion: '1.20.1', loaderVersion: '47.3.0' });
    expect(packTarget(PackIndexSchema.parse({ ...base, dependencies: { minecraft: '1.21.1', neoforge: '21.1.77' } }))).toEqual({ loader: 'neoforge', mcVersion: '1.21.1', loaderVersion: '21.1.77' });
    expect(packTarget(PackIndexSchema.parse({ ...base, dependencies: { minecraft: '1.21.1' } }))).toEqual({ loader: 'vanilla', mcVersion: '1.21.1', loaderVersion: null });
    expect(() => packTarget(PackIndexSchema.parse({ ...base, dependencies: { minecraft: '1.21.1', 'quilt-loader': '0.26.0' } }))).toThrow(/Quilt/);
    expect(() => packTarget(PackIndexSchema.parse({ ...base, dependencies: { 'fabric-loader': '0.16.14' } }))).toThrow(/Minecraft version/);
  });
});

describe('modpack search and versions', () => {
  it('lists packs and their versions', async () => {
    addPack({ files: [] });
    const search = await env.call<{ hits: Array<{ projectId: string }> }>('GET', '/api/modpacks/search?query=pack');
    expect(search.status).toBe(200);
    expect(search.body.hits.map((hit) => hit.projectId)).toContain('PACK');
    const searchUrl = env.modrinth.searchRequests().at(-1);
    expect(searchUrl?.searchParams.get('facets')).toContain('project_type:modpack');

    const versions = await env.call<{ versions: Array<{ id: string; loaders: string[]; supported: boolean }> }>('GET', '/api/modpacks/PACK/versions');
    expect(versions.status).toBe(200);
    expect(versions.body.versions).toEqual([expect.objectContaining({ id: 'packv2', loaders: ['fabric'], supported: true })]);
  });

  it('refuses a project that is not a modpack', async () => {
    env.modrinth.addProject('MOD', 'Just a mod');
    const res = await env.call<ErrorBody>('GET', '/api/modpacks/MOD/versions');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODPACK_NOT_A_PACK');
  });
});

describe('creating a server from a modpack', () => {
  it('installs the loader, the server files and the overrides, and registers the mods', async () => {
    const mod = addMod('MODA');
    const pack = addPack({
      files: [
        { path: `mods/${mod.fileName}`, content: mod.content },
        { path: 'mods/shaders-client.jar', content: 'client only', server: 'unsupported' },
        { path: 'config/extra/settings.json', content: '{"a":1}', server: 'optional' },
      ],
      overrides: { 'config/pack.toml': 'shared = true', 'config/side.toml': 'side = "client"' },
      serverOverrides: { 'config/side.toml': 'side = "server"' },
    });

    const res = await create(pack);
    expect(res.status).toBe(201);
    expect(res.body.server).toMatchObject({ loader: 'fabric', mcVersion: '1.21.1', loaderVersion: '0.16.14', modpack: { projectId: 'PACK', versionId: 'packv2', title: 'Test Pack', versionNumber: '2.0.0' } });

    const done = await settled(res.body.server.id);
    expect(done.installError).toBeNull();
    expect(done.installState).toBe('installed');
    const dir = env.serverDir(done.id);
    expect(await readFile(path.join(dir, 'mods', mod.fileName), 'utf8')).toBe(mod.content);
    expect(await exists(path.join(dir, 'mods', 'shaders-client.jar'))).toBe(false);
    expect(await readFile(path.join(dir, 'config', 'extra', 'settings.json'), 'utf8')).toBe('{"a":1}');
    expect(await readFile(path.join(dir, 'config', 'pack.toml'), 'utf8')).toBe('shared = true');
    expect(await readFile(path.join(dir, 'config', 'side.toml'), 'utf8')).toBe('side = "server"');
    expect(await readdir(dir)).not.toContain('.modpack');

    const mods = await env.call<{ mods: Array<{ projectId: string | null; fileName: string }> }>('GET', `/api/servers/${done.id}/mods`);
    expect(mods.body.mods).toEqual([expect.objectContaining({ projectId: 'MODA', fileName: mod.fileName })]);
  });

  it('fails the installation when a file does not match its checksum', async () => {
    const pack = addPack({ files: [{ path: 'mods/broken.jar', content: 'broken', badHash: true }] });
    const res = await create(pack);
    expect(res.status).toBe(201);
    const done = await settled(res.body.server.id);
    expect(done.installState).toBe('failed');
    expect(done.installError).toMatch(/checksum/);
  });

  it('refuses downloads from hosts the format does not allow', async () => {
    const pack = addPack({ files: [{ path: 'mods/evil.jar', content: 'evil', url: 'https://evil.example/evil.jar' }] });
    const done = await settled((await create(pack)).body.server.id);
    expect(done.installState).toBe('failed');
    expect(done.installError).toMatch(/evil\.example/);
  });

  it('refuses a pack with a path outside the server folder and leaves no folder behind', async () => {
    const pack = addPack({ files: [{ path: '../escape.jar', content: 'x' }] });
    const before = await readdir(env.config.serversDir);
    const res = await create(pack);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ARCHIVE_UNSAFE');
    expect(await readdir(env.config.serversDir)).toEqual(before);
  });

  it('refuses a Quilt pack', async () => {
    const pack = addPack({ files: [], dependencies: { minecraft: '1.21.1', 'quilt-loader': '0.26.0' } });
    const res = await create(pack);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'MODPACK_LOADER_UNSUPPORTED', params: { loader: 'Quilt' } });
  });

  it('refuses a version of another project', async () => {
    addPack({ files: [] });
    const res = await create({ projectId: 'OTHER', versionId: 'packv2' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODPACK_VERSION_MISMATCH');
  });

  it('still needs a loader and a version without a pack', async () => {
    const res = await env.call<ErrorBody>('POST', '/api/servers', { name: 'Plain' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
