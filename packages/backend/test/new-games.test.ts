import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { servers } from '../src/db/schema.js';
import type { TarSource } from '../src/archive/tar.js';
import { writeZip } from '../src/archive/zip-writer.js';
import { setOptions } from '../src/games/palworld/adapter.js';
import { classifySevenDaysLine, setProperties } from '../src/games/sevendays/adapter.js';
import { classifyTerrariaLine, TERRARIA_LIST_URL, terrariaDownloadUrl, writeConfig } from '../src/games/terraria/adapter.js';
import { classifyValheimLine } from '../src/games/valheim/adapter.js';
import { allocatePorts } from '../src/games/steam-game.js';
import { parseInfo } from '../src/lib/a2s.js';
import { cleanAnswer } from '../src/lib/telnet.js';
import { createInstallerRunner } from '../src/installer/runner.js';
import { realSpawner } from '../src/process/spawner.js';
import { buildAppUpdateArgs, SteamCmd } from '../src/steam/steamcmd.js';
import { FakeModrinth } from './fake-modrinth.js';
import { FakeThunderstore } from './fake-thunderstore.js';
import { createTestDb, testConfig, type TestDb } from './helpers.js';
import { freePort, waitFor } from './server-env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('helpers of the newer games', () => {
  it('finds a free block of ports and refuses a taken one', () => {
    expect(allocatePorts(undefined, 2456, [0, 1], new Set([2457]))).toBe(2458);
    expect(allocatePorts(undefined, 26900, [0, 1, 2], new Set())).toBe(26900);
    expect(() => allocatePorts(26900, 26900, [0, 1, 2], new Set([26902]))).toThrowError(expect.objectContaining({ code: 'PORT_IN_USE' }));
  });

  it('asks SteamCMD for the Windows files when told to', () => {
    expect(buildAppUpdateArgs(2430930, 'public', '/srv/a', true, 'windows').slice(0, 2)).toEqual(['+@sSteamCmdForcePlatformType', 'windows']);
    expect(buildAppUpdateArgs(896660, 'public', '/srv/v', true)[0]).toBe('+force_install_dir');
  });

  it('writes the config formats and keeps what the user added', () => {
    const xml = setProperties('<ServerSettings>\n\t<property name="ServerName" value="Old"/>\n\t<property name="DayNightLength" value="60"/>\n</ServerSettings>\n', { ServerName: 'A & "B"', TelnetPort: '8081' });
    expect(xml).toContain('<property name="ServerName" value="A &amp; &quot;B&quot;"/>');
    expect(xml).toContain('<property name="DayNightLength" value="60"/>');
    expect(xml).toContain('<property name="TelnetPort" value="8081"/>\n</ServerSettings>');

    const ini = setOptions('[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,ServerName="Default",AdminPassword="",RESTAPIEnabled=False)\n', { ServerName: 'My "Pals"', RESTAPIEnabled: true, RESTAPIPort: 8212 });
    expect(ini).toContain('OptionSettings=(Difficulty=None,ServerName="My Pals",AdminPassword="",RESTAPIEnabled=True,RESTAPIPort=8212)');
    expect(setOptions('', { PublicPort: 8211 })).toBe('[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(PublicPort=8211)\n');

    const config = writeConfig('motd=Hello\nport=1\n#password=old\n', { port: '7777', password: 'x' });
    expect(config).toBe('motd=Hello\nport=7777\n#password=old\npassword=x\n');
  });

  it('reads ready lines and players from the logs', () => {
    expect(classifyValheimLine('11/12/2026 20:00:01: Game server connected')).toEqual({ type: 'done' });
    expect(classifyValheimLine('11/12/2026 20:00:02: Got character ZDOID from Ragnar Lothbrok : 123:1')).toEqual({ type: 'join', name: 'Ragnar Lothbrok' });
    expect(classifyTerrariaLine('Server started')).toEqual({ type: 'done' });
    expect(classifyTerrariaLine(': Bob has joined.')).toEqual({ type: 'join', name: 'Bob' });
    expect(classifyTerrariaLine('Bob has left.')).toEqual({ type: 'leave', name: 'Bob' });
    expect(classifySevenDaysLine('2026-12-31T00:00:00 1.000 INF StartGame done')).toEqual({ type: 'done' });
    expect(classifySevenDaysLine("INF Player disconnected: EntityID=171, PltfmId='Steam_1', PlayerName='Bob', ClientNumber='1'")).toEqual({ type: 'leave', name: 'Bob' });
    expect(cleanAnswer("lp\r\n2026-12-31T00:00:00 1.000 INF Executing command 'lp' by Telnet from 127.0.0.1\r\nTotal of 0 in the game\r\n", 'lp')).toBe('Total of 0 in the game');
  });

  it('parses the Steam query answer', () => {
    const packet = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 0x11]), Buffer.from('My Server\0Map\0valheim\0Valheim\0', 'utf8'), Buffer.from([0x00, 0x00, 3, 10])]);
    expect(parseInfo(packet)).toEqual({ name: 'My Server', map: 'Map', players: 3, maxPlayers: 10 });
    expect(parseInfo(Buffer.from([1, 2, 3]))).toBeNull();
  });
});

