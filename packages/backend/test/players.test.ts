import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayersView } from '../src/contract.js';
import { lookupMojangProfile } from '../src/players/mojang.js';
import { isAddableName, PLAYER_NAME, PLAYER_NAME_LENIENT } from '../src/players/schemas.js';
import { asciiReason } from '../src/players/service.js';
import { dashUuid, formatBanDate, offlineUuid } from '../src/players/uuid.js';
import { ServerEnv, waitFor } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const NOTCH_ID = '069a79f444e94726a5befca90e38aaf5';
const NOTCH_UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

// Stands in for api.mojang.com: names are matched case-insensitively and answered with the canonical spelling
class FakeMojang {
  readonly profiles = new Map<string, { id: string; name: string }>([['notch', { id: NOTCH_ID, name: 'Notch' }]]);
  readonly requests: Array<{ url: string; headers: Record<string, string> }> = [];
  mode: 'ok' | 'down' | 'timeout' | '204' | '429' | 'garbage' = 'ok';

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.requests.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    if (this.mode === 'down') throw new TypeError('fetch failed');
    if (this.mode === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    if (this.mode === '204') return new Response(null, { status: 204 });
    if (this.mode === '429') return new Response('{}', { status: 429 });
    if (this.mode === 'garbage') return new Response('{"id":"nope"}', { status: 200 });
    const name = decodeURIComponent(url.split('/').pop() ?? '').toLowerCase();
    const profile = this.profiles.get(name);
    if (profile === undefined) return new Response('{"errorMessage":"not found"}', { status: 404 });
    return new Response(JSON.stringify(profile), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

let env: ServerEnv;
let mojang: FakeMojang;
const timings = { pollMs: 20, liveWaitMs: 5000 };
const FIXED_NOW = new Date(2026, 0, 2, 3, 4, 5);

beforeEach(async () => {
  mojang = new FakeMojang();
  timings.liveWaitMs = 5000;
  env = await ServerEnv.create({ players: { fetch: mojang.fetch, timings, now: () => FIXED_NOW } });
});
afterEach(async () => {
  await env.close();
});

const base = (id: string): string => `/api/servers/${id}/players`;
const get = (id: string) => env.call<PlayersView>('GET', base(id));
const post = (id: string, list: string, body: unknown) => env.call<PlayersView & ErrorBody>('POST', `${base(id)}/${list}`, body);
const del = (id: string, list: string, key: string) => env.call<PlayersView & ErrorBody>('DELETE', `${base(id)}/${list}/${encodeURIComponent(key)}`);
const readJson = async (id: string, file: string): Promise<unknown> => JSON.parse(await readFile(path.join(env.serverDir(id), file), 'utf8')) as unknown;
const setProperties = (id: string, text: string): Promise<void> => writeFile(path.join(env.serverDir(id), 'server.properties'), text);
const offlineServer = async (overrides: Parameters<ServerEnv['addServer']>[0] = {}) => {
  const server = await env.addServer(overrides);
  await setProperties(server.id, 'online-mode=false\nwhite-list=true\n');
  return server;
};

describe('uuid helpers', () => {
  it('computes the offline UUID like java.util.UUID.nameUUIDFromBytes', () => {
    expect(offlineUuid('Notch')).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f');
    // the name is case sensitive, as it is on the server
    expect(offlineUuid('notch')).not.toBe(offlineUuid('Notch'));
    expect(offlineUuid('Steve')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('adds dashes to a Mojang id', () => {
    expect(dashUuid(NOTCH_ID.toUpperCase())).toBe(NOTCH_UUID);
  });

  it('formats dates like the ban lists', () => {
    expect(formatBanDate(FIXED_NOW)).toMatch(/^2026-01-02 03:04:05 [+-]\d{4}$/);
  });
});

describe('Mojang lookup', () => {
  const options = (fetchFn: typeof fetch) => ({ fetch: fetchFn, userAgent: 'test-agent/1.0' });

  it('resolves the canonical name and a dashed UUID, sending only the name and the project user agent', async () => {
    const profile = await lookupMojangProfile('nOtCh', options(mojang.fetch));
    expect(profile).toEqual({ uuid: NOTCH_UUID, name: 'Notch' });
    expect(mojang.requests).toHaveLength(1);
    expect(mojang.requests[0]?.url).toBe('https://api.mojang.com/users/profiles/minecraft/nOtCh');
    expect(Object.keys(mojang.requests[0]?.headers ?? {}).sort()).toEqual(['Accept', 'User-Agent']);
    expect(mojang.requests[0]?.headers['User-Agent']).toBe('test-agent/1.0');
  });

  it.each([
    ['204', 404, 'PLAYER_NOT_FOUND'],
    ['down', 502, 'PLAYER_LOOKUP_FAILED'],
    ['timeout', 502, 'PLAYER_LOOKUP_FAILED'],
    ['429', 502, 'PLAYER_LOOKUP_FAILED'],
    ['garbage', 502, 'PLAYER_LOOKUP_FAILED'],
  ] as const)('maps %s to %i %s', async (mode, status, code) => {
    mojang.mode = mode;
    await expect(lookupMojangProfile('Notch', options(mojang.fetch))).rejects.toMatchObject({ statusCode: status, code });
  });
});

describe('file mode (server stopped)', () => {
  it('returns empty lists for a server without any list files', async () => {
    const server = await env.addServer();
    const res = await get(server.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      supported: true,
      mode: 'file',
      busy: false,
      online: [],
      whitelistEnabled: false,
      onlineMode: true,
      opPermissionLevel: 4,
      whitelist: [],
      ops: [],
      bannedPlayers: [],
      bannedIps: [],
      corrupt: [],
      pending: false,
      notice: null,
    });
  });

  it('answers 404 for an unknown server', async () => {
    const res = await env.call<ErrorBody>('GET', base('00000000-0000-4000-8000-000000000000'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SERVER_NOT_FOUND');
  });

  it('reads vanilla files as they are', async () => {
    const server = await env.addServer();
    const dir = env.serverDir(server.id);
    await writeFile(path.join(dir, 'whitelist.json'), JSON.stringify([{ uuid: NOTCH_UUID, name: 'Notch' }]));
    await writeFile(path.join(dir, 'ops.json'), JSON.stringify([{ uuid: NOTCH_UUID, name: 'Notch', level: 2, bypassesPlayerLimit: true }]));
    await writeFile(
      path.join(dir, 'banned-players.json'),
      JSON.stringify([{ uuid: NOTCH_UUID, name: 'Notch', created: '2026-01-01 10:00:00 +0100', source: 'Server', expires: 'forever', reason: 'Griefing' }]),
    );
    await writeFile(
      path.join(dir, 'banned-ips.json'),
      JSON.stringify([{ ip: '10.0.0.1', created: '2026-01-01 10:00:00 +0100', source: 'Server', expires: 'forever', reason: 'Spam' }]),
    );
    const view = (await get(server.id)).body;
    expect(view.whitelist).toEqual([{ uuid: NOTCH_UUID, name: 'Notch' }]);
    expect(view.ops).toEqual([{ uuid: NOTCH_UUID, name: 'Notch', level: 2, bypassesPlayerLimit: true }]);
    expect(view.bannedPlayers[0]).toMatchObject({ name: 'Notch', reason: 'Griefing', expires: 'forever' });
    expect(view.bannedIps[0]).toMatchObject({ ip: '10.0.0.1', reason: 'Spam' });
  });

  it('treats an empty file as an empty list and reads the properties', async () => {
    const server = await env.addServer();
    await writeFile(path.join(env.serverDir(server.id), 'whitelist.json'), '  \n');
    await setProperties(server.id, 'white-list=true\nonline-mode=false\nop-permission-level=3\n');
    const view = (await get(server.id)).body;
    expect(view).toMatchObject({ whitelist: [], corrupt: [], whitelistEnabled: true, onlineMode: false, opPermissionLevel: 3 });
    expect((await post(server.id, 'whitelist', { name: 'Steve' })).status).toBe(200);
  });

  it('reads a file that starts with a byte order mark', async () => {
    const server = await env.addServer();
    await writeFile(path.join(env.serverDir(server.id), 'ops.json'), String.fromCharCode(0xfeff) + JSON.stringify([{ uuid: NOTCH_UUID, name: 'Notch', level: 4 }]));
    const view = (await get(server.id)).body;
    expect(view.corrupt).toEqual([]);
    expect(view.ops).toEqual([{ uuid: NOTCH_UUID, name: 'Notch', level: 4, bypassesPlayerLimit: false }]);
  });

  describe('online-mode=true (Mojang UUIDs)', () => {
    it('whitelists a player with the canonical name and UUID, once', async () => {
      const server = await env.addServer();
      const res = await post(server.id, 'whitelist', { name: 'nOTCH' });
      expect(res.status).toBe(200);
      expect(res.body.whitelist).toEqual([{ uuid: NOTCH_UUID, name: 'Notch' }]);
      expect(res.body.mode).toBe('file');
      expect(await readJson(server.id, 'whitelist.json')).toEqual([{ uuid: NOTCH_UUID, name: 'Notch' }]);
      const again = await post(server.id, 'whitelist', { name: 'Notch' });
      expect(again.body.whitelist).toHaveLength(1);
      expect(mojang.requests[0]?.headers['User-Agent']).toMatch(/^WorldFoundry\//);
    });

    it('removes entries regardless of capitalisation', async () => {
      const server = await env.addServer();
      await post(server.id, 'whitelist', { name: 'Notch' });
      const res = await del(server.id, 'whitelist', 'NOTCH');
      expect(res.status).toBe(200);
      expect(res.body.whitelist).toEqual([]);
      expect(await readJson(server.id, 'whitelist.json')).toEqual([]);
      const missing = await del(server.id, 'whitelist', 'Notch');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('PLAYER_NOT_LISTED');
      expect(missing.body.error.details).toEqual({ name: 'Notch' });
    });

    it('answers 404 "Player not found" and writes nothing for an unknown name', async () => {
      const server = await env.addServer();
      const res = await post(server.id, 'whitelist', { name: 'NoSuchPlayer' });
      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain('Player not found');
      expect(res.body.error.code).toBe('PLAYER_NOT_FOUND');
      expect(res.body.error.details).toEqual({ name: 'NoSuchPlayer' });
      expect(await readdir(env.serverDir(server.id))).not.toContain('whitelist.json');
    });

    it('answers 502 with a hint when Mojang cannot be reached', async () => {
      const server = await env.addServer();
      mojang.mode = 'down';
      const res = await post(server.id, 'ops', { name: 'Notch' });
      expect(res.status).toBe(502);
      expect(res.body.error.message).toContain('start the server');
      expect(await readdir(env.serverDir(server.id))).not.toContain('ops.json');
    });

    it('bans through the Mojang UUID', async () => {
      const server = await env.addServer();
      const res = await post(server.id, 'banned-players', { name: 'notch', reason: 'Griefing' });
      expect(res.body.bannedPlayers).toEqual([
        { uuid: NOTCH_UUID, name: 'Notch', created: formatBanDate(FIXED_NOW), source: 'WorldFoundry', expires: 'forever', reason: 'Griefing' },
      ]);
    });
  });

  describe('online-mode=false (offline UUIDs)', () => {
    it('manages the whitelist without contacting Mojang', async () => {
      const server = await offlineServer();
      const res = await post(server.id, 'whitelist', { name: 'Notch' });
      expect(res.body.whitelist).toEqual([{ uuid: 'b50ad385-829d-3141-a216-7e7d7539ba7f', name: 'Notch' }]);
      expect(res.body.whitelistEnabled).toBe(true);
      expect(res.body.onlineMode).toBe(false);
      expect(mojang.requests).toHaveLength(0);
      await post(server.id, 'whitelist', { name: 'Alex_1' });
      expect(((await del(server.id, 'whitelist', 'Notch')).body).whitelist.map((entry) => entry.name)).toEqual(['Alex_1']);
    });

    it('manages operators with level and player-limit flag, defaulting to the op-permission-level', async () => {
      const server = await offlineServer();
      await setProperties(server.id, 'online-mode=false\nop-permission-level=3\n');
      const first = await post(server.id, 'ops', { name: 'Steve' });
      expect(first.body.ops).toEqual([{ uuid: offlineUuid('Steve'), name: 'Steve', level: 3, bypassesPlayerLimit: false }]);
      const second = await post(server.id, 'ops', { name: 'Alex', level: 1, bypassesPlayerLimit: true });
      expect(second.body.ops[1]).toEqual({ uuid: offlineUuid('Alex'), name: 'Alex', level: 1, bypassesPlayerLimit: true });
      // adding an existing operator updates the entry
      const updated = await post(server.id, 'ops', { name: 'Steve', level: 2 });
      expect(updated.body.ops).toHaveLength(2);
      expect(updated.body.ops[0]?.level).toBe(2);
      const removed = await del(server.id, 'ops', 'alex');
      expect(removed.body.ops.map((entry) => entry.name)).toEqual(['Steve']);
      expect(await readJson(server.id, 'ops.json')).toEqual([{ uuid: offlineUuid('Steve'), name: 'Steve', level: 2, bypassesPlayerLimit: false }]);
    });

    it('bans players with and without a reason and pardons them', async () => {
      const server = await offlineServer();
      const withReason = await post(server.id, 'banned-players', { name: 'Steve', reason: ' Flying is forbidden ' });
      expect(withReason.body.bannedPlayers[0]).toEqual({
        uuid: offlineUuid('Steve'),
        name: 'Steve',
        created: formatBanDate(FIXED_NOW),
        source: 'WorldFoundry',
        expires: 'forever',
        reason: 'Flying is forbidden',
      });
      const without = await post(server.id, 'banned-players', { name: 'Alex' });
      expect(without.body.bannedPlayers[1]?.reason).toBe('Banned by an operator.');
      // banning again replaces the entry
      expect((await post(server.id, 'banned-players', { name: 'Alex', reason: 'New' })).body.bannedPlayers).toHaveLength(2);
      const pardoned = await del(server.id, 'banned-players', 'STEVE');
      expect(pardoned.body.bannedPlayers.map((entry) => entry.name)).toEqual(['Alex']);
      expect(((await readJson(server.id, 'banned-players.json')) as Array<{ reason: string }>)[0]?.reason).toBe('New');
    });

    it('bans and pardons IPv4 and IPv6 addresses', async () => {
      const server = await offlineServer();
      const v4 = await post(server.id, 'banned-ips', { ip: '192.168.1.20', reason: 'Spam' });
      expect(v4.body.bannedIps).toEqual([
        { ip: '192.168.1.20', created: formatBanDate(FIXED_NOW), source: 'WorldFoundry', expires: 'forever', reason: 'Spam' },
      ]);
      const v6 = await post(server.id, 'banned-ips', { ip: '2001:db8::1' });
      expect(v6.body.bannedIps).toHaveLength(2);
      expect(v6.body.bannedIps[1]?.reason).toBe('Banned by an operator.');
      expect((await del(server.id, 'banned-ips', '2001:DB8::1')).body.bannedIps.map((entry) => entry.ip)).toEqual(['192.168.1.20']);
      expect((await del(server.id, 'banned-ips', '192.168.1.20')).body.bannedIps).toEqual([]);
      expect((await del(server.id, 'banned-ips', '192.168.1.20')).status).toBe(404);
    });

    it('writes vanilla-style JSON atomically without leftovers', async () => {
      const server = await offlineServer();
      await post(server.id, 'whitelist', { name: 'Steve' });
      const text = await readFile(path.join(env.serverDir(server.id), 'whitelist.json'), 'utf8');
      expect(text).toBe(JSON.stringify([{ uuid: offlineUuid('Steve'), name: 'Steve' }], null, 2));
      expect((await readdir(env.serverDir(server.id))).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    });
  });

  describe('validation', () => {
    it.each([
      ['whitelist', { name: '' }],
      ['whitelist', { name: 'a'.repeat(33) }],
      ['whitelist', { name: 'bad name' }],
      ['whitelist', { name: 'tab\tname' }],
      ['whitelist', { name: 'line\nbreak' }],
      ['whitelist', { name: '@a' }],
      ['whitelist', { name: '@e[type=cow]' }],
      ['whitelist', { name: 'ümlaut' }],
      ['whitelist', { name: 'Steve', extra: 1 }],
      ['whitelist', {}],
      ['ops', { name: 'Steve', level: 5 }],
      ['ops', { name: 'Steve', level: 0 }],
      ['ops', { name: 'Steve', level: 2.5 }],
      ['ops', { name: 'Steve', bypassesPlayerLimit: 'yes' }],
      ['banned-players', { name: 'Steve', reason: 'two\nlines' }],
      ['banned-players', { name: 'Steve', reason: 'bell\u0007' }],
      ['banned-players', { name: 'Steve', reason: 'x'.repeat(201) }],
      ['banned-ips', { ip: 'localhost' }],
      ['banned-ips', { ip: '999.1.1.1' }],
      ['banned-ips', { ip: 'fe80::1%eth0' }],
      ['banned-ips', { ip: '10.0.0.1', reason: 'a\r\nb' }],
    ])('rejects %s %j with 400', async (list, body) => {
      const server = await offlineServer();
      const res = await post(server.id, list, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect((await readdir(env.serverDir(server.id))).filter((file) => file.endsWith('.json'))).toEqual([]);
    });

    it('accepts a reason of exactly 200 characters', async () => {
      const server = await offlineServer();
      const res = await post(server.id, 'banned-players', { name: 'Steve', reason: 'x'.repeat(200) });
      expect(res.status).toBe(200);
    });

    it('rejects invalid names and addresses in DELETE paths', async () => {
      const server = await offlineServer();
      expect((await del(server.id, 'whitelist', 'bad name')).status).toBe(400);
      expect((await del(server.id, 'ops', 'x'.repeat(33))).status).toBe(400);
      expect((await del(server.id, 'ops', '@a')).status).toBe(400);
      expect((await del(server.id, 'whitelist', 'ümlaut')).status).toBe(400);
      expect((await del(server.id, 'banned-ips', 'not-an-ip')).status).toBe(400);
    });
  });

  describe('player names', () => {
    it('exports the rules the frontend mirrors', () => {
      expect(PLAYER_NAME.test('Steve_1')).toBe(true);
      expect(PLAYER_NAME.test('Steve-1')).toBe(false);
      expect(PLAYER_NAME_LENIENT.test('.Steve')).toBe(true);
      expect(PLAYER_NAME_LENIENT.test('@Steve')).toBe(false);
      expect(PLAYER_NAME_LENIENT.test('a'.repeat(32))).toBe(true);
      expect(PLAYER_NAME_LENIENT.test('a'.repeat(33))).toBe(false);
      expect(PLAYER_NAME_LENIENT.test('a b')).toBe(false);
      expect(isAddableName('Steve-1', true)).toBe(false);
      expect(isAddableName('Steve-1', false)).toBe(true);
      expect(isAddableName('.Steve 1', true)).toBe(false);
      expect(isAddableName('.Steve-1', true)).toBe(true);
    });

    it('holds online-mode=true to Mojang names, except Bedrock names with a leading dot', async () => {
      const server = await env.addServer();
      for (const name of ['Steve-1', 'a.b', 'a'.repeat(17), 'Steve!']) {
        const res = await post(server.id, 'whitelist', { name });
        expect(res.status, name).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(mojang.requests).toHaveLength(0);
    });

    it('refuses a Bedrock name in file mode with online-mode=true (no Mojang account) and writes nothing', async () => {
      const server = await env.addServer();
      const res = await post(server.id, 'whitelist', { name: '.Steve' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYER_NAME_NEEDS_RUNNING_SERVER');
      expect(res.body.error.message).toContain('start the server');
      expect(res.body.error.details).toEqual({ name: '.Steve' });
      expect(mojang.requests).toHaveLength(0);
      expect(await readdir(env.serverDir(server.id))).not.toContain('whitelist.json');
    });

    it('accepts dots, dashes and Bedrock prefixes on offline-mode servers with the offline UUID', async () => {
      const server = await offlineServer();
      for (const name of ['.Steve', 'Alex-2', 'a.b', 'x'.repeat(32)]) {
        const res = await post(server.id, 'whitelist', { name });
        expect(res.status, name).toBe(200);
        expect(res.body.whitelist.at(-1)).toEqual({ uuid: offlineUuid(name), name });
      }
      expect(mojang.requests).toHaveLength(0);
    });

    it('removes entries with unusual names that are already in a list', async () => {
      const server = await env.addServer();
      await writeFile(
        path.join(env.serverDir(server.id), 'whitelist.json'),
        JSON.stringify([
          { uuid: 'u1', name: '.Bedrock-Steve' },
          { uuid: 'u2', name: 'Alex-2' },
        ]),
      );
      expect((await del(server.id, 'whitelist', '.Bedrock-Steve')).body.whitelist.map((entry) => entry.name)).toEqual(['Alex-2']);
      expect((await del(server.id, 'whitelist', 'Alex-2')).body.whitelist).toEqual([]);
    });
  });

  describe('whitelist switch (file mode)', () => {
    const switchTo = (id: string, enabled: unknown) => env.call<PlayersView & ErrorBody>('POST', `${base(id)}/whitelist-enabled`, { enabled });

    it('writes white-list into server.properties and keeps the rest of the file', async () => {
      const server = await offlineServer();
      await setProperties(server.id, '# my settings\nonline-mode=false\nwhite-list=false\nmotd=Hello\n');
      const on = await switchTo(server.id, true);
      expect(on.status).toBe(200);
      expect(on.body).toMatchObject({ mode: 'file', whitelistEnabled: true, pending: false });
      expect(await readFile(path.join(env.serverDir(server.id), 'server.properties'), 'utf8')).toBe('# my settings\nonline-mode=false\nwhite-list=true\nmotd=Hello\n');
      const off = await switchTo(server.id, false);
      expect(off.body.whitelistEnabled).toBe(false);
      expect(await readFile(path.join(env.serverDir(server.id), 'server.properties'), 'utf8')).toContain('white-list=false');
    });

    it('creates server.properties with the port of the server when it does not exist yet', async () => {
      const server = await env.addServer({ port: 25577 });
      const res = await switchTo(server.id, true);
      expect(res.body.whitelistEnabled).toBe(true);
      const text = await readFile(path.join(env.serverDir(server.id), 'server.properties'), 'utf8');
      expect(text).toContain('server-port=25577');
      expect(text).toContain('white-list=true');
    });

    it.each([{}, { enabled: 'yes' }, { enabled: true, extra: 1 }])('rejects the body %j with 400', async (body) => {
      const server = await offlineServer();
      const res = await env.call<ErrorBody>('POST', `${base(server.id)}/whitelist-enabled`, body);
      expect(res.status).toBe(400);
    });

    it('answers 404 for an unknown server', async () => {
      const res = await switchTo('00000000-0000-4000-8000-000000000000', true);
      expect(res.status).toBe(404);
    });
  });

  describe('op-permission-level', () => {
    it('keeps a legal level of 0 (vanilla assigns it as well) and falls back to 4 for anything else', async () => {
      const server = await offlineServer();
      const levelOf = async (value: string) => {
        await setProperties(server.id, `online-mode=false\nop-permission-level=${value}\n`);
        return (await get(server.id)).body.opPermissionLevel;
      };
      expect(await levelOf('0')).toBe(0);
      expect(await levelOf('1')).toBe(1);
      expect(await levelOf('4')).toBe(4);
      for (const bad of ['5', '-1', 'abc', '', '2.5']) expect(await levelOf(bad), bad).toBe(4);
      await setProperties(server.id, 'online-mode=false\nop-permission-level=0\n');
      const op = await post(server.id, 'ops', { name: 'Steve' });
      expect(op.body.ops).toEqual([{ uuid: offlineUuid('Steve'), name: 'Steve', level: 0, bypassesPlayerLimit: false }]);
    });
  });

  describe('damaged files', () => {
    it('reports a corrupt file, shows an empty list and refuses to overwrite it', async () => {
      const server = await offlineServer();
      const file = path.join(env.serverDir(server.id), 'whitelist.json');
      await writeFile(file, '[{"uuid": "x", "name": ');
      const view = (await get(server.id)).body;
      expect(view.whitelist).toEqual([]);
      expect(view.corrupt).toEqual(['whitelist']);
      const add = await post(server.id, 'whitelist', { name: 'Steve' });
      expect(add.status).toBe(409);
      expect(add.body.error.code).toBe('PLAYER_LIST_CORRUPT');
      expect(add.body.error.message).toContain('whitelist.json');
      expect((await del(server.id, 'whitelist', 'Steve')).status).toBe(409);
      expect(await readFile(file, 'utf8')).toBe('[{"uuid": "x", "name": ');
      // the other lists keep working
      expect((await post(server.id, 'ops', { name: 'Steve' })).status).toBe(200);
    });

    it.each([
      ['not an array', '{"uuid":"x","name":"Steve"}'],
      ['an entry of the wrong shape', '[{"uuid":"x","name":"Steve"},{"foo":1}]'],
    ])('treats %s as corrupt and keeps the valid entries visible', async (_label, content) => {
      const server = await offlineServer();
      const file = path.join(env.serverDir(server.id), 'whitelist.json');
      await writeFile(file, content);
      const view = (await get(server.id)).body;
      expect(view.corrupt).toEqual(['whitelist']);
      expect((await post(server.id, 'whitelist', { name: 'Alex' })).status).toBe(409);
      expect(await readFile(file, 'utf8')).toBe(content);
    });
  });

  describe('Minecraft versions', () => {
    it.each(['1.7.2', '1.7.5', '1.6.4', 'b1.7.3'])('does not support %s', async (mcVersion) => {
      const server = await offlineServer({ mcVersion });
      const view = (await get(server.id)).body;
      expect(view).toMatchObject({ supported: false, whitelist: [], ops: [], bannedPlayers: [], bannedIps: [] });
      const res = await post(server.id, 'whitelist', { name: 'Steve' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYERS_UNSUPPORTED');
      expect(res.body.error.message).toContain('1.7.6');
      expect(await readdir(env.serverDir(server.id))).not.toContain('whitelist.json');
    });

    it.each(['1.7.6', '1.7.10', '1.8', '1.21.1', '26.1'])('supports %s', async (mcVersion) => {
      const server = await offlineServer({ mcVersion });
      expect((await get(server.id)).body.supported).toBe(true);
      expect((await post(server.id, 'whitelist', { name: 'Steve' })).status).toBe(200);
    });
  });
});

describe('live mode (server online)', () => {
  async function onlineServer(): Promise<string> {
    const server = await env.addServer();
    const started = await env.call('POST', `/api/servers/${server.id}/start`);
    expect(started.status).toBe(200);
    await env.waitState(server.id, 'online');
    return server.id;
  }

  it('applies every change through console commands and returns the updated view', async () => {
    const id = await onlineServer();

    const added = await post(id, 'whitelist', { name: 'Steve' });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ mode: 'live', pending: false, notice: null });
    expect(added.body.whitelist.map((entry) => entry.name)).toEqual(['Steve']);

    // live changes never ask Mojang: the server resolves the name itself
    const op = await post(id, 'ops', { name: 'Steve' });
    expect(op.body.ops.map((entry) => entry.name)).toEqual(['Steve']);
    const ban = await post(id, 'banned-players', { name: 'Alex', reason: 'Flying is forbidden' });
    expect(ban.body.bannedPlayers[0]).toMatchObject({ name: 'Alex', reason: 'Flying is forbidden' });
    const ipBan = await post(id, 'banned-ips', { ip: '10.1.2.3', reason: 'Spam' });
    expect(ipBan.body.bannedIps[0]).toMatchObject({ ip: '10.1.2.3', reason: 'Spam' });
    expect(mojang.requests).toHaveLength(0);

    const commands = env.services.manager
      .history(id)
      .filter((line) => line.stream === 'input')
      .map((line) => line.text);
    expect(commands).toEqual(['whitelist add Steve', 'op Steve', 'ban Alex Flying is forbidden', 'ban-ip 10.1.2.3 Spam']);

    expect((await del(id, 'banned-ips', '10.1.2.3')).body.bannedIps).toEqual([]);
    expect((await del(id, 'banned-players', 'alex')).body.bannedPlayers).toEqual([]);
    expect((await del(id, 'ops', 'STEVE')).body.ops).toEqual([]);
    const removed = await del(id, 'whitelist', 'steve');
    expect(removed.body).toMatchObject({ whitelist: [], pending: false });

    const inputs = env.services.manager
      .history(id)
      .filter((line) => line.stream === 'input')
      .map((line) => line.text);
    // the listed spelling is used, not the one from the request
    expect(inputs.slice(4)).toEqual(['pardon-ip 10.1.2.3', 'pardon Alex', 'deop Steve', 'whitelist remove Steve']);
  });

  it('shows the online players and the mode', async () => {
    const id = await onlineServer();
    await env.services.manager.sendCommand(id, 'join Steve');
    await waitFor(async () => (await get(id)).body.online.includes('Steve'));
    const view = (await get(id)).body;
    expect(view).toMatchObject({ mode: 'live', busy: false, online: ['Steve'] });
  });

  it('answers 404 for entries that are not listed without sending a command', async () => {
    const id = await onlineServer();
    const res = await del(id, 'whitelist', 'Nobody');
    expect(res.status).toBe(404);
    expect(res.body.error.details).toEqual({ name: 'Nobody' });
    expect(env.services.manager.history(id).filter((line) => line.stream === 'input')).toEqual([]);
  });

  it('does not send a command for a change the file already shows', async () => {
    const id = await onlineServer();
    await post(id, 'whitelist', { name: 'Steve' });
    const before = env.services.manager.history(id).filter((line) => line.stream === 'input').length;
    await post(id, 'whitelist', { name: 'STEVE' });
    expect(env.services.manager.history(id).filter((line) => line.stream === 'input')).toHaveLength(before);
  });

  it('refuses an operator level that /op cannot assign', async () => {
    const id = await onlineServer();
    const level = await post(id, 'ops', { name: 'Steve', level: 2 });
    expect(level.status).toBe(409);
    expect(level.body.error.code).toBe('OP_LEVEL_LIVE');
    expect(level.body.error.message).toContain('stopped');
    expect(level.body.error.details).toEqual({ level: 4 });
    const bypass = await post(id, 'ops', { name: 'Steve', bypassesPlayerLimit: true });
    expect(bypass.status).toBe(409);
    // explicitly asking for the default level is fine
    expect((await post(id, 'ops', { name: 'Steve', level: 4 })).status).toBe(200);
    expect(env.services.manager.history(id).filter((line) => line.stream === 'input').map((line) => line.text)).toEqual(['op Steve']);
  });

  it('reports pending instead of failing when the file does not change in time', async () => {
    env.spawner.extraEnv = { FAKE_PLAYERS: 'silent' };
    const id = await onlineServer();
    timings.liveWaitMs = 250;
    const res = await post(id, 'whitelist', { name: 'Steve' });
    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(true);
    expect(res.body.notice).toContain('The server');
    expect(res.body).toMatchObject({ noticeRef: { key: 'PLAYERS_PENDING' } });
    expect(res.body.whitelist).toEqual([]);
    expect(env.services.manager.history(id).some((line) => line.text === 'whitelist add Steve')).toBe(true);
  });

  it('adds a Bedrock name through the server even with online-mode=true', async () => {
    const id = await onlineServer();
    const res = await post(id, 'whitelist', { name: '.Steve' });
    expect(res.status).toBe(200);
    expect(res.body.whitelist.map((entry) => entry.name)).toEqual(['.Steve']);
    expect(mojang.requests).toHaveLength(0);
    // other names must still be Mojang names
    expect((await post(id, 'whitelist', { name: 'Steve-1' })).status).toBe(400);
  });

  describe('ban reasons', () => {
    const inputs = (id: string): string[] =>
      env.services.manager
        .history(id)
        .filter((line) => line.stream === 'input')
        .map((line) => line.text);

    it('writes umlauts out in the console command', async () => {
      const id = await onlineServer();
      const res = await post(id, 'banned-players', { name: 'Alex', reason: 'Größenwahn über Äcker, Öl und Straße' });
      expect(res.status).toBe(200);
      expect(inputs(id)).toEqual(['ban Alex Groessenwahn ueber Aecker, Oel und Strasse']);
      expect(res.body.bannedPlayers[0]?.reason).toBe('Groessenwahn ueber Aecker, Oel und Strasse');
      const ip = await post(id, 'banned-ips', { ip: '10.1.2.3', reason: 'Müll' });
      expect(ip.body.bannedIps[0]?.reason).toBe('Muell');
    });

    it('refuses other non-ASCII characters with 422 REASON_NOT_ASCII and sends nothing', async () => {
      const id = await onlineServer();
      for (const reason of ['Café', '日本語', 'Smile 😀']) {
        const res = await post(id, 'banned-players', { name: 'Alex', reason });
        expect(res.status, reason).toBe(422);
        expect(res.body.error.code).toBe('REASON_NOT_ASCII');
        expect(res.body.error.message).toContain('ASCII');
      }
      expect((await post(id, 'banned-ips', { ip: '10.1.2.3', reason: 'Café' })).body.error.code).toBe('REASON_NOT_ASCII');
      expect(inputs(id)).toEqual([]);
    });

    it('keeps the full UTF-8 reason when the file is edited', async () => {
      const server = await offlineServer();
      const reason = 'Größe: Café 日本語';
      const res = await post(server.id, 'banned-players', { name: 'Steve', reason });
      expect(res.body.bannedPlayers[0]?.reason).toBe(reason);
      expect(((await readJson(server.id, 'banned-players.json')) as Array<{ reason: string }>)[0]?.reason).toBe(reason);
    });

    it('converts only what the console cannot carry', () => {
      expect(asciiReason('Hello World!')).toBe('Hello World!');
      expect(asciiReason('ÄÖÜäöüß')).toBe('AeOeUeaeoeuess');
      expect(asciiReason('é')).toBeNull();
    });
  });

  describe('whitelist switch', () => {
    const switchTo = (id: string, enabled: boolean) => env.call<PlayersView & ErrorBody>('POST', `${base(id)}/whitelist-enabled`, { enabled });
    const inputs = (id: string): string[] =>
      env.services.manager
        .history(id)
        .filter((line) => line.stream === 'input')
        .map((line) => line.text);

    it('sends whitelist on/off and returns once server.properties shows it', async () => {
      const id = await onlineServer();
      const on = await switchTo(id, true);
      expect(on.status).toBe(200);
      expect(on.body).toMatchObject({ mode: 'live', whitelistEnabled: true, pending: false, notice: null });
      // nothing to do when the file already shows it
      await switchTo(id, true);
      const off = await switchTo(id, false);
      expect(off.body).toMatchObject({ whitelistEnabled: false, pending: false });
      expect(inputs(id)).toEqual(['whitelist on', 'whitelist off']);
    });

    it('reports pending when the file does not change in time', async () => {
      env.spawner.extraEnv = { FAKE_PLAYERS: 'silent' };
      const id = await onlineServer();
      timings.liveWaitMs = 250;
      const res = await switchTo(id, true);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ pending: true, whitelistEnabled: false });
      expect(res.body.notice).toContain('The server');
      expect(inputs(id)).toEqual(['whitelist on']);
    });

    it('is refused while the server is starting', async () => {
      env.spawner.mode = 'silent';
      const server = await env.addServer();
      await env.call('POST', `/api/servers/${server.id}/start`);
      await env.waitState(server.id, 'starting');
      const res = await switchTo(server.id, true);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAYERS_BUSY');
      expect(await readFile(path.join(env.serverDir(server.id), 'server.properties'), 'utf8').catch(() => '')).not.toContain('white-list');
    });
  });

  it('refuses to touch a corrupt file while the server runs', async () => {
    const id = await onlineServer();
    await writeFile(path.join(env.serverDir(id), 'ops.json'), 'garbage');
    const res = await post(id, 'ops', { name: 'Steve' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAYER_LIST_CORRUPT');
    expect(env.services.manager.history(id).filter((line) => line.stream === 'input')).toEqual([]);
  });

  it('edits the files again once the server has stopped', async () => {
    const id = await onlineServer();
    await post(id, 'whitelist', { name: 'Steve' });
    const stopped = await env.call('POST', `/api/servers/${id}/stop`);
    expect(stopped.status).toBe(200);
    await env.waitState(id, 'offline');
    await setProperties(id, 'online-mode=false\n');
    const view = (await get(id)).body;
    expect(view).toMatchObject({ mode: 'file', busy: false });
    expect(view.whitelist.map((entry) => entry.name)).toEqual(['Steve']);
    const added = await post(id, 'whitelist', { name: 'Alex' });
    expect(added.body.whitelist.map((entry) => entry.name)).toEqual(['Steve', 'Alex']);
  });

  it('refuses changes while the server is starting', async () => {
    env.spawner.mode = 'silent';
    const server = await env.addServer();
    await env.call('POST', `/api/servers/${server.id}/start`);
    await env.waitState(server.id, 'starting');
    const res = await post(server.id, 'whitelist', { name: 'Steve' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAYERS_BUSY');
    expect(res.body.error.message).toBe('Wait until the server is running or stopped.');
    expect((await del(server.id, 'banned-ips', '10.0.0.1')).status).toBe(409);
    // reading still works and says why changes are not possible
    expect((await get(server.id)).body).toMatchObject({ busy: true, mode: 'file' });
    expect(mojang.requests).toHaveLength(0);
    expect(await readdir(env.serverDir(server.id))).not.toContain('whitelist.json');
  });

  it('refuses changes while the server is stopping', async () => {
    env.spawner.mode = 'ignore-stop';
    const id = await onlineServer();
    await env.call('POST', `/api/servers/${id}/stop`);
    await env.waitState(id, 'stopping');
    const res = await post(id, 'ops', { name: 'Steve' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAYERS_BUSY');
  });
});

describe('concurrent changes', () => {
  it('keeps every entry when several players are added at once', async () => {
    const server = await offlineServer();
    const names = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'];
    const results = await Promise.all(names.map((name) => post(server.id, 'whitelist', { name })));
    expect(results.every((res) => res.status === 200)).toBe(true);
    const saved = (await readJson(server.id, 'whitelist.json')) as Array<{ name: string }>;
    expect(saved.map((entry) => entry.name).sort()).toEqual(names);
  });
});
