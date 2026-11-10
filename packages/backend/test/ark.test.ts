import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseListPlayers } from '../src/games/ark/adapter.js';
import { getSectionValue, setSectionValue } from '../src/games/ark/ini.js';
import { decodePackets, encodePacket } from '../src/lib/rcon.js';
import { createInstallerRunner } from '../src/installer/runner.js';
import { realSpawner } from '../src/process/spawner.js';
import { SteamCmd } from '../src/steam/steamcmd.js';
import { FakeModrinth } from './fake-modrinth.js';
import { createTestDb, testConfig, type TestDb } from './helpers.js';
import { freePort, waitFor } from './server-env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('ARK helpers', () => {
  it('encodes and decodes RCON packets, also split across chunks', () => {
    const one = encodePacket(7, 2, 'ListPlayers');
    expect(one.readInt32LE(0)).toBe(10 + 'ListPlayers'.length);
    const both = Buffer.concat([one, encodePacket(8, 0, 'ok')]);
    const first = decodePackets(both.subarray(0, 20));
    expect(first.packets).toEqual([]);
    const all = decodePackets(both);
    expect(all.packets).toEqual([
      { id: 7, type: 2, body: 'ListPlayers' },
      { id: 8, type: 0, body: 'ok' },
    ]);
    expect(all.rest.length).toBe(0);
  });

  it('reads the player list', () => {
    expect(parseListPlayers('\n0. Bob, 76561198000000001\n1. Alice Smith, 76561198000000002\n ')).toEqual([
      { name: 'Bob', steamId: '76561198000000001' },
      { name: 'Alice Smith', steamId: '76561198000000002' },
    ]);
    expect(parseListPlayers('No Players Connected')).toEqual([]);
  });

  it('sets values inside their ini section', () => {
    const text = '[SessionSettings]\nSessionName=X\n\n[ServerSettings]\nServerPVE=True\n\n[/Script/Engine.GameSession]\nMaxPlayers=70\n';
    const next = setSectionValue(text, 'ServerSettings', 'ActiveMods', '1,2');
    expect(next).toBe('[SessionSettings]\nSessionName=X\n\n[ServerSettings]\nServerPVE=True\nActiveMods=1,2\n\n[/Script/Engine.GameSession]\nMaxPlayers=70\n');
    expect(getSectionValue(next, 'ServerSettings', 'ActiveMods')).toBe('1,2');
    expect(getSectionValue(setSectionValue(next, 'ServerSettings', 'ActiveMods', null), 'ServerSettings', 'ActiveMods')).toBeUndefined();
    expect(setSectionValue('', 'ServerSettings', 'ActiveMods', '5')).toBe('[ServerSettings]\nActiveMods=5\n');
  });
});