describe.runIf(process.platform === 'linux')('servers of the newer games', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let terrariaZip: Buffer;
  const requested: string[] = [];
  let thunderstore: FakeThunderstore;

  beforeEach(async () => {
    t = await createTestDb();
    const steamScript = path.join(t.dir, 'steamcmd.sh');
    await writeFile(steamScript, `#!/bin/bash\nexec "${process.execPath}" "${path.join(HERE, 'fake-steamcmd.mjs')}" "$@"\n`);
    const zipFile = path.join(t.dir, 'terraria.zip');
    const now = Date.now();
    const sources: TarSource[] = [
      { kind: 'dir', name: '1458', mtimeMs: now, mode: 0o755 },
      { kind: 'dir', name: '1458/Linux', mtimeMs: now, mode: 0o755 },
      { kind: 'bytes', name: '1458/Linux/TerrariaServer.bin.x86_64', data: Buffer.from(`#!/bin/bash\nexec "${process.execPath}" "${path.join(HERE, 'fake-terraria.mjs')}" "$@"\n`), mtimeMs: now, mode: 0o755 },
      { kind: 'dir', name: '1458/Windows', mtimeMs: now, mode: 0o755 },
      { kind: 'bytes', name: '1458/Windows/TerrariaServer.exe', data: Buffer.from('MZ'), mtimeMs: now, mode: 0o644 },
    ];
    await writeZip(zipFile, sources);
    terrariaZip = await readFile(zipFile);
    requested.length = 0;
    thunderstore = new FakeThunderstore();
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url === TERRARIA_LIST_URL) return new Response(JSON.stringify(['terraria-server-1458.zip', 'terraria-server-1458.zip']));
      if (url === terrariaDownloadUrl('terraria-server-1458.zip')) return new Response(terrariaZip, { headers: { 'content-length': String(terrariaZip.length) } });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    app = buildApp({
      db: t.db,
      config: testConfig(t.dir),
      modrinth: new FakeModrinth().api(),
      javaStandardRoots: [],
      portProbe: async () => 'free',
      udpProbe: async () => true,
      readinessIntervalMs: 50,
      fetch: fakeFetch,
      valheimPlayers: async () => 1,
      thunderstoreApi: thunderstore.api,
      thunderstoreFetch: thunderstore.fetch,
      steamCmd: new SteamCmd({ dir: path.join(t.dir, 'steamcmd'), runner: createInstallerRunner(realSpawner), configuredPath: steamScript }),
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await t.cleanup();
  });

  type ServerBody = { id: string; port: number; gameSettings: string; installState: string; status: { state: string; players: string[]; playerCount: number | null } };
  const call = async <T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => {
    const res = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body as object }) });
    return { status: res.statusCode, body: res.json<T>() };
  };
  const server = async (id: string): Promise<ServerBody> => (await call<{ server: ServerBody }>('GET', `/api/servers/${id}`)).body.server;
  const create = async (body: Record<string, unknown>): Promise<ServerBody> => {
    const created = await call<{ server: ServerBody }>('POST', '/api/servers', body);
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    const id = created.body.server.id;
    await waitFor(async () => (await server(id)).installState === 'installed' || undefined, 15_000).catch(async () => {
      throw new Error(`install: ${await readFile(path.join(t.dir, 'servers', id, 'install.log'), 'utf8').catch(() => '')}`);
    });
    return server(id);
  };
  const runOnce = async (id: string, check: (online: ServerBody) => Promise<void>): Promise<void> => {
    const started = await call('POST', `/api/servers/${id}/start`);
    if (started.status !== 200) throw new Error(JSON.stringify(started.body));
    await waitFor(async () => (await server(id)).status.state === 'online' || undefined, 10_000).catch(async () => {
      const lines = (await call<{ lines: Array<{ text: string }> }>('GET', `/api/servers/${id}/console/history`)).body.lines.map((line) => line.text);
      throw new Error(`not online: ${JSON.stringify((await server(id)).status)} ${lines.join(' | ')}`);
    });
    await check(await server(id));
    await call('POST', `/api/servers/${id}/stop`);
    await waitFor(async () => (await server(id)).status.state === 'offline' || undefined, 10_000);
  };
  const dir = (id: string, ...parts: string[]): string => path.join(t.dir, 'servers', id, ...parts);

  it('Valheim: start line, password hidden, SIGINT saves the world, settings change while stopped', async () => {
    const created = await create({ game: 'valheim', name: 'Midgard', world: 'Yggdrasil', password: 'odin-rules' });
    expect(created.port).toBe(2456);
    expect(JSON.parse(created.gameSettings)).toMatchObject({ world: 'Yggdrasil', queryPort: 2457, public: false });
    expect((await call('POST', '/api/servers', { game: 'valheim', name: 'Asgard', password: 'Asgard' })).body).toMatchObject({ error: { code: 'PASSWORD_INVALID' } });
    await runOnce(created.id, async (online) => {
      expect(online.status.playerCount).toBe(1);
      const history = (await call<{ lines: Array<{ text: string }> }>('GET', `/api/servers/${created.id}/console/history`)).body.lines.map((line) => line.text);
      expect(history.some((line) => line.includes('odin-rules'))).toBe(false);
    });
    const launched = JSON.parse(await readFile(dir(created.id, 'server', 'fake-valheim-args.json'), 'utf8')) as { args: string[]; env: { SteamAppId: string; LD_LIBRARY_PATH: string } };
    expect(launched.args).toEqual(['-nographics', '-batchmode', '-name', 'Midgard', '-port', '2456', '-world', 'Yggdrasil', '-password', 'odin-rules', '-public', '0', '-savedir', dir(created.id, 'data')]);
    expect(launched.env.SteamAppId).toBe('892970');
    expect(launched.env.LD_LIBRARY_PATH.startsWith(dir(created.id, 'server', 'linux64'))).toBe(true);
    expect(await readFile(dir(created.id, 'data', 'worlds_local', 'Yggdrasil.db'), 'utf8')).toBe('world');

    const changed = await call<{ server: ServerBody }>('PATCH', `/api/servers/${created.id}/game-settings`, { world: 'Niflheim', public: true });
    expect(JSON.parse(changed.body.server.gameSettings)).toMatchObject({ world: 'Niflheim', public: true, password: 'odin-rules' });
    expect((await call('PATCH', `/api/servers/${created.id}/game-settings`, { queryPort: 1 })).status).toBe(400);
    expect((await call('POST', `/api/servers/${created.id}/backups`, { includeConfig: true })).status).toBe(202);
    await waitFor(async () => (await call<{ backups: Array<{ status: string }> }>('GET', `/api/servers/${created.id}/backups`)).body.backups[0]?.status === 'ok' || undefined, 10_000);
  }, 60_000);

  it('Valheim: Thunderstore mods with BepInEx, dependencies, a modpack and the start through Doorstop', async () => {
    thunderstore.addBepInEx();
    thunderstore.add({ namespace: 'ValheimModding', name: 'Jotunn', version: '2.30.2', dependencies: ['denikson-BepInExPack_Valheim-5.4.2300'], files: [{ name: 'plugins/Jotunn.dll', content: 'jotunn' }] });
    thunderstore.add({
      namespace: 'RandyKnapp',
      name: 'EpicLoot',
      version: '0.16.0',
      categories: ['server-side', 'client-side'],
      dependencies: ['ValheimModding-Jotunn-2.30.0', 'denikson-BepInExPack_Valheim-5.4.2360'],
      files: [
        { name: 'plugins/EpicLoot.dll', content: 'epic' },
        { name: 'plugins/Assets/loot.json', content: '{}' },
        { name: 'config/randyknapp.mods.epicloot.cfg', content: 'from the package' },
        { name: 'Translations/German.json', content: '{}' },
      ],
    });
    thunderstore.add({ namespace: 'Someone', name: 'Pack', version: '1.0.0', dependencies: ['RandyKnapp-EpicLoot-0.16.0'], files: [] });
    thunderstore.add({ namespace: 'Bad', name: 'Liar', version: '1.0.0', manifestName: 'SomethingElse', files: [{ name: 'plugins/x.dll', content: 'x' }] });

    const created = await create({ game: 'valheim', name: 'Midgard', password: 'odin-rules' });
    const root = (...parts: string[]): string => dir(created.id, 'server', ...parts);
    const search = await call<{ hits: Array<{ fullName: string; serverSide: boolean; icon: string | null; installed: boolean }> }>('GET', `/api/servers/${created.id}/thunderstore/search?query=epic`);
    expect(search.body.hits).toEqual([expect.objectContaining({ fullName: 'RandyKnapp-EpicLoot', serverSide: true, installed: false, icon: expect.stringContaining('gcdn.thunderstore.io') })]);

    // a user config that exists already survives the installation
    await mkdir(root('BepInEx', 'config'), { recursive: true });
    await writeFile(root('BepInEx', 'config', 'randyknapp.mods.epicloot.cfg'), 'edited by hand');

    const installed = await call<{ installed: Array<{ fullName: string; version: string; dependency: boolean }> }>('POST', `/api/servers/${created.id}/thunderstore/mods`, { fullName: 'RandyKnapp-EpicLoot' });
    expect(installed.status).toBe(201);
    expect(installed.body.installed.map((mod) => [mod.fullName, mod.dependency]).sort()).toEqual([
      ['RandyKnapp-EpicLoot', false],
      ['ValheimModding-Jotunn', true],
      ['denikson-BepInExPack_Valheim', true],
    ]);
    expect(await readFile(root('BepInEx', 'core', 'BepInEx.Preloader.dll'), 'utf8')).toBe('preloader 5.4.2360');
    expect(await readFile(root('winhttp.dll'), 'utf8')).toBe('dll');
    expect(await readFile(root('BepInEx', 'plugins', 'RandyKnapp-EpicLoot', 'EpicLoot.dll'), 'utf8')).toBe('epic');
    expect(await readFile(root('BepInEx', 'plugins', 'RandyKnapp-EpicLoot', 'Assets', 'loot.json'), 'utf8')).toBe('{}');
    expect(await readFile(root('BepInEx', 'plugins', 'RandyKnapp-EpicLoot', 'Translations', 'German.json'), 'utf8')).toBe('{}');
    expect(await readFile(root('BepInEx', 'plugins', 'ValheimModding-Jotunn', 'Jotunn.dll'), 'utf8')).toBe('jotunn');
    expect(await readFile(root('BepInEx', 'config', 'randyknapp.mods.epicloot.cfg'), 'utf8')).toBe('edited by hand');
    expect(await readFile(root('BepInEx', 'config', 'BepInEx.cfg'), 'utf8')).toBe('pack config');

    const view = await call<{ bepinex: boolean; mods: Array<{ fullName: string }> }>('GET', `/api/servers/${created.id}/thunderstore/mods`);
    expect(view.body.bepinex).toBe(true);
    expect((await call('POST', `/api/servers/${created.id}/thunderstore/mods`, { fullName: 'RandyKnapp-EpicLoot' })).body).toMatchObject({ error: { code: 'MOD_ALREADY_INSTALLED' } });
    expect((await call('POST', `/api/servers/${created.id}/thunderstore/mods`, { fullName: 'Bad-Liar' })).body).toMatchObject({ error: { code: 'DOWNLOAD_INVALID_FILE' } });
    expect((await call('POST', `/api/servers/${created.id}/thunderstore/mods`, { fullName: '../evil' })).status).toBe(422);
    // a modpack only brings dependencies; the ones in place are kept
    const pack = await call<{ installed: Array<{ fullName: string }> }>('POST', `/api/servers/${created.id}/thunderstore/mods`, { fullName: 'Someone-Pack' });
    expect(pack.body.installed.map((mod) => mod.fullName)).toEqual(['Someone-Pack']);

    await runOnce(created.id, async () => {
      const history = (await call<{ lines: Array<{ text: string }> }>('GET', `/api/servers/${created.id}/console/history`)).body.lines.map((line) => line.text);
      expect(history.some((line) => line.includes('BepInEx is installed'))).toBe(true);
    });
    const launched = JSON.parse(await readFile(root('fake-valheim-args.json'), 'utf8')) as { env: Record<string, string> };
    expect(launched.env).toMatchObject({ DOORSTOP_ENABLED: '1', DOORSTOP_TARGET_ASSEMBLY: root('BepInEx', 'core', 'BepInEx.Preloader.dll') });
    expect(launched.env['LD_PRELOAD']?.startsWith(root('doorstop_libs', 'libdoorstop_x64.so'))).toBe(true);
    expect(launched.env['LD_LIBRARY_PATH']?.startsWith(`${root('doorstop_libs')}:${root('linux64')}`)).toBe(true);

    expect((await call('DELETE', `/api/servers/${created.id}/thunderstore/mods/ValheimModding-Jotunn`)).body).toMatchObject({ error: { code: 'MOD_REQUIRED_BY_OTHERS' } });
    expect((await call('DELETE', `/api/servers/${created.id}/thunderstore/mods/Someone-Pack`)).status).toBe(200);
    expect((await call('DELETE', `/api/servers/${created.id}/thunderstore/mods/RandyKnapp-EpicLoot`)).status).toBe(200);
    expect(await readdir(root('BepInEx', 'plugins'))).not.toContain('RandyKnapp-EpicLoot');
    // configs stay for a later reinstall
    expect(await readFile(root('BepInEx', 'config', 'randyknapp.mods.epicloot.cfg'), 'utf8')).toBe('edited by hand');
  }, 60_000);

  it('7 Days to Die: config from the template, telnet for players, commands and the clean stop', async () => {
    const created = await create({ game: 'sevendays', name: 'Horde Night', password: 'zombies' });
    const settings = JSON.parse(created.gameSettings) as { telnetPort: number; telnetPassword: string; extraPorts: number[] };
    expect(created.port).toBe(26900);
    expect(settings.extraPorts).toEqual([26901, 26902]);
    expect(settings.telnetPort).toBe(8081);
    await runOnce(created.id, async (online) => {
      await waitFor(async () => ((await server(created.id)).status.players.length > 0 ? true : undefined), 5000);
      expect((await server(created.id)).status.players).toEqual(['Bob']);
      expect((await call<{ sent: string }>('POST', `/api/servers/${created.id}/game-players/kick`, { name: 'Bob' })).body).toMatchObject({ sent: 'kick "Bob"' });
      expect(online.status.state).toBe('online');
    });
    const xml = await readFile(dir(created.id, 'data', 'serverconfig.xml'), 'utf8');
    expect(xml).toContain('<property name="ServerName" value="Horde Night"/>');
    expect(xml).toContain('<property name="DayNightLength" value="60"/>');
    expect(xml).toContain(`<property name="UserDataFolder" value="${dir(created.id, 'data')}"/>`);
    expect(xml).toContain('<property name="TelnetEnabled" value="true"/>');
    expect(await readFile(dir(created.id, 'data', 'Saves', 'Navezgane', 'MyGame', 'main.ttw'), 'utf8')).toBe('world');
    const launched = JSON.parse(await readFile(dir(created.id, 'server', 'fake-sevendays-args.json'), 'utf8')) as { args: string[] };
    expect(launched.args).toContain('-logfile');
    // a second server takes the next free block
    expect((await create({ game: 'sevendays', name: 'Second' })).port).toBe(26903);
  }, 60_000);

  it('Palworld: settings from the template, REST API for readiness, players, kick and the clean stop', async () => {
    const created = await create({ game: 'palworld', name: 'Pal Park', maxPlayers: 8 });
    const settings = JSON.parse(created.gameSettings) as { restPort: number; queryPort: number; adminPassword: string };
    expect([created.port, settings.queryPort, settings.restPort]).toEqual([8211, 27015, 8212]);
    await runOnce(created.id, async () => {
      await waitFor(async () => ((await server(created.id)).status.players.length > 0 ? true : undefined), 5000);
      expect((await server(created.id)).status.players).toEqual(['Pal Fan']);
      expect((await call('POST', `/api/servers/${created.id}/game-players/kick`, { name: 'Pal Fan' })).status).toBeLessThan(300);
      expect(JSON.parse(await readFile(dir(created.id, 'server', 'fake-palworld-kick.json'), 'utf8'))).toMatchObject({ userid: 'steam_42' });
      expect((await call('POST', `/api/servers/${created.id}/command`, { command: 'broadcast Hello pals' })).status).toBeLessThan(300);
    });
    const ini = await readFile(dir(created.id, 'server', 'Pal', 'Saved', 'Config', 'LinuxServer', 'PalWorldSettings.ini'), 'utf8');
    expect(ini).toContain('ServerName="Pal Park"');
    expect(ini).toContain('RESTAPIEnabled=True');
    expect(ini).toContain('ServerPlayerMaxNum=8');
    expect(ini).toContain('DayTimeSpeedRate=1.000000');
    expect(await readFile(dir(created.id, 'server', 'Pal', 'Saved', 'SaveGames', '0', '0123456789ABCDEF0123456789ABCDEF', 'Level.sav'), 'utf8')).toBe('world');
    expect(JSON.parse(await readFile(dir(created.id, 'server', 'fake-palworld-args.json'), 'utf8'))).toEqual(['-port=8211', '-queryport=27015', '-players=8', '-useperfthreads', '-NoAsyncLoadingThread', '-UseMultithreadForDS']);
  }, 60_000);

  it('ARK: Survival Ascended: Windows files from SteamCMD, RCON for readiness and players, mods as -mods=', async () => {
    const rconPort = await freePort();
    const created = await create({ game: 'asa', name: 'Dino Land', map: 'Ragnarok_WP' });
    expect(await readFile(dir(created.id, 'platform-type.txt'), 'utf8')).toBe('windows');
    // the fake RCON listens where the settings say; move it to a port free on this machine
    const settings = JSON.parse(created.gameSettings) as Record<string, unknown>;
    await call('PATCH', `/api/servers/${created.id}/game-settings`, { mods: ['928793', '900062'] });
    const next = { ...settings, rconPort, mods: ['928793', '900062'] };
    await t.db.update(servers).set({ gameSettings: JSON.stringify(next) }).where(eq(servers.id, created.id));
    await runOnce(created.id, async () => {
      await waitFor(async () => ((await server(created.id)).status.players.length > 0 ? true : undefined), 5000);
      expect((await server(created.id)).status.players).toEqual(['Bob', 'Alice Smith']);
      expect((await call('POST', `/api/servers/${created.id}/game-players/kick`, { name: 'Alice Smith' })).body).toEqual({ sent: 'KickPlayer 76561198000000002' });
    });
    const args = JSON.parse(await readFile(dir(created.id, 'server', 'ShooterGame', 'Binaries', 'Linux', 'fake-ark-args.json'), 'utf8')) as string[];
    expect(args[0]).toMatch(/^Ragnarok_WP\?listen\?SessionName=Dino Land\?Port=7777\?RCONEnabled=True\?RCONPort=\d+\?ServerAdminPassword=/);
    expect(args.slice(1)).toEqual(['-WinLiveMaxPlayers=20', '-NoBattlEye', '-log', '-mods=928793,900062']);
  }, 60_000);

  it('V Rising: Windows files from SteamCMD, started through Proton with every setting, RCON for readiness', async () => {
    // a Proton that is already in place, so nothing is downloaded from GitHub
    const protonDir = path.join(t.dir, 'data', 'runtimes', 'proton', 'GE-Proton10-1');
    await mkdir(protonDir, { recursive: true });
    await writeFile(path.join(protonDir, 'proton'), `#!/bin/bash\nexec "${process.execPath}" "${path.join(HERE, 'fake-vrising.mjs')}" "$@"\n`, { mode: 0o755 });
    await writeFile(path.join(protonDir, 'version'), 'GE-Proton10-1');

    const created = await create({ game: 'vrising', name: 'Castle Dracul', saveName: 'night1', mode: 'StandardPvE', difficulty: 'Difficulty_Brutal', password: 'blood123', public: true });
    expect(created.port).toBe(9876);
    const settings = JSON.parse(created.gameSettings) as Record<string, unknown>;
    expect(settings).toMatchObject({ saveName: 'night1', queryPort: 9877, rconPort: 9900, mode: 'StandardPvE' });
    expect(await readFile(dir(created.id, 'platform-type.txt'), 'utf8')).toBe('windows');
    // the custom game settings start as the defaults of the server
    expect(await readFile(dir(created.id, 'data', 'Settings', 'ServerGameSettings.json'), 'utf8')).toBe('{"GameModeType":"PvP"}');
    // a second server takes the next pair of ports and the next RCON port
    const second = await create({ game: 'vrising', name: 'Second' });
    expect([second.port, (JSON.parse(second.gameSettings) as { rconPort: number }).rconPort]).toEqual([9878, 9901]);

    const rconPort = await freePort();
    await t.db.update(servers).set({ gameSettings: JSON.stringify({ ...settings, rconPort }) }).where(eq(servers.id, created.id));
    await runOnce(created.id, async () => {
      const history = (await call<{ lines: Array<{ text: string }> }>('GET', `/api/servers/${created.id}/console/history`)).body.lines.map((line) => line.text);
      expect(history.some((line) => line.includes('blood123'))).toBe(false);
      expect((await call<{ lines: string[] }>('POST', `/api/servers/${created.id}/command`, { command: 'version' })).status).toBe(200);
    });
    const started = JSON.parse(await readFile(dir(created.id, 'data', 'fake-vrising-start.json'), 'utf8')) as { proton: boolean; exe: string; args: string[]; env: Record<string, string> };
    expect(started.proton).toBe(true);
    expect(started.exe).toBe(dir(created.id, 'server', 'VRisingServer.exe'));
    expect(started.env['STEAM_COMPAT_DATA_PATH']).toBe(dir(created.id, 'proton-prefix'));
    expect(started.args).toEqual([
      '-persistentDataPath', dir(created.id, 'data'),
      '-logFile', dir(created.id, 'data', 'VRisingServer.log'),
      '-serverName', 'Castle Dracul',
      '-saveName', 'night1',
      '-gamePort', '9876',
      '-queryPort', '9877',
      '-maxUsers', '40',
      '-password', 'blood123',
      '-preset', 'StandardPvE',
      '-difficultyPreset', 'Difficulty_Brutal',
      '-listOnSteam', 'true',
      '-listOnEOS', 'true',
      '-rconEnabled', 'true',
      '-rconPort', String(rconPort),
      '-rconPassword', String(settings['rconPassword']),
    ]);
    // SIGINT: the fake writes its save, which the backup takes along
    expect(await readFile(dir(created.id, 'data', 'Saves', 'v4', 'night1', 'AutoSave_1', 'SaveGame.save'), 'utf8')).toBe('world');
    const changed = await call<{ server: ServerBody }>('PATCH', `/api/servers/${created.id}/game-settings`, { mode: 'custom', maxPlayers: 10 });
    expect(JSON.parse(changed.body.server.gameSettings)).toMatchObject({ mode: 'custom', maxPlayers: 10, password: 'blood123' });
    expect((await call('POST', `/api/servers/${created.id}/backups`, {})).status).toBe(202);
    await waitFor(async () => (await call<{ backups: Array<{ status: string }> }>('GET', `/api/servers/${created.id}/backups`)).body.backups[0]?.status === 'ok' || undefined, 10_000);
  }, 60_000);

  it('Terraria: newest server from terraria.org, config written on start, joins and leaves, "exit" saves', async () => {
    const created = await create({ game: 'terraria', name: 'Underground', world: 'Deep Caves', size: 1, maxPlayers: 4 });
    expect(requested).toEqual([TERRARIA_LIST_URL, terrariaDownloadUrl('terraria-server-1458.zip')]);
    expect(JSON.parse(created.gameSettings)).toMatchObject({ version: '1458', world: 'Deep Caves' });
    await runOnce(created.id, async () => {
      await waitFor(async () => ((await server(created.id)).status.state === 'online' ? true : undefined), 5000);
    });
    const config = JSON.parse(await readFile(dir(created.id, 'fake-terraria-config.json'), 'utf8')) as Record<string, string>;
    expect(config).toMatchObject({ world: dir(created.id, 'worlds', 'Deep Caves.wld'), autocreate: '1', maxplayers: '4', port: '7777' });
    expect(await readFile(dir(created.id, 'worlds', 'Deep Caves.wld'), 'utf8')).toBe('world');
    // Terraria and ARK: Survival Ascended both default to 7777: the second one moves on
    expect((await create({ game: 'asa', name: 'Next' })).port).toBe(7778);
  }, 60_000);
});
