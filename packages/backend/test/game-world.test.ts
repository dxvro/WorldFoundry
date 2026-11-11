import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { TarSource } from '../src/archive/tar.js';
import { writeZip } from '../src/archive/zip-writer.js';
import { readIniValues } from '../src/games/zomboid/ini.js';
import { createInstallerRunner } from '../src/installer/runner.js';
import { realSpawner } from '../src/process/spawner.js';
import { SteamCmd } from '../src/steam/steamcmd.js';
import { FakeModrinth } from './fake-modrinth.js';
import { createTestDb, testConfig, type TestDb } from './helpers.js';
import { freePort, waitFor } from './server-env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const now = Date.now();
const bytes = (name: string, data: string): TarSource => ({ kind: 'bytes', name, data: Buffer.from(data), mtimeMs: now, mode: 0o644 });
const dir = (name: string): TarSource => ({ kind: 'dir', name, mtimeMs: now, mode: 0o755 });

describe.runIf(process.platform === 'linux')('world export and import of Steam games', () => {
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
  const create = async (body: Record<string, unknown>): Promise<string> => {
    const created = await call<{ server: { id: string } }>('POST', '/api/servers', body);
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    const id = created.body.server.id;
    await waitFor(async () => (await call<{ server: { installState: string } }>('GET', `/api/servers/${id}`)).body.server.installState === 'installed' || undefined, 15_000);
    return id;
  };
  const exportOf = async (id: string, includeConfig = true): Promise<Buffer> => {
    const started = await call<{ export: { id: string } }>('POST', `/api/servers/${id}/exports`, { format: 'zip', includeConfig });
    if (started.status !== 202) throw new Error(JSON.stringify(started.body));
    await waitFor(async () => (await call<{ export: { status: string } }>('GET', `/api/exports/${started.body.export.id}`)).body.export.status === 'ready' || undefined, 10_000);
    return (await app.inject({ method: 'GET', url: `/api/exports/${started.body.export.id}/download` })).rawPayload;
  };
  const upload = async (id: string, fileName: string, payload: Buffer) => {
    const res = await app.inject({ method: 'POST', url: `/api/servers/${id}/game-world/import?fileName=${encodeURIComponent(fileName)}`, headers: { 'content-type': 'application/octet-stream' }, payload });
    return { status: res.statusCode, body: res.json<{ warnings: string[]; safety: unknown; imported: { worlds: string[] }; error?: { code: string } }>() };
  };
  const zipOf = async (sources: TarSource[]): Promise<Buffer> => {
    const file = path.join(t.dir, `upload-${Math.random()}.zip`);
    await writeZip(file, sources);
    return readFile(file);
  };

  it('Project Zomboid: an export moves to a server with another profile, keeps its ports, and a single-player save is found', async () => {
    const source = await create({ game: 'zomboid', name: 'Knox' });
    const data = (id: string): string => path.join(t.dir, 'servers', id, 'data');
    await mkdir(path.join(data(source), 'Saves', 'Multiplayer', 'servertest'), { recursive: true });
    await writeFile(path.join(data(source), 'Saves', 'Multiplayer', 'servertest', 'map_ver.bin'), 'world-1');
    await mkdir(path.join(data(source), 'db'), { recursive: true });
    await writeFile(path.join(data(source), 'db', 'servertest.db'), 'players-1');
    await writeFile(path.join(data(source), 'Server', 'servertest_SandboxVars.lua'), 'rules');
    const archive = await exportOf(source);

    const target = await create({ game: 'zomboid', name: 'Riverside', profile: 'river' });
    const targetSettings = JSON.parse((await call<{ server: { gameSettings: string; port: number } }>('GET', `/api/servers/${target}`)).body.server.gameSettings) as { udpPort: number };
    const targetPort = (await call<{ server: { port: number } }>('GET', `/api/servers/${target}`)).body.server.port;
    const imported = await upload(target, 'knox.zip', archive);
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    expect(await readFile(path.join(data(target), 'Saves', 'Multiplayer', 'river', 'map_ver.bin'), 'utf8')).toBe('world-1');
    expect(await readFile(path.join(data(target), 'db', 'river.db'), 'utf8')).toBe('players-1');
    expect(await readFile(path.join(data(target), 'Server', 'river_SandboxVars.lua'), 'utf8')).toBe('rules');
    const ini = readIniValues(await readFile(path.join(data(target), 'Server', 'river.ini'), 'utf8'));
    expect([ini.get('DefaultPort'), ini.get('UDPPort')]).toEqual([String(targetPort), String(targetSettings.udpPort)]);
    expect(imported.body.warnings.some((warning) => warning.includes('ports of this server'))).toBe(true);
    // the imported world is a backup now, and the world before it the safety copy
    const list = (await call<{ backups: Array<{ kind: string; note: string | null }> }>('GET', `/api/servers/${target}/backups`)).body.backups;
    expect(list.map((backup) => backup.kind).sort()).toEqual(['manual', 'safety']);
    expect(list.find((backup) => backup.kind === 'manual')?.note).toContain('knox.zip');

    // a single-player save in its Zomboid folder: the save and its player database, the settings of the server stay
    const native = await zipOf([
      dir('Zomboid'),
      dir('Zomboid/Saves'),
      dir('Zomboid/Saves/Sandbox'),
      dir('Zomboid/Saves/Sandbox/My World'),
      bytes('Zomboid/Saves/Sandbox/My World/map_ver.bin', 'world-2'),
      dir('Zomboid/db'),
      bytes('Zomboid/db/My World.db', 'players-2'),
    ]);
    const second = await upload(target, 'zomboid.zip', native);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await readFile(path.join(data(target), 'Saves', 'Multiplayer', 'river', 'map_ver.bin'), 'utf8')).toBe('world-2');
    expect(await readFile(path.join(data(target), 'db', 'river.db'), 'utf8')).toBe('players-2');
    expect(await readFile(path.join(data(target), 'Server', 'river_SandboxVars.lua'), 'utf8')).toBe('rules');

    // nothing usable, and a world of another game
    expect((await upload(target, 'empty.zip', await zipOf([bytes('readme.txt', 'hi')]))).body.error?.code).toBe('IMPORT_NO_WORLD');
    const ark = await create({ game: 'ark', name: 'Dino', rconPort: await freePort() });
    expect((await upload(ark, 'knox.zip', archive)).body.error?.code).toBe('IMPORT_WRONG_GAME');
  }, 60_000);

  it('Satisfactory: a single .sav and a zip of saves go into the session folder', async () => {
    const id = await create({ game: 'satisfactory', name: 'Factory' });
    const saveGames = path.join(t.dir, 'servers', id, 'home', '.config', 'Epic', 'FactoryGame', 'Saved', 'SaveGames');
    const single = await upload(id, 'My Factory_autosave_0.sav', Buffer.from('SAVE-1'));
    expect(single.status, JSON.stringify(single.body)).toBe(200);
    expect(await readFile(path.join(saveGames, 'server', 'My Factory_autosave_0.sav'), 'utf8')).toBe('SAVE-1');

    const zip = await zipOf([dir('a'), bytes('a/One.sav', 'S1'), dir('b'), bytes('b/One.sav', 'S2'), bytes('ServerSettings.7777.sav', 'not a save')]);
    const many = await upload(id, 'saves.zip', zip);
    expect(many.status, JSON.stringify(many.body)).toBe(200);
    expect((await readdir(path.join(saveGames, 'server'))).sort()).toEqual(['One.sav', 'One_2.sav']);
    expect(many.body.warnings.some((warning) => warning.includes('2 save game(s)'))).toBe(true);

    const archive = await exportOf(id, false);
    const other = await create({ game: 'satisfactory', name: 'Factory 2' });
    expect((await upload(other, 'factory.zip', archive)).status).toBe(200);
    expect((await readdir(path.join(t.dir, 'servers', other, 'home', '.config', 'Epic', 'FactoryGame', 'Saved', 'SaveGames', 'server'))).sort()).toEqual(['One.sav', 'One_2.sav']);
  }, 60_000);

  it('ARK: SavedArks from anywhere in the upload, with a warning when the map differs', async () => {
    const id = await create({ game: 'ark', name: 'Dino', map: 'Ragnarok', rconPort: await freePort() });
    const zip = await zipOf([
      dir('ShooterGame'),
      dir('ShooterGame/Saved'),
      dir('ShooterGame/Saved/SavedArks'),
      bytes('ShooterGame/Saved/SavedArks/TheIsland.ark', 'map'),
      bytes('ShooterGame/Saved/SavedArks/76561198000000001.arkprofile', 'player'),
      bytes('ShooterGame/Saved/SavedArks/1234.arktribe', 'tribe'),
      bytes('ShooterGame/Saved/SavedArks/notes.txt', 'skipped'),
    ]);
    const imported = await upload(id, 'ark.zip', zip);
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    const saved = path.join(t.dir, 'servers', id, 'server', 'ShooterGame', 'Saved', 'SavedArks');
    expect((await readdir(saved)).sort()).toEqual(['1234.arktribe', '76561198000000001.arkprofile', 'TheIsland.ark']);
    expect(imported.body.warnings.some((warning) => warning.includes('TheIsland') && warning.includes('Ragnarok'))).toBe(true);
  }, 60_000);
});
