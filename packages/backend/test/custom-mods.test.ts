import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { TarSource } from '../src/archive/tar.js';
import { writeZip } from '../src/archive/zip-writer.js';
import { getSectionValue } from '../src/games/ark/ini.js';
import { readIniValues } from '../src/games/zomboid/ini.js';
import { createInstallerRunner } from '../src/installer/runner.js';
import { realSpawner } from '../src/process/spawner.js';
import { SteamCmd } from '../src/steam/steamcmd.js';
import { FakeModrinth } from './fake-modrinth.js';
import { createTestDb, testConfig, type TestDb } from './helpers.js';
import { ModEnv } from './mod-env.js';
import { freePort, waitFor } from './server-env.js';
import { fabricJar } from './world-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const now = Date.now();
const bytes = (name: string, data: string | Buffer): TarSource => ({ kind: 'bytes', name, data: Buffer.isBuffer(data) ? data : Buffer.from(data), mtimeMs: now, mode: 0o644 });
const dir = (name: string): TarSource => ({ kind: 'dir', name, mtimeMs: now, mode: 0o755 });

describe('custom Minecraft mods', () => {
  let env: ModEnv;
  beforeEach(async () => {
    env = await ModEnv.create();
  });
  afterEach(async () => env.close());

  const upload = async (serverId: string, fileName: string, payload: Buffer) => {
    const res = await env.app.inject({ method: 'POST', url: `/api/servers/${serverId}/custom-mods?fileName=${encodeURIComponent(fileName)}`, headers: { 'content-type': 'application/octet-stream' }, payload });
    return { status: res.statusCode, body: res.json<{ installed?: Array<{ id: string }>; error?: { code: string } }>() };
  };

  it('puts an uploaded jar into mods/ and lists it like a mod placed by hand', async () => {
    await env.addServer('s1', { installState: 'installed' });
    const done = await upload('s1', 'my-own-mod.jar', fabricJar('ownmod'));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await env.files('s1')).toEqual(['my-own-mod.jar']);
    const listed = await env.call<{ mods: Array<{ fileName: string; source: string }> }>('GET', '/api/servers/s1/mods');
    expect(listed.body.mods.map((mod) => [mod.fileName, mod.source])).toEqual([['my-own-mod.jar', 'manual']]);

    expect((await upload('s1', 'my-own-mod.jar', fabricJar('ownmod'))).body.error?.code).toBe('MOD_ALREADY_INSTALLED');
    expect((await upload('s1', 'notes.txt', Buffer.from('x'))).body.error?.code).toBe('CUSTOM_MOD_INVALID');
    expect((await upload('s1', 'fake.jar', Buffer.from('not a zip'))).body.error?.code).toBe('CUSTOM_MOD_INVALID');
    env.running.add('s1');
    expect((await upload('s1', 'other.jar', fabricJar('other'))).body.error?.code).toBe('SERVER_RUNNING');
  });

  it('refuses Vanilla, which has no mod loader', async () => {
    await env.addServer('v1', { installState: 'installed', loader: 'vanilla' });
    expect((await env.call<{ supported: boolean }>('GET', '/api/servers/v1/custom-mods')).body.supported).toBe(false);
    expect((await upload('v1', 'x.jar', fabricJar('x'))).body.error?.code).toBe('MODS_NOT_SUPPORTED');
  });
});