describe.runIf(process.platform === 'linux')('an ARK server', () => {
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
      readinessIntervalMs: 50,
      workshopApi: { details: async (ids) => ids.map((id) => ({ id, found: true, title: `Mod ${id}`, previewUrl: null, sizeBytes: 1, updatedAt: 1, modIds: [], mapFolders: [], forZomboid: false, appId: 346110 })) },
      steamCmd: new SteamCmd({ dir: path.join(t.dir, 'steamcmd'), runner: createInstallerRunner(realSpawner), configuredPath: steamScript }),
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await t.cleanup();
  });

  const call = async <T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => {
    const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: res.statusCode, body: res.json<T>() };
  };

  it('runs through RCON: ready, commands, players, kick by name, clean stop with SaveWorld, backup and mods', async () => {
    const rconPort = await freePort();
    const created = await call<{ server: { id: string; port: number; gameSettings: string } }>('POST', '/api/servers', { game: 'ark', name: 'Dino Land', map: 'Ragnarok', rconPort });
    expect(created.status).toBe(201);
    const id = created.body.server.id;
    const settings = JSON.parse(created.body.server.gameSettings) as { peerPort: number; queryPort: number; rconPort: number; adminPassword: string };
    expect(created.body.server.port).toBe(7777);
    expect(settings).toMatchObject({ peerPort: 7778, queryPort: 27015, rconPort });
    await waitFor(async () => (await call<{ server: { installState: string } }>('GET', `/api/servers/${id}`)).body.server.installState === 'installed' || undefined, 15_000);

    // mods go into GameUserSettings.ini and switch on -automanagedmods (SteamCMD is copied next to the engine)
    expect((await call('GET', '/api/ark/workshop/lookup?q=731604991')).body).toMatchObject({ item: { id: '731604991', title: 'Mod 731604991' } });
    const saved = await call<{ mods: Array<{ id: string }> }>('PUT', `/api/servers/${id}/ark-mods`, { mods: ['731604991', '1404697612'] });
    expect(saved.body.mods.map((mod) => mod.id)).toEqual(['731604991', '1404697612']);
    const gus = await readFile(path.join(t.dir, 'servers', id, 'server', 'ShooterGame', 'Saved', 'Config', 'LinuxServer', 'GameUserSettings.ini'), 'utf8');
    expect(getSectionValue(gus, 'ServerSettings', 'ActiveMods')).toBe('731604991,1404697612');

    const started = await call('POST', `/api/servers/${id}/start`);
    if (started.status !== 200) throw new Error(JSON.stringify(started.body));
    const status = async () => (await call<{ server: { status: { state: string; players: string[] } } }>('GET', `/api/servers/${id}`)).body.server.status;
    await waitFor(async () => (await status()).state === 'online' || undefined, 10_000).catch(async (error: unknown) => {
      const lines = (await call<{ lines: Array<{ text: string }> }>('GET', `/api/servers/${id}/console/history`)).body.lines.map((line) => line.text);
      throw new Error(`${String(error)} ${JSON.stringify(await status())} ${lines.join(' | ')}`);
    });
    const args = JSON.parse(await readFile(path.join(t.dir, 'servers', id, 'server', 'ShooterGame', 'Binaries', 'Linux', 'fake-ark-args.json'), 'utf8')) as string[];
    expect(args).toEqual([
      `Ragnarok?listen?SessionName=Dino Land?Port=7777?QueryPort=27015?MaxPlayers=70?RCONEnabled=True?RCONPort=${rconPort}?ServerAdminPassword=${settings.adminPassword}`,
      '-server',
      '-log',
      '-automanagedmods',
    ]);

    await waitFor(async () => (await status()).players.length === 2 || undefined, 10_000);
    expect((await status()).players).toEqual(['Bob', 'Alice Smith']);
    expect((await call('POST', `/api/servers/${id}/game-players/kick`, { name: 'Alice Smith' })).body).toEqual({ sent: 'KickPlayer 76561198000000002' });
    expect((await call('POST', `/api/servers/${id}/game-players/ban`, { name: 'Nobody' })).body).toMatchObject({ error: { code: 'PLAYER_ID_UNKNOWN' } });
    expect((await call('POST', `/api/servers/${id}/command`, { command: 'Broadcast hi' })).status).toBeLessThan(300);
    const history = (await call<{ lines: Array<{ text: string; stream: string }> }>('GET', `/api/servers/${id}/console/history`)).body.lines;
    expect(history.some((line) => line.stream === 'stdout' && line.text === 'Kicked 76561198000000002')).toBe(true);
    expect(history.some((line) => line.text.includes(settings.adminPassword))).toBe(false);

    await call('POST', `/api/servers/${id}/stop`);
    await waitFor(async () => (await status()).state === 'offline' || undefined, 10_000);
    await readFile(path.join(t.dir, 'servers', id, 'server', 'ShooterGame', 'Saved', 'SavedArks', 'Ragnarok.ark'), 'utf8');

    expect((await call('POST', `/api/servers/${id}/backups`, { includeConfig: true })).status).toBe(202);
    await waitFor(async () => (await call<{ backups: Array<{ status: string }> }>('GET', `/api/servers/${id}/backups`)).body.backups[0]?.status === 'ok' || undefined, 10_000);
    expect((await call<{ backups: Array<{ worlds: string[]; includesConfig: boolean }> }>('GET', `/api/servers/${id}/backups`)).body.backups[0]).toMatchObject({ worlds: ['SavedArks'], includesConfig: true });
  }, 60_000);

  it('refuses names that would break the command line and taken ports', async () => {
    expect((await call('POST', '/api/servers', { game: 'ark', name: 'a?b' })).status).toBe(400);
    const zomboid = await call<{ server: { port: number } }>('POST', '/api/servers', { game: 'zomboid', name: 'Knox', port: 7777 });
    expect(zomboid.status).toBe(201);
    const ark = await call<{ server: { port: number } }>('POST', '/api/servers', { game: 'ark', name: 'Ark' });
    expect(ark.body.server.port).toBe(7779);
    await waitFor(async () => (await call<{ servers: Array<{ installState: string }> }>('GET', '/api/servers')).body.servers.every((row) => row.installState !== 'installing' && row.installState !== 'pending') || undefined, 20_000);
  }, 60_000);
});
