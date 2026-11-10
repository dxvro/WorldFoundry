import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pickVersion, type FicsitApi, type FicsitMod, type FicsitVersion } from '../src/games/satisfactory/ficsit.js';
import { createInstallerRunner } from '../src/installer/runner.js';
import { realSpawner } from '../src/process/spawner.js';
import { SteamCmd } from '../src/steam/steamcmd.js';
import { buildZip } from './archive-builders.js';
import { FakeModrinth } from './fake-modrinth.js';
import { createTestDb, testConfig, type TestDb } from './helpers.js';
import { waitFor } from './server-env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false);

const version = (v: string, extra: Partial<FicsitVersion> = {}): FicsitVersion => ({
  version: v,
  game_version: '>=491125',
  stability: 'release',
  targets: [
    { targetName: 'LinuxServer', link: `/v1/version/x/LinuxServer/${v}`, size: null, hash: null },
    { targetName: 'Windows', link: `/v1/version/x/Windows/${v}`, size: null, hash: null },
  ],
  dependencies: [],
  ...extra,
});

describe('choosing a ficsit.app version', () => {
  const mod: FicsitMod = {
    mod_reference: 'SML',
    name: 'Satisfactory Mod Loader',
    versions: [
      version('3.13.0-beta.1', { stability: 'beta' }),
      version('3.12.0'),
      version('3.11.3', { game_version: '>=416835' }),
      version('3.14.0', { game_version: '>=600000' }),
      version('3.10.0', { targets: [{ targetName: 'Windows', link: '/w', size: 1, hash: 'x' }] }),
    ],
  };

  it('takes the newest release for the server platform that fits the game build and the range', () => {
    expect(pickVersion(mod, 'LinuxServer', null, 491200)?.version).toBe('3.12.0');
    expect(pickVersion(mod, 'LinuxServer', '^3.11.0', 450000)?.version).toBe('3.11.3');
    expect(pickVersion(mod, 'LinuxServer', null, null)?.version).toBe('3.14.0');
    expect(pickVersion(mod, 'LinuxServer', '>=4.0.0', null)).toBeNull();
    expect(pickVersion(mod, 'WindowsServer', null, null)).toBeNull();
  });
});

