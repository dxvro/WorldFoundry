import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PropertiesEntriesResponse, PropertiesView, PropertyCatalogEntry } from '../src/contract.js';
import { isValidLevelName } from '../src/backups/world.js';
import { PROPERTY_CATALOG, checkPropertyValue } from '../src/properties/catalog.js';
import { PropertiesDocument } from '../src/properties/parser.js';
import { ServerEnv } from './server-env.js';

type Body = { error: { code: string; message: string; details?: Array<{ path: string; message: string }> } };
type EntriesResponse = PropertiesEntriesResponse;

describe('property catalog', () => {
  it('describes every key once, with a default that matches its type', () => {
    const keys = PROPERTY_CATALOG.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of PROPERTY_CATALOG) {
      if (entry.type === 'integer') {
        expect(Number(entry.default)).toBeGreaterThanOrEqual(entry.min ?? Number.NEGATIVE_INFINITY);
        expect(Number(entry.default)).toBeLessThanOrEqual(entry.max ?? Number.POSITIVE_INFINITY);
      }
      if (entry.type === 'enum') expect(entry.options).toContain(entry.default);
      if (entry.type === 'boolean') expect(['true', 'false']).toContain(entry.default);
    }
    for (const key of ['level-name', 'gamemode', 'difficulty', 'server-port', 'rcon.password', 'simulation-distance', 'op-permission-level']) {
      expect(keys).toContain(key);
    }
    expect(PROPERTY_CATALOG.find((entry) => entry.key === 'rcon.password')?.secret).toBe(true);
    expect(PROPERTY_CATALOG.find((entry) => entry.key === 'level-type')?.type).toBe('string');
  });
});

describe('PropertiesDocument entries', () => {
  it('removes every definition of a key and keeps the rest of the file', () => {
    const doc = PropertiesDocument.parse('a=1\n# c\na=2\nb=3');
    expect(doc.remove('a')).toBe(true);
    expect(doc.serialize()).toBe('# c\nb=3');
    expect(doc.remove('a')).toBe(false);
    const last = PropertiesDocument.parse('a=1\nb=2');
    last.remove('b');
    expect(last.serialize()).toBe('a=1\n');
  });

  it('lists each key once in first-appearance order with the value Java uses', () => {
    const doc = PropertiesDocument.parse('z=1\na=2\nz=3\n');
    expect(doc.pairs()).toEqual([
      { key: 'z', value: '3' },
      { key: 'a', value: '2' },
    ]);
  });
});