describe.runIf(process.platform === 'linux')('custom mods of Steam games', () => {
  let t: TestDb;
  let app: FastifyInstance;
  beforeEach(async () => {
    t = await createTestDb();
    const steamScript = path.join(t.dir, 'steamcmd.sh');
    await writeFile(steamScript, `#!/bin/bash\nexec "${process.execPath}" "${path.join(HERE, 'fake-steamcmd.mjs')}" "$@"\n`);
    app = buildApp({
      db: t.db,
      config: testConfig(t.dir),
      modrinth: new FakeModrinth().api(),
      javaStandardRoots: [],
      portProbe: async () => 'free',
      udpProbe: async () => true,
      readinessIntervalMs: 50,
      workshopApi: { details: async (ids) => ids.map((id) => ({ id, found: true, title: `Mod ${id}`, previewUrl: null, sizeBytes: 1, updatedAt: 1, modIds: [], mapFolders: [], forZomboid: true, appId: 346110 })) },
      steamCmd: new SteamCmd({ dir: path.join(t.dir, 'steamcmd'), runner: createInstallerRunner(realSpawner), configuredPath: steamScript }),
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await t.cleanup();
  });

  const call = async <T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
    const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: res.statusCode, body: res.json<T>() };
  };
  const create = async (body: Record<string, unknown>): Promise<string> => {
    const created = await call<{ server: { id: string } }>('POST', '/api/servers', body);
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    const id = created.body.server.id;
    await waitFor(async () => (await call<{ server: { installState: string } }>('GET', `/api/servers/${id}`)).body.server.installState === 'installed' || undefined, 15_000);
    return id;
  };
  const upload = async (id: string, sources: TarSource[]) => {
    const file = path.join(t.dir, `mod-${Math.random()}.zip`);
    await writeZip(file, sources);
    const res = await app.inject({ method: 'POST', url: `/api/servers/${id}/custom-mods?fileName=mod.zip`, headers: { 'content-type': 'application/octet-stream' }, payload: await readFile(file) });
    return { status: res.statusCode, body: res.json<{ mods: Array<{ id: string; name: string; active: boolean | null }>; installed: Array<{ id: string }>; error?: { code: string } }>() };
  };
  type Listed = { supported: boolean; mods: Array<{ id: string; name: string; active: boolean | null; location: string }> };

  it('Project Zomboid: Build 41 and Build 42 mod folders go to data/mods and into Mods=, and stay there when the Workshop list is saved', async () => {
    const id = await create({ game: 'zomboid', name: 'Knox' });
    const ini = (): Promise<Map<string, string>> => readFile(path.join(t.dir, 'servers', id, 'data', 'Server', 'servertest.ini'), 'utf8').then(readIniValues);
    const first = await upload(id, [dir('MyMod'), bytes('MyMod/mod.info', 'name=My Mod\nid=MyMod\n'), dir('MyMod/media'), bytes('MyMod/media/x.lua', 'print(1)')]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await upload(id, [dir('Other'), dir('Other/42'), bytes('Other/42/mod.info', 'id=OtherMod\nname=Other\n'), dir('Other/common'), bytes('Other/common/a.txt', 'a')]);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect((await readdir(path.join(t.dir, 'servers', id, 'data', 'mods'))).sort()).toEqual(['MyMod', 'Other']);
    expect((await ini()).get('Mods')).toBe('MyMod;OtherMod');
    const listed = (await call<Listed>('GET', `/api/servers/${id}/custom-mods`)).body;
    expect(listed.mods.map((mod) => [mod.id, mod.name, mod.active, mod.location])).toEqual([
      ['MyMod', 'My Mod', true, 'data/mods/MyMod'],
      ['OtherMod', 'Other', true, 'data/mods/Other'],
    ]);

    // the Workshop list knows only Workshop mods; the uploaded ones stay active
    expect((await call('PUT', `/api/servers/${id}/workshop`, { items: ['111'], mods: ['WorkshopMod'], maps: ['Muldraugh, KY'] })).status).toBe(200);
    expect((await ini()).get('Mods')).toBe('WorkshopMod;MyMod;OtherMod');

    expect((await call<Listed>('DELETE', `/api/servers/${id}/custom-mods/MyMod`)).body.mods.map((mod) => mod.id)).toEqual(['OtherMod']);
    expect((await ini()).get('Mods')).toBe('WorkshopMod;OtherMod');
    expect((await upload(id, [bytes('readme.txt', 'no mod')])).body.error?.code).toBe('CUSTOM_MOD_INVALID');
  }, 60_000);

  it('Satisfactory: a plugin folder goes to FactoryGame/Mods under the plugin name', async () => {
    const id = await create({ game: 'satisfactory', name: 'Factory' });
    const done = await upload(id, [dir('build'), dir('build/MyTweaks'), bytes('build/MyTweaks/MyTweaks.uplugin', JSON.stringify({ FriendlyName: 'My Tweaks' })), dir('build/MyTweaks/Binaries')]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const modsDir = path.join(t.dir, 'servers', id, 'server', 'FactoryGame', 'Mods');
    expect(await readdir(path.join(modsDir, 'MyTweaks'))).toContain('MyTweaks.uplugin');
    expect((await call<Listed>('GET', `/api/servers/${id}/custom-mods`)).body.mods.map((mod) => [mod.id, mod.name, mod.active])).toEqual([['MyTweaks', 'My Tweaks', null]]);
    await call('DELETE', `/api/servers/${id}/custom-mods/MyTweaks`);
    expect(await readdir(modsDir).catch(() => [])).not.toContain('MyTweaks');
  }, 60_000);

  it('ARK: <id>.mod with its folder go to Content/Mods and ActiveMods, without -automanagedmods when only those are active', async () => {
    const rconPort = await freePort();
    const id = await create({ game: 'ark', name: 'Dino', rconPort });
    const done = await upload(id, [dir('Mods'), bytes('Mods/123456.mod', 'mod'), dir('Mods/123456'), bytes('Mods/123456/Thing.uasset', 'asset')]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const content = path.join(t.dir, 'servers', id, 'server', 'ShooterGame', 'Content', 'Mods');
    expect((await readdir(content)).sort()).toEqual(['123456', '123456.mod']);
    const gus = path.join(t.dir, 'servers', id, 'server', 'ShooterGame', 'Saved', 'Config', 'LinuxServer', 'GameUserSettings.ini');
    expect(getSectionValue(await readFile(gus, 'utf8'), 'ServerSettings', 'ActiveMods')).toBe('123456');

    // saving the Workshop list keeps the uploaded mod at the end
    await call('PUT', `/api/servers/${id}/ark-mods`, { mods: ['731604991'] });
    expect(getSectionValue(await readFile(gus, 'utf8'), 'ServerSettings', 'ActiveMods')).toBe('731604991,123456');
    await call('PUT', `/api/servers/${id}/ark-mods`, { mods: [] });
    expect(getSectionValue(await readFile(gus, 'utf8'), 'ServerSettings', 'ActiveMods')).toBe('123456');

    const started = await call('POST', `/api/servers/${id}/start`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await waitFor(async () => (await call<{ server: { status: { state: string } } }>('GET', `/api/servers/${id}`)).body.server.status.state === 'online' || undefined, 10_000);
    const args = JSON.parse(await readFile(path.join(t.dir, 'servers', id, 'server', 'ShooterGame', 'Binaries', 'Linux', 'fake-ark-args.json'), 'utf8')) as string[];
    expect(args).not.toContain('-automanagedmods');
    expect((await call('DELETE', `/api/servers/${id}/custom-mods/123456`)).body).toMatchObject({ error: { code: 'SERVER_RUNNING' } });
    await call('POST', `/api/servers/${id}/stop`);
    await waitFor(async () => (await call<{ server: { status: { state: string } } }>('GET', `/api/servers/${id}`)).body.server.status.state === 'offline' || undefined, 10_000);
    await call('DELETE', `/api/servers/${id}/custom-mods/123456`);
    expect(await readdir(content)).toEqual([]);
    expect(getSectionValue(await readFile(gus, 'utf8'), 'ServerSettings', 'ActiveMods') ?? null).toBeNull();
    await mkdir(content, { recursive: true });
  }, 60_000);
});
