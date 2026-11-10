import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { writeTarGz } from '../src/archive/tar.js';
import { classifyZomboidLine } from '../src/games/zomboid/adapter.js';
import { readIniValues, setIniValues } from '../src/games/zomboid/ini.js';
import { SteamWorkshopClient, mapFoldersOf, modIdsOf, workshopIdOf, type WorkshopDetails } from '../src/games/zomboid/workshop.js';
import { createInstallerRunner } from '../src/installer/runner.js';
import { realSpawner } from '../src/process/spawner.js';
import { buildAppUpdateArgs, parseProgress, STEAMCMD_DOWNLOAD, SteamCmd } from '../src/steam/steamcmd.js';
import { FakeModrinth } from './fake-modrinth.js';
import { createTestDb, testConfig, type TestDb } from './helpers.js';
import { waitFor } from './server-env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const linux = process.platform === 'linux';

describe('SteamCMD helpers', () => {
  it('puts force_install_dir before the anonymous login and adds the branch only when it is not public', () => {
    expect(buildAppUpdateArgs(380870, 'public', '/srv/x', true)).toEqual(['+force_install_dir', path.resolve('/srv/x'), '+login', 'anonymous', '+app_update', '380870', 'validate', '+quit']);
    expect(buildAppUpdateArgs(380870, 'unstable', '/srv/x', false)).toContain('-beta');
    expect(() => buildAppUpdateArgs(380870, '-beta', '/srv/x', false)).toThrowError(expect.objectContaining({ code: 'STEAM_BRANCH_INVALID' }));
    expect(() => buildAppUpdateArgs(380870, 'a b', '/srv/x', false)).toThrowError(expect.objectContaining({ code: 'STEAM_BRANCH_INVALID' }));
  });

  it('reads the progress of a download', () => {
    expect(parseProgress(' Update state (0x61) downloading, progress: 45.12 (1234 / 5678)')).toBe(45.12);
    expect(parseProgress(' Update state (0x81) verifying update, progress: 3.00 (1 / 2)')).toBe(3);
    expect(parseProgress('Success!')).toBeNull();
  });

  it('downloads SteamCMD from Valve into its folder on first use', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wf-steamcmd-'));
    try {
      const archive = path.join(root, 'steamcmd_linux.tar.gz');
      const now = Date.now();
      await writeTarGz(archive, [
        { kind: 'bytes', name: 'steamcmd.sh', data: Buffer.from('#!/bin/sh\n'), mtimeMs: now, mode: 0o755 },
        { kind: 'dir', name: 'linux32', mtimeMs: now, mode: 0o755 },
        { kind: 'bytes', name: 'linux32/steamcmd', data: Buffer.from('binary'), mtimeMs: now, mode: 0o644 },
      ]);
      const body = await readFile(archive);
      const requested: string[] = [];
      const fakeFetch = (async (url: string | URL | Request) => {
        requested.push(String(url));
        return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
      }) as typeof fetch;
      // the folder already exists from an earlier, failed attempt
      const dir = path.join(root, 'data', 'steamcmd');
      await mkdir(dir, { recursive: true });
      const lines: string[] = [];
      await new SteamCmd({ dir, platform: 'linux', fetch: fakeFetch, runner: createInstallerRunner(realSpawner) }).prepare(new AbortController().signal, (line) => lines.push(line));
      expect(requested).toEqual([STEAMCMD_DOWNLOAD.linux]);
      expect(await readFile(path.join(dir, 'steamcmd.sh'), 'utf8')).toBe('#!/bin/sh\n');
      expect(await readFile(path.join(dir, 'linux32', 'steamcmd'), 'utf8')).toBe('binary');
      expect(lines).toContain('SteamCMD is ready.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Project Zomboid helpers', () => {
  it('changes ini values in place and appends missing ones', () => {
    const text = '# comment\nPublicName=Old\nDefaultPort=1\nMaxPlayers=16\n';
    const next = setIniValues(text, { DefaultPort: '16261', UDPPort: '16262' });
    expect(next).toBe('# comment\nPublicName=Old\nDefaultPort=16261\nMaxPlayers=16\nUDPPort=16262\n');
    expect(readIniValues(next).get('UDPPort')).toBe('16262');
  });

  it('recognises the ready line and players', () => {
    expect(classifyZomboidLine('LOG  : General     , 1> *** SERVER STARTED ****')).toEqual({ type: 'done' });
    expect(classifyZomboidLine('ConnectionManager: [fully-connected] "" connection: guid=1 username="Rick" connection-type="UDPRakNet"')).toEqual({ type: 'join', name: 'Rick' });
    expect(classifyZomboidLine('ConnectionManager: [disconnect] "receive-disconnect" connection: guid=1 username="Rick"')).toEqual({ type: 'leave', name: 'Rick' });
    expect(classifyZomboidLine('Rick: *** SERVER STARTED ***')).toEqual({ type: 'done' });
  });
});

describe('Steam Workshop helpers', () => {
  it('reads ids from links and mod ids and map folders from descriptions', () => {
    expect(workshopIdOf('2392709985')).toBe('2392709985');
    expect(workshopIdOf('https://steamcommunity.com/sharedfiles/filedetails/?id=2392709985&searchtext=')).toBe('2392709985');
    expect(workshopIdOf('nope')).toBeNull();
    const text = 'Great mod\n[b]Workshop ID: 1[/b]\nMod ID: Hydrocraft\nModID:HydroExtra\nMap Folder: Raven Creek\nmod id: hydrocraft';
    expect(modIdsOf(text)).toEqual(['Hydrocraft', 'HydroExtra', 'hydrocraft']);
    expect(mapFoldersOf(text)).toEqual(['Raven Creek']);
  });

  it('asks GetPublishedFileDetails without a key and maps missing and foreign items', async () => {
    const sent: string[] = [];
    const client = new SteamWorkshopClient((async (input: string | URL | Request, init?: RequestInit) => {
      sent.push(`${String(input)} ${String(init?.body)}`);
      return new Response(
        JSON.stringify({
          response: {
            publishedfiledetails: [
              { publishedfileid: '1', result: 1, title: 'Alpha', description: 'Mod ID: alpha', file_size: '2048', time_updated: 100, consumer_app_id: 108600 },
              { publishedfileid: '2', result: 9 },
              { publishedfileid: '3', result: 1, title: 'Other game', consumer_app_id: 4000 },
            ],
          },
        }),
      );
    }) as typeof fetch);
    const details = await client.details(['1', '2', '3']);
    expect(sent[0]).toBe('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/ itemcount=3&publishedfileids%5B0%5D=1&publishedfileids%5B1%5D=2&publishedfileids%5B2%5D=3');
    expect(details.map((item) => [item.id, item.found, item.title, item.modIds, item.sizeBytes, item.updatedAt, item.forZomboid])).toEqual([
      ['1', true, 'Alpha', ['alpha'], 2048, 100_000, true],
      ['2', false, null, [], null, null, false],
      ['3', true, 'Other game', [], null, null, false],
    ]);
  });
});

describe.runIf(linux)('a Project Zomboid server from creation to stop', () => {
  let t: TestDb;
  let app: FastifyInstance;
  const workshop = new Map<string, WorkshopDetails>();
  beforeEach(async () => {
    workshop.clear();
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
      workshopApi: { details: async (ids) => ids.map((id) => workshop.get(id) ?? { id, found: false, title: null, previewUrl: null, sizeBytes: null, updatedAt: null, modIds: [], mapFolders: [], forZomboid: false, appId: null }) },
      steamCmd: new SteamCmd({ dir: path.join(t.dir, 'steamcmd'), runner: createInstallerRunner(realSpawner), configuredPath: steamScript }),
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await t.cleanup();
  });

  const call = async <T = Record<string, unknown>>(method: 'GET' | 'POST', url: string, body?: unknown) => {
    const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: res.statusCode, body: res.json<T>() };
  };

  it('installs with SteamCMD, writes the ports, starts with the admin password hidden and stops with quit', async () => {
    const created = await call<{ server: { id: string; game: string; port: number; gameSettings: string } }>('POST', '/api/servers', { game: 'zomboid', name: 'Knox' });
    expect(created.status).toBe(201);
    const { id } = created.body.server;
    expect(created.body.server).toMatchObject({ game: 'zomboid', port: 16261 });
    const settings = JSON.parse(created.body.server.gameSettings) as { profile: string; udpPort: number; adminPassword: string };
    expect(settings).toMatchObject({ profile: 'servertest', udpPort: 16262 });

    await waitFor(async () => (await call<{ server: { installState: string } }>('GET', `/api/servers/${id}`)).body.server.installState === 'installed' || undefined, 15_000);
    const steamArgs = JSON.parse(await readFile(path.join(t.dir, 'servers', id, 'steamcmd-args.json'), 'utf8')) as string[];
    expect(steamArgs).toEqual(['+force_install_dir', path.join(t.dir, 'servers', id, 'server'), '+login', 'anonymous', '+app_update', '380870', 'validate', '+quit']);
    const ini = readIniValues(await readFile(path.join(t.dir, 'servers', id, 'data', 'Server', 'servertest.ini'), 'utf8'));
    expect([ini.get('DefaultPort'), ini.get('UDPPort'), ini.get('PublicName')]).toEqual(['16261', '16262', 'Knox']);

    expect((await call('POST', `/api/servers/${id}/start`)).status).toBe(200);
    const status = async () => (await call<{ server: { status: { state: string; players: string[] } } }>('GET', `/api/servers/${id}`)).body.server.status;
    // the player line follows the ready line
    await waitFor(async () => ((await status()).state === 'online' && (await status()).players.length > 0) || undefined, 10_000);
    expect((await status()).players).toEqual(['Rick']);

    const players = await call<{ online: string[]; actions: Array<{ id: string; confirm: boolean }>; running: boolean }>('GET', `/api/servers/${id}/game-players`);
    expect(players.body).toMatchObject({ online: ['Rick'], running: true });
    expect(players.body.actions.map((action) => action.id)).toEqual(['kick', 'ban', 'unban', 'admin', 'user']);
    expect((await call('POST', `/api/servers/${id}/game-players/kick`, { name: 'Rick' })).body).toEqual({ sent: 'kickuser "Rick"' });
    expect((await call('POST', `/api/servers/${id}/game-players/ban`, { name: 'Ri"ck' })).body).toMatchObject({ error: { code: 'PLAYER_NAME_INVALID' } });
    expect((await call('POST', `/api/servers/${id}/game-players/explode`, { name: 'Rick' })).status).toBe(404);

    const args = JSON.parse(await readFile(path.join(t.dir, 'servers', id, 'server', 'fake-zomboid-args.json'), 'utf8')) as string[];
    expect(args).toEqual(['-servername', 'servertest', `-cachedir=${path.join(t.dir, 'servers', id, 'data')}`, '-adminpassword', settings.adminPassword]);
    const vm = JSON.parse(await readFile(path.join(t.dir, 'servers', id, 'server', 'ProjectZomboid64.json'), 'utf8')) as { vmArgs: string[] };
    expect(vm.vmArgs).toEqual(['-Djava.awt.headless=true', '-Xms1024m', '-Xmx4096m']);

    const history = (await call<{ lines: Array<{ text: string }> }>('GET', `/api/servers/${id}/console/history`)).body.lines.map((line) => line.text);
    expect(history.some((line) => line.includes('[hidden]'))).toBe(true);
    expect(history.some((line) => line.includes(settings.adminPassword))).toBe(false);

    await call('POST', `/api/servers/${id}/stop`);
    await waitFor(async () => (await status()).state === 'offline' || undefined, 10_000);

    // the second start finds the player database and does not pass the admin password again
    await call('POST', `/api/servers/${id}/start`);
    await waitFor(async () => (await status()).state === 'online' || undefined, 10_000);
    const again = JSON.parse(await readFile(path.join(t.dir, 'servers', id, 'server', 'fake-zomboid-args.json'), 'utf8')) as string[];
    expect(again).not.toContain('-adminpassword');
    await call('POST', `/api/servers/${id}/stop`);
    await waitFor(async () => (await status()).state === 'offline' || undefined, 10_000);
  }, 60_000);

  it('backs up Server, Saves and db while stopped, refuses while running, and restores with a safety copy', async () => {
    const created = await call<{ server: { id: string } }>('POST', '/api/servers', { game: 'zomboid', name: 'Knox' });
    const id = created.body.server.id;
    const data = path.join(t.dir, 'servers', id, 'data');
    const status = async () => (await call<{ server: { status: { state: string } } }>('GET', `/api/servers/${id}`)).body.server.status;
    await waitFor(async () => (await call<{ server: { installState: string } }>('GET', `/api/servers/${id}`)).body.server.installState === 'installed' || undefined, 15_000);
    await mkdir(path.join(data, 'Saves', 'Multiplayer', 'servertest'), { recursive: true });
    await writeFile(path.join(data, 'Saves', 'Multiplayer', 'servertest', 'map_1_1.bin'), 'original');

    await call('POST', `/api/servers/${id}/start`);
    await waitFor(async () => (await status()).state === 'online' || undefined, 10_000);
    expect((await call('POST', `/api/servers/${id}/backups`, {})).body).toMatchObject({ error: { code: 'BACKUP_NEEDS_STOP' } });
    await call('POST', `/api/servers/${id}/stop`);
    await waitFor(async () => (await status()).state === 'offline' || undefined, 10_000);

    const started = await call<{ backup: { id: string } }>('POST', `/api/servers/${id}/backups`, {});
    expect(started.status).toBe(202);
    const list = async () => (await call<{ backups: Array<{ id: string; status: string; kind: string; levelName: string; worlds: string[] }> }>('GET', `/api/servers/${id}/backups`)).body.backups;
    await waitFor(async () => (await list()).find((row) => row.id === started.body.backup.id)?.status === 'ok' || undefined, 10_000);
    expect((await list())[0]).toMatchObject({ levelName: 'servertest', worlds: ['Server', 'Saves', 'db'] });

    await writeFile(path.join(data, 'Saves', 'Multiplayer', 'servertest', 'map_1_1.bin'), 'changed');
    const restored = await call<{ safety: { kind: string } | null }>('POST', `/api/servers/${id}/backups/${started.body.backup.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.safety?.kind).toBe('safety');
    expect(await readFile(path.join(data, 'Saves', 'Multiplayer', 'servertest', 'map_1_1.bin'), 'utf8')).toBe('original');
    expect(await readFile(path.join(data, 'Server', 'servertest.ini'), 'utf8')).toContain('DefaultPort=16261');
  }, 60_000);

  it('edits its settings files as text while stopped, and the ports of the ini move the server', async () => {
    const created = await call<{ server: { id: string } }>('POST', '/api/servers', { game: 'zomboid', name: 'Knox' });
    const other = await call<{ server: { id: string } }>('POST', '/api/servers', { game: 'zomboid', name: 'Other', profile: 'other' });
    const id = created.body.server.id;
    await waitFor(async () => (await call<{ servers: Array<{ installState: string }> }>('GET', '/api/servers')).body.servers.every((row) => row.installState === 'installed') || undefined, 20_000);
    const put = (key: string, text: string) => app.inject({ method: 'PUT', url: `/api/servers/${id}/config-files/${key}`, payload: { text } }).then((res) => ({ status: res.statusCode, body: res.json<Record<string, unknown>>() }));

    const files = await call<{ files: Array<{ key: string; path: string; exists: boolean }> }>('GET', `/api/servers/${id}/config-files`);
    expect(files.body.files.map((file) => [file.key, file.path, file.exists])).toEqual([
      ['ini', 'data/Server/servertest.ini', true],
      ['sandbox', 'data/Server/servertest_SandboxVars.lua', false],
      ['spawnregions', 'data/Server/servertest_spawnregions.lua', false],
      ['spawnpoints', 'data/Server/servertest_spawnpoints.lua', false],
    ]);
    const ini = await call<{ text: string }>('GET', `/api/servers/${id}/config-files/ini`);
    expect(ini.body.text).toContain('UDPPort=16262');

    expect((await put('sandbox', 'SandboxVars = { Zombies = 4 }\n')).status).toBe(200);
    expect(await readFile(path.join(t.dir, 'servers', id, 'data', 'Server', 'servertest_SandboxVars.lua'), 'utf8')).toBe('SandboxVars = { Zombies = 4 }\n');

    // the other server holds 16263/16264
    expect((await put('ini', ini.body.text.replace('UDPPort=16262', 'UDPPort=16264'))).body).toMatchObject({ error: { code: 'PORT_IN_USE' } });
    expect((await put('ini', ini.body.text.replace('DefaultPort=16261', 'DefaultPort=99'))).body).toMatchObject({ error: { code: 'PORT_INVALID' } });
    expect((await put('ini', ini.body.text.replace('DefaultPort=16261', 'DefaultPort=17000').replace('UDPPort=16262', 'UDPPort=17001'))).status).toBe(200);
    const moved = (await call<{ server: { port: number; gameSettings: string } }>('GET', `/api/servers/${id}`)).body.server;
    expect([moved.port, (JSON.parse(moved.gameSettings) as { udpPort: number }).udpPort]).toEqual([17000, 17001]);

    await call('POST', `/api/servers/${id}/start`);
    await waitFor(async () => (await call<{ server: { status: { state: string } } }>('GET', `/api/servers/${id}`)).body.server.status.state === 'online' || undefined, 10_000);
    expect((await put('sandbox', 'x')).body).toMatchObject({ error: { code: 'SERVER_RUNNING' } });
    await call('POST', `/api/servers/${id}/stop`);
    await waitFor(async () => (await call<{ server: { status: { state: string } } }>('GET', `/api/servers/${id}`)).body.server.status.state === 'offline' || undefined, 10_000);
    expect((await call('GET', `/api/servers/${id}/config-files/nope`)).status).toBe(404);
    expect(other.status).toBe(201);
  }, 60_000);

  it('keeps the Workshop items, mod ids and maps of the ini in order', async () => {
    const item = (id: string, title: string, modIds: string[], mapFolders: string[] = []): WorkshopDetails => ({ id, found: true, title, previewUrl: null, sizeBytes: 10, updatedAt: 1, modIds, mapFolders, forZomboid: true, appId: 108600 });
    workshop.set('111', item('111', 'Brita Weapons', ['Brita']));
    workshop.set('222', item('222', 'Raven Creek', ['RavenCreek'], ['RavenCreek']));
    workshop.set('333', { ...item('333', 'Not PZ', []), forZomboid: false });
    const created = await call<{ server: { id: string } }>('POST', '/api/servers', { game: 'zomboid', name: 'Knox' });
    const id = created.body.server.id;
    await waitFor(async () => (await call<{ server: { installState: string } }>('GET', `/api/servers/${id}`)).body.server.installState === 'installed' || undefined, 15_000);

    expect((await call('GET', `/api/servers/${id}/workshop`)).body).toEqual({ items: [], mods: [], maps: ['Muldraugh, KY'], detailsError: null });
    expect((await call('GET', '/api/workshop/lookup?q=https%3A%2F%2Fsteamcommunity.com%2Fsharedfiles%2Ffiledetails%2F%3Fid%3D222')).body).toMatchObject({ item: { id: '222', modIds: ['RavenCreek'], mapFolders: ['RavenCreek'] } });
    expect((await call('GET', '/api/workshop/lookup?q=999')).body).toMatchObject({ error: { code: 'WORKSHOP_NOT_FOUND' } });
    expect((await call('GET', '/api/workshop/lookup?q=333')).body).toMatchObject({ error: { code: 'WORKSHOP_WRONG_GAME' } });
    expect((await call('GET', '/api/workshop/lookup?q=hello')).body).toMatchObject({ error: { code: 'WORKSHOP_ID_INVALID' } });

    const saved = await app.inject({ method: 'PUT', url: `/api/servers/${id}/workshop`, payload: { items: ['222', '111', '111'], mods: ['RavenCreek', 'Brita'], maps: ['RavenCreek', 'Muldraugh, KY'] } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ items: [{ id: '222', title: 'Raven Creek' }, { id: '111', title: 'Brita Weapons' }], mods: ['RavenCreek', 'Brita'], maps: ['RavenCreek', 'Muldraugh, KY'] });
    const ini = readIniValues(await readFile(path.join(t.dir, 'servers', id, 'data', 'Server', 'servertest.ini'), 'utf8'));
    expect([ini.get('WorkshopItems'), ini.get('Mods'), ini.get('Map'), ini.get('DefaultPort')]).toEqual(['222;111', 'RavenCreek;Brita', 'RavenCreek;Muldraugh, KY', '16261']);
    expect((await app.inject({ method: 'PUT', url: `/api/servers/${id}/workshop`, payload: { items: ['abc'], mods: [], maps: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/servers/${id}/workshop`, payload: { items: [], mods: ['a;b'], maps: [] } })).statusCode).toBe(400);
  }, 60_000);

  it('refuses the Minecraft-only parts of the API for its servers', async () => {
    const created = await call<{ server: { id: string } }>('POST', '/api/servers', { game: 'zomboid', name: 'Knox' });
    const id = created.body.server.id;
    for (const url of [`/api/servers/${id}/properties`, `/api/servers/${id}/players`, `/api/servers/${id}/mods`]) {
      expect((await call('GET', url)).body, url).toMatchObject({ error: { code: 'GAME_FEATURE_UNSUPPORTED', params: { game: 'Project Zomboid' } } });
    }
    expect((await call('GET', `/api/servers/${id}/console/history`)).status).toBe(200);
    await waitFor(async () => (await call<{ server: { installState: string } }>('GET', `/api/servers/${id}`)).body.server.installState !== 'installing' || undefined, 15_000);
  }, 60_000);

  it('gives the next server the next free pair of ports and refuses a taken one', async () => {
    const first = await call<{ server: { id: string } }>('POST', '/api/servers', { game: 'zomboid', name: 'A' });
    const second = await call<{ server: { port: number; gameSettings: string } }>('POST', '/api/servers', { game: 'zomboid', name: 'B', profile: 'second' });
    expect(second.body.server.port).toBe(16263);
    expect(JSON.parse(second.body.server.gameSettings)).toMatchObject({ udpPort: 16264 });
    expect((await call('POST', '/api/servers', { game: 'zomboid', name: 'C', port: 16262 })).body).toMatchObject({ error: { code: 'PORT_IN_USE' } });
    expect((await call('POST', '/api/servers', { game: 'zomboid', name: 'D', profile: 'bad name' })).status).toBe(400);
    await waitFor(async () => (await call<{ server: { installState: string } }>('GET', `/api/servers/${first.body.server.id}`)).body.server.installState !== 'installing' || undefined, 15_000);
  }, 60_000);
});
