import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { classifyZomboidLine } from '../src/games/zomboid/adapter.js';
import { readIniValues, setIniValues } from '../src/games/zomboid/ini.js';
import { createInstallerRunner } from '../src/installer/runner.js';
import { realSpawner } from '../src/process/spawner.js';
import { buildAppUpdateArgs, parseProgress, SteamCmd } from '../src/steam/steamcmd.js';
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

describe.runIf(linux)('a Project Zomboid server from creation to stop', () => {
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
    const steamArgs = JSON.parse(await readFile(path.join(HERE, '.last-steamcmd-args.json'), 'utf8')) as string[];
    expect(steamArgs).toEqual(['+force_install_dir', path.join(t.dir, 'servers', id, 'server'), '+login', 'anonymous', '+app_update', '380870', 'validate', '+quit']);
    const ini = readIniValues(await readFile(path.join(t.dir, 'servers', id, 'data', 'Server', 'servertest.ini'), 'utf8'));
    expect([ini.get('DefaultPort'), ini.get('UDPPort'), ini.get('PublicName')]).toEqual(['16261', '16262', 'Knox']);

    expect((await call('POST', `/api/servers/${id}/start`)).status).toBe(200);
    const status = async () => (await call<{ server: { status: { state: string; players: string[] } } }>('GET', `/api/servers/${id}`)).body.server.status;
    await waitFor(async () => (await status()).state === 'online' || undefined, 10_000);
    expect((await status()).players).toEqual(['Rick']);

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

  it('refuses the Minecraft-only parts of the API for its servers', async () => {
    const created = await call<{ server: { id: string } }>('POST', '/api/servers', { game: 'zomboid', name: 'Knox' });
    const id = created.body.server.id;
    for (const url of [`/api/servers/${id}/properties`, `/api/servers/${id}/players`, `/api/servers/${id}/backups`, `/api/servers/${id}/mods`]) {
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