describe('properties entries API', () => {
  let env: ServerEnv;
  beforeEach(async () => {
    env = await ServerEnv.create();
  });
  afterEach(async () => {
    await env.close();
  });

  const fileOf = async (id: string): Promise<string> => readFile(path.join(env.serverDir(id), 'server.properties'), 'utf8');

  it('serves the catalog and lists the file entries in file order with known flags', async () => {
    const catalog = await env.call<{ catalog: PropertyCatalogEntry[] }>('GET', '/api/properties/catalog');
    expect(catalog.status).toBe(200);
    expect(catalog.body.catalog).toEqual(PROPERTY_CATALOG);

    const server = await env.addServer({ port: 25570 });
    await writeFile(path.join(env.serverDir(server.id), 'server.properties'), '# comment\nmotd=Hi\nspawn-protection=16\nmystery=1\n');
    const read = await env.call<PropertiesView>('GET', `/api/servers/${server.id}/properties`);
    expect(read.body.entries).toEqual([
      { key: 'motd', value: 'Hi', known: true },
      { key: 'spawn-protection', value: '16', known: true },
      { key: 'mystery', value: '1', known: false },
    ]);
    expect(read.body.extra).toEqual({ 'spawn-protection': '16', mystery: '1' });
    expect(read.body.properties.motd).toBe('Hi');

    const empty = await env.addServer();
    const absent = await env.call<PropertiesView>('GET', `/api/servers/${empty.id}/properties`);
    expect(absent.body.exists).toBe(false);
    expect(absent.body.entries).toEqual([]);
  });

  it('sets and removes keys, keeps comments and unknown lines, and creates a missing file', async () => {
    const server = await env.addServer({ port: 25570 });
    await writeFile(path.join(env.serverDir(server.id), 'server.properties'), '# keep me\r\nspawn-protection=16\r\n! also kept\r\nmotd=old\r\n');
    const res = await env.call<EntriesResponse>('PUT', `/api/servers/${server.id}/properties/entries`, {
      set: { motd: 'new', pvp: 'false', 'custom.note': 'x y' },
      remove: ['spawn-protection', 'not-in-file'],
    });
    expect(res.status).toBe(200);
    expect(res.body.restartRequired).toBe(false);
    expect(res.body.levelNameChanged).toBe(false);
    expect(await fileOf(server.id)).toBe('# keep me\r\n! also kept\r\nmotd=new\r\npvp=false\r\ncustom.note=x y\r\n');
    expect(res.body.properties.motd).toBe('new');
    expect(res.body.entries.map((entry) => entry.key)).toEqual(['motd', 'pvp', 'custom.note']);

    const fresh = await env.addServer({ port: 25571 });
    const created = await env.call<EntriesResponse>('PUT', `/api/servers/${fresh.id}/properties/entries`, { set: { motd: 'Hello' } });
    expect(created.status).toBe(200);
    expect(created.body.exists).toBe(true);
    expect(await fileOf(fresh.id)).toBe('server-port=25571\nmotd=Hello\n');
  });

  it('validates values by catalog type', async () => {
    const server = await env.addServer({ port: 25570 });
    const put = (body: unknown) => env.call<Body>('PUT', `/api/servers/${server.id}/properties/entries`, body);
    const invalid: unknown[] = [
      { set: { pvp: 'yes' } },
      { set: { hardcore: 'TRUE' } },
      { set: { 'spawn-protection': '-1' } },
      { set: { 'simulation-distance': '2' } },
      { set: { 'simulation-distance': '33' } },
      { set: { 'op-permission-level': '5' } },
      { set: { 'entity-broadcast-range-percentage': '9' } },
      { set: { 'server-port': '70000' } },
      { set: { 'max-players': 'twenty' } },
      { set: { gamemode: 'god' } },
      { set: { gamemode: '1' } },
      { set: { difficulty: 'Hard' } },
      { set: { 'region-file-compression': 'zip' } },
    ];
    for (const body of invalid) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    // the rejected requests leave the file untouched
    await expect(fileOf(server.id)).rejects.toThrow();

    const ok = await put({ set: { 'spawn-protection': '007', 'simulation-distance': '3', pvp: 'false', 'level-type': 'FLAT', 'rcon.password': 'secret' } });
    expect(ok.status).toBe(200);
    expect(await fileOf(server.id)).toBe('server-port=25570\nspawn-protection=7\nsimulation-distance=3\npvp=false\nlevel-type=FLAT\nrcon.password=secret\n');
  });

  it('rejects bad keys, bad text, empty requests, conflicting keys and too many keys', async () => {
    const server = await env.addServer({ port: 25570 });
    const put = (body: unknown) => env.call<Body>('PUT', `/api/servers/${server.id}/properties/entries`, body);
    const bad: unknown[] = [
      {},
      { set: {} },
      { remove: [] },
      { set: { 'bad key': 'x' } },
      { set: { '-leading': 'x' } },
      { set: { motd: 'two\nlines' } },
      { set: { motd: 'one\r' } },
      { set: { motd: 'nul\u0000' } },
      { set: { motd: 'x'.repeat(2001) } },
      { set: { motd: 'x' }, remove: ['motd'] },
      { unknown: true },
      { remove: Array.from({ length: 201 }, (_, index) => `key${index}`) },
    ];
    for (const body of bad) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const max = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`custom.k${index}`, 'v']));
    expect((await put({ set: max })).status).toBe(200);
    expect((await put({ set: { motd: 'x'.repeat(2000) } })).status).toBe(200);
  });

  it('syncs the database port when server-port is set and refuses to remove it', async () => {
    const server = await env.addServer({ port: 25570 });
    const set = await env.call<EntriesResponse>('PUT', `/api/servers/${server.id}/properties/entries`, { set: { 'server-port': '25599' } });
    expect(set.status).toBe(200);
    expect(set.body.properties['server-port']).toBe(25599);
    expect((await env.row(server.id))?.port).toBe(25599);
    expect(await fileOf(server.id)).toBe('server-port=25599\n');

    const removed = await env.call<Body>('PUT', `/api/servers/${server.id}/properties/entries`, { remove: ['server-port'] });
    expect(removed.status).toBe(422);
    expect(removed.body.error.code).toBe('PROPERTY_NOT_REMOVABLE');
    expect(await fileOf(server.id)).toBe('server-port=25599\n');
    expect((await env.row(server.id))?.port).toBe(25599);
  });

  it('writes numeric gamemode and difficulty for Minecraft 1.12.2 and keeps names for newer versions', async () => {
    const legacy = await env.addServer({ mcVersion: '1.12.2', loader: 'forge', port: 25571 });
    const res = await env.call<EntriesResponse>('PUT', `/api/servers/${legacy.id}/properties/entries`, { set: { gamemode: 'creative', difficulty: 'hard' } });
    expect(res.status).toBe(200);
    expect(await fileOf(legacy.id)).toBe('server-port=25571\ngamemode=1\ndifficulty=3\n');
    expect(res.body.properties).toMatchObject({ gamemode: 'creative', difficulty: 'hard' });

    const modern = await env.addServer({ port: 25572 });
    await env.call('PUT', `/api/servers/${modern.id}/properties/entries`, { set: { gamemode: 'creative' } });
    expect(await fileOf(modern.id)).toBe('server-port=25572\ngamemode=creative\n');
  });

  it('accepts unknown keys and reports them as not known', async () => {
    const server = await env.addServer({ port: 25570 });
    const res = await env.call<EntriesResponse>('PUT', `/api/servers/${server.id}/properties/entries`, { set: { 'my-mod.option': 'on' } });
    expect(res.status).toBe(200);
    expect(res.body.entries).toContainEqual({ key: 'my-mod.option', value: 'on', known: false });
    expect(res.body.extra).toMatchObject({ 'my-mod.option': 'on' });
  });

  it('checks level-name as one safe folder name and reports a change of the world', async () => {
    const server = await env.addServer({ port: 25570 });
    const put = (levelName: string) => env.call<EntriesResponse & Body>('PUT', `/api/servers/${server.id}/properties/entries`, { set: { 'level-name': levelName } });
    for (const unsafe of ['..', '.', '../other', '/abs/world', 'a/b', 'a\\b', 'C:world', 'sub:dir', '', '   ', ' world', 'world ', 'world.']) {
      const res = await put(unsafe);
      expect(res.status, `"${unsafe}"`).toBe(400);
    }
    expect(checkPropertyValue('level-name', 'My World').ok).toBe(true);

    const changed = await put('world_new');
    expect(changed.status).toBe(200);
    expect(changed.body.levelNameChanged).toBe(true);
    const same = await put('world_new');
    expect(same.body.levelNameChanged).toBe(false);

    const removed = await env.call<EntriesResponse>('PUT', `/api/servers/${server.id}/properties/entries`, { remove: ['level-name'] });
    expect(removed.body.levelNameChanged).toBe(true);
  });

  it('answers restartRequired while the server runs', async () => {
    const server = await env.addServer();
    expect((await env.call('POST', `/api/servers/${server.id}/start`)).status).toBe(200);
    await env.waitState(server.id, 'online');
    const res = await env.call<EntriesResponse>('PUT', `/api/servers/${server.id}/properties/entries`, { set: { motd: 'live' } });
    expect(res.status).toBe(200);
    expect(res.body.restartRequired).toBe(true);
    expect(res.body.liveOverwriteRisk).toBe(true);
  });

  it('reports no overwrite risk while the server is stopped', async () => {
    const server = await env.addServer();
    const res = await env.call<EntriesResponse>('PUT', `/api/servers/${server.id}/properties/entries`, { set: { motd: 'stopped' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ restartRequired: false, liveOverwriteRisk: false });
  });

  it('refuses level names that belong to the server, are hidden or are Windows device names', async () => {
    const server = await env.addServer({ port: 25570 });
    const put = (levelName: string) => env.call<EntriesResponse & Body>('PUT', `/api/servers/${server.id}/properties/entries`, { set: { 'level-name': levelName } });
    for (const name of ['mods', 'Plugins', 'CONFIG', 'libraries', 'logs', 'crash-reports', 'versions', 'cache', 'defaultconfigs', '.fabric', '.mixin.out', '.hidden', 'CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'nul.txt', 'CON.world', 'com1 .x']) {
      expect((await put(name)).status, name).toBe(400);
    }
    for (const name of ['world', 'world_nether', 'world_the_end', 'My World', 'survival-2', 'config2', 'modsworld', 'console', 'com10', 'lpt0', 'a.con', 'World.v2']) {
      expect((await put(name)).status, name).toBe(200);
    }
  });

  it('knows the same rules without the server', () => {
    expect(isValidLevelName('world')).toBe(true);
    expect(isValidLevelName(' mods ')).toBe(false);
    expect(isValidLevelName('Nul')).toBe(false);
  });

  it('returns 404 for unknown servers', async () => {
    const res = await env.call<Body>('PUT', '/api/servers/nope/properties/entries', { set: { motd: 'x' } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SERVER_NOT_FOUND');
  });
});