describe.runIf(process.platform === 'linux')('a Satisfactory server', () => {
  let t: TestDb;
  let app: FastifyInstance;
  const files = new Map<string, Buffer>();
  const mods = new Map<string, FicsitMod>();
  const fakeApi: FicsitApi = {
    search: async (query) => ({ hits: [...mods.values()].filter((mod) => mod.name.toLowerCase().includes(query.toLowerCase())).map((mod) => ({ id: mod.mod_reference, mod_reference: mod.mod_reference, name: mod.name, short_description: 'summary', logo: null, downloads: 5 })), total: mods.size }),
    mod: async (reference) => {
      const mod = mods.get(reference);
      if (mod === undefined) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return mod;
    },
  };
  const addMod = (reference: string, name: string, versions: Array<{ v: string; deps?: FicsitVersion['dependencies']; game?: string }>): void => {
    mods.set(reference, {
      mod_reference: reference,
      name,
      versions: versions.map(({ v, deps, game }) => {
        const zip = buildZip([{ name: `${reference}.uplugin`, content: `{"VersionName":"${v}"}` }, { name: 'Binaries/LinuxServer/lib.so', content: `${reference}-${v}` }]);
        const link = `/v1/version/${reference}-${v}/LinuxServer/download`;
        files.set(`https://api.ficsit.app${link}`, zip);
        return { version: v, game_version: game ?? '>=491125', stability: 'release', targets: [{ targetName: 'LinuxServer', link, size: zip.length, hash: createHash('sha256').update(zip).digest('hex') }], dependencies: deps ?? [] };
      }),
    });
  };

  beforeEach(async () => {
    files.clear();
    mods.clear();
    t = await createTestDb();
    const steamScript = path.join(t.dir, 'steamcmd.sh');
    await writeFile(steamScript, `#!/bin/bash\nexec "${process.execPath}" "${path.join(HERE, 'fake-steamcmd.mjs')}" "$@"\n`);
    app = buildApp({
      db: t.db,
      config: testConfig(t.dir),
      modrinth: new FakeModrinth().api(),
      javaStandardRoots: [],
      portProbe: async () => 'free',
      steamCmd: new SteamCmd({ dir: path.join(t.dir, 'steamcmd'), runner: createInstallerRunner(realSpawner), configuredPath: steamScript }),
      satisfactoryHealth: async () => (await readdirReady(t.dir)),
      readinessIntervalMs: 50,
      ficsitApi: fakeApi,
      ficsitFetch: (async (input: string | URL | Request) => {
        const body = files.get(String(input));
        return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
      }) as typeof fetch,
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await t.cleanup();
  });

  // ready once the fake server wrote its marker
  const readdirReady = async (root: string): Promise<boolean> => {
    const { readdir } = await import('node:fs/promises');
    for (const id of await readdir(path.join(root, 'servers')).catch(() => [] as string[])) {
      if (await exists(path.join(root, 'servers', id, 'server', 'fake-satisfactory.ready'))) return true;
    }
    return false;
  };

  const call = async <T = Record<string, unknown>>(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) => {
    const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: res.statusCode, body: res.json<T>() };
  };

  const createInstalled = async (): Promise<string> => {
    const created = await call<{ server: { id: string; port: number; gameSettings: string } }>('POST', '/api/servers', { game: 'satisfactory', name: 'Factory' });
    expect(created.status).toBe(201);
    expect(created.body.server.port).toBe(7777);
    expect(JSON.parse(created.body.server.gameSettings)).toEqual({ branch: 'public', reliablePort: 8888 });
    const id = created.body.server.id;
    await waitFor(async () => (await call<{ server: { installState: string } }>('GET', `/api/servers/${id}`)).body.server.installState === 'installed' || undefined, 15_000);
    return id;
  };

  it('installs with SteamCMD, starts the binary with its own home, becomes ready through the health check and stops with SIGINT', async () => {
    const id = await createInstalled();
    const steamArgs = JSON.parse(await readFile(path.join(t.dir, 'servers', id, 'steamcmd-args.json'), 'utf8')) as string[];
    expect(steamArgs).toContain('1690800');
    expect((await call('POST', `/api/servers/${id}/start`)).status).toBe(200);
    const status = async () => (await call<{ server: { status: { state: string } } }>('GET', `/api/servers/${id}`)).body.server.status;
    await waitFor(async () => (await status()).state === 'online' || undefined, 10_000);
    const run = JSON.parse(await readFile(path.join(t.dir, 'servers', id, 'server', 'fake-satisfactory.json'), 'utf8')) as { args: string[]; home: string };
    expect(run.args).toEqual(['FactoryGame', '-Port=7777', '-ReliablePort=8888', '-log', '-unattended']);
    expect(run.home).toBe(path.join(t.dir, 'servers', id, 'home'));

    await call('POST', `/api/servers/${id}/stop`);
    await waitFor(async () => (await status()).state === 'offline' || undefined, 10_000);
    const history = (await call<{ lines: Array<{ text: string }> }>('GET', `/api/servers/${id}/console/history`)).body.lines.map((line) => line.text);
    expect(history).toContain('LogExit: Exiting.');

    // offline backup of the save games and the server settings
    expect((await call('POST', `/api/servers/${id}/backups`, { includeConfig: true })).status).toBe(202);
    await waitFor(async () => (await call<{ backups: Array<{ status: string }> }>('GET', `/api/servers/${id}/backups`)).body.backups[0]?.status === 'ok' || undefined, 10_000);
    expect((await call<{ backups: Array<{ worlds: string[]; includesConfig: boolean }> }>('GET', `/api/servers/${id}/backups`)).body.backups[0]).toMatchObject({ worlds: ['server'], includesConfig: true });

    const configs = await call<{ files: Array<{ key: string; path: string }> }>('GET', `/api/servers/${id}/config-files`);
    expect(configs.body.files.map((file) => file.path)).toEqual([
      'home/.config/Epic/FactoryGame/Saved/Config/LinuxServer/Game.ini',
      'home/.config/Epic/FactoryGame/Saved/Config/LinuxServer/Engine.ini',
      'home/.config/Epic/FactoryGame/Saved/Config/LinuxServer/GameUserSettings.ini',
    ]);
  }, 60_000);

  it('installs ficsit.app mods with the mod loader, keeps a fitting dependency and refuses to remove a needed one', async () => {
    const id = await createInstalled();
    addMod('SML', 'Satisfactory Mod Loader', [{ v: '3.12.0' }, { v: '3.11.3' }, { v: '9.0.0', game: '>=900000' }]);
    addMod('RefinedPower', 'Refined Power', [{ v: '2026.3.28', deps: [{ mod_reference: 'SML', condition: '^3.11.0', optional: false }, { mod_reference: 'Optional', condition: '*', optional: true }] }]);
    addMod('Other', 'Other Mod', [{ v: '1.0.0', deps: [{ mod_reference: 'SML', condition: '^3.12.0', optional: false }] }]);

    const view = await call<{ mods: unknown[]; gameBuild: number | null }>('GET', `/api/servers/${id}/ficsit/mods`);
    expect(view.body).toEqual({ mods: [], gameBuild: 491200 });
    expect((await call<{ hits: Array<{ reference: string; installed: boolean }> }>('GET', `/api/servers/${id}/ficsit/search?query=refined`)).body.hits).toEqual([expect.objectContaining({ reference: 'RefinedPower', installed: false })]);

    const installed = await call<{ installed: Array<{ reference: string; version: string; dependency: boolean }> }>('POST', `/api/servers/${id}/ficsit/mods`, { reference: 'RefinedPower' });
    expect(installed.status).toBe(201);
    expect(installed.body.installed.map((mod) => [mod.reference, mod.version, mod.dependency])).toEqual([
      ['RefinedPower', '2026.3.28', false],
      ['SML', '3.12.0', true],
    ]);
    const modsDir = path.join(t.dir, 'servers', id, 'server', 'FactoryGame', 'Mods');
    expect(await readFile(path.join(modsDir, 'SML', 'Binaries', 'LinuxServer', 'lib.so'), 'utf8')).toBe('SML-3.12.0');
    expect(await exists(path.join(modsDir, 'RefinedPower', 'RefinedPower.uplugin'))).toBe(true);

    // SML 3.12.0 already fits ^3.12.0: only the new mod is installed
    const second = await call<{ installed: Array<{ reference: string }> }>('POST', `/api/servers/${id}/ficsit/mods`, { reference: 'Other' });
    expect(second.body.installed.map((mod) => mod.reference)).toEqual(['Other']);

    expect((await call('DELETE', `/api/servers/${id}/ficsit/mods/SML`)).body).toMatchObject({ error: { code: 'MOD_REQUIRED_BY_OTHERS' } });
    expect((await call('DELETE', `/api/servers/${id}/ficsit/mods/Other`)).status).toBe(200);
    expect(await exists(path.join(modsDir, 'Other'))).toBe(false);
    expect((await call<{ mods: Array<{ reference: string }> }>('GET', `/api/servers/${id}/ficsit/mods`)).body.mods.map((mod) => mod.reference)).toEqual(['RefinedPower', 'SML']);
    expect((await call('POST', `/api/servers/${id}/ficsit/mods`, { reference: 'RefinedPower' })).body).toMatchObject({ error: { code: 'MOD_ALREADY_INSTALLED' } });
  }, 60_000);

  it('places the next server on the next free ports and refuses ficsit.app for other games', async () => {
    await createInstalled();
    const second = await call<{ server: { port: number; gameSettings: string } }>('POST', '/api/servers', { game: 'satisfactory', name: 'Second' });
    expect(second.body.server.port).toBe(7778);
    expect(JSON.parse(second.body.server.gameSettings)).toMatchObject({ reliablePort: 8889 });
    const zomboid = await call<{ server: { id: string } }>('POST', '/api/servers', { game: 'zomboid', name: 'Knox' });
    expect((await call('GET', `/api/servers/${zomboid.body.server.id}/ficsit/mods`)).body).toMatchObject({ error: { code: 'GAME_FEATURE_UNSUPPORTED' } });
    await waitFor(async () => (await call<{ servers: Array<{ installState: string }> }>('GET', '/api/servers')).body.servers.every((row) => row.installState !== 'installing' && row.installState !== 'pending') || undefined, 20_000);
  }, 60_000);
});
