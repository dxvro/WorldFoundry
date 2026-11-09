import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PropertiesDocument, decodeProperties } from '../src/properties/parser.js';
import { loadProperties, saveProperties } from '../src/properties/store.js';
import { PropertiesPatchSchema, applyPatch, extraProperties, readTyped } from '../src/properties/typed.js';
import { ServerEnv, scratchDir } from './server-env.js';

const roundTrip = (text: string): string => PropertiesDocument.parse(text).serialize();

describe('PropertiesDocument', () => {
  const sample = [
    '#Minecraft server properties',
    '#Wed Nov 04 12:00:00 CET 2026',
    'accepts-transfers=false',
    'motd=A Minecraft Server',
    '',
    'server-port=25565',
    'weird   =   spaced value  ',
    'unknown.key:colon value',
    '! another comment',
    'last=one',
    '',
  ].join('\n');

  it('round-trips untouched files byte for byte, including odd formatting', () => {
    expect(roundTrip(sample)).toBe(sample);
    expect(roundTrip(sample.replace(/\n/g, '\r\n'))).toBe(sample.replace(/\n/g, '\r\n'));
    expect(roundTrip('no-trailing-newline=1')).toBe('no-trailing-newline=1');
    expect(roundTrip('')).toBe('');
    expect(roundTrip('a=1\nb=2\r\nc=3\r')).toBe('a=1\nb=2\r\nc=3\r');
  });

  it('reads keys and values in the Java way', () => {
    const doc = PropertiesDocument.parse(sample);
    expect(doc.get('motd')).toBe('A Minecraft Server');
    expect(doc.get('weird')).toBe('spaced value  ');
    expect(doc.get('unknown.key')).toBe('colon value');
    expect(doc.get('missing')).toBeUndefined();
  });

  it('decodes escapes: \\: \\= \\\\ \\uXXXX and tabs', () => {
    const doc = PropertiesDocument.parse('motd=Welcome\\: \\u00A7aGr\\u00FCn \\\\ a\\=b\\tc\nk\\=ey\\:x=v\n');
    expect(doc.get('motd')).toBe('Welcome: §aGrün \\ a=b\tc');
    expect(doc.get('k=ey:x')).toBe('v');
  });

  it('keeps the last definition of duplicate keys like java.util.Properties', () => {
    const doc = PropertiesDocument.parse('a=1\na=2\n');
    expect(doc.get('a')).toBe('2');
    doc.set('a', '3');
    expect(doc.serialize()).toBe('a=1\na=3\n');
  });

  it('handles line continuations', () => {
    const doc = PropertiesDocument.parse('long=one \\\n    two\\\n  three\nnext=1\n');
    expect(doc.get('long')).toBe('one two' + 'three');
    expect(doc.get('next')).toBe('1');
    doc.set('next', '2');
    expect(doc.serialize()).toBe('long=one \\\n    two\\\n  three\nnext=2\n');
  });

  it('changes only the touched line and keeps comments, order and CRLF', () => {
    const crlf = sample.replace(/\n/g, '\r\n');
    const doc = PropertiesDocument.parse(crlf);
    doc.set('server-port', '25570');
    expect(doc.serialize()).toBe(crlf.replace('server-port=25565', 'server-port=25570'));
  });

  it('does not rewrite a line when the value is unchanged', () => {
    const doc = PropertiesDocument.parse('weird   =   spaced value  \n');
    doc.set('weird', 'spaced value  ');
    expect(doc.serialize()).toBe('weird   =   spaced value  \n');
  });

  it('writes escapes the way Java does and survives a read-back', () => {
    const doc = PropertiesDocument.parse('a=1\n');
    const motd = '§aÖsterreich: Part #1 = ok! \\ end\ttab';
    doc.set('motd', motd);
    doc.set('key with space', ' lead');
    const text = doc.serialize();
    expect(text).toContain('motd=\\u00A7a\\u00D6sterreich\\: Part \\#1 \\= ok\\! \\\\ end\\ttab\n');
    expect(text).toContain('key\\ with\\ space=\\ lead\n');
    expect(text).toMatch(/^[\x00-\x7f]*$/);
    const back = PropertiesDocument.parse(text);
    expect(back.get('motd')).toBe(motd);
    expect(back.get('key with space')).toBe(' lead');
  });

  it('appends new keys with the file line ending, even without a final newline', () => {
    const lf = PropertiesDocument.parse('a=1');
    lf.set('b', '2');
    expect(lf.serialize()).toBe('a=1\nb=2\n');
    const crlf = PropertiesDocument.parse('a=1\r\nc=3');
    crlf.set('b', '2');
    expect(crlf.serialize()).toBe('a=1\r\nc=3\r\nb=2\r\n');
    const empty = PropertiesDocument.empty();
    empty.set('x', 'y');
    expect(empty.serialize()).toBe('x=y\n');
  });

  it('decodes UTF-8 and falls back to latin1 for legacy files', () => {
    expect(decodeProperties(Buffer.from('motd=Grüße', 'utf8'))).toEqual({ text: 'motd=Grüße', encoding: 'utf8' });
    expect(decodeProperties(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ text: 'a', encoding: 'utf8' });
    const latin = decodeProperties(Buffer.from('motd=Gr\xfc\xdfe', 'latin1'));
    expect(latin).toEqual({ text: 'motd=Grüße', encoding: 'latin1' });
    const doc = PropertiesDocument.parse(latin.text, latin.encoding);
    expect(Buffer.from(doc.serialize(), doc.encoding)).toEqual(Buffer.from('motd=Gr\xfc\xdfe', 'latin1'));
  });
});

describe('typed properties', () => {
  it('applies defaults, fixes invalid values and understands legacy numbers', () => {
    expect(readTyped(PropertiesDocument.empty())).toEqual({
      'server-port': 25565,
      gamemode: 'survival',
      difficulty: 'easy',
      'white-list': false,
      'max-players': 20,
      'view-distance': 10,
      'online-mode': true,
      motd: 'A Minecraft Server',
    });
    const doc = PropertiesDocument.parse('gamemode=1\ndifficulty=HARD\nview-distance=99\nserver-port=abc\nwhite-list=TRUE\nonline-mode=maybe\n');
    expect(readTyped(doc)).toMatchObject({
      gamemode: 'creative',
      difficulty: 'hard',
      'view-distance': 10,
      'server-port': 25565,
      'white-list': true,
      'online-mode': true,
    });
  });

  it('validates the patch ranges', () => {
    const bad = [{ 'server-port': 0 }, { 'server-port': 70000 }, { 'view-distance': 1 }, { 'view-distance': 33 }, { gamemode: 'god' }, { 'max-players': 0 }, {}, { unknown: 1 }];
    for (const patch of bad) expect(PropertiesPatchSchema.safeParse(patch).success).toBe(false);
    expect(PropertiesPatchSchema.safeParse({ 'server-port': 1, 'view-distance': 2, motd: 'x' }).success).toBe(true);
    expect(PropertiesPatchSchema.safeParse({ 'server-port': 65535, 'view-distance': 32 }).success).toBe(true);
  });

  it('writes only patched keys and leaves unknown ones alone', () => {
    const doc = PropertiesDocument.parse('# c\nspawn-protection=16\nmotd=old\n');
    applyPatch(doc, { motd: 'new', 'white-list': true });
    expect(doc.serialize()).toBe('# c\nspawn-protection=16\nmotd=new\nwhite-list=true\n');
    expect(extraProperties(doc)).toEqual({ 'spawn-protection': '16' });
  });

  it('keeps writing numbers for gamemode and difficulty when the file uses them, and names otherwise', () => {
    const numbered = PropertiesDocument.parse('gamemode=0\ndifficulty=1\n');
    applyPatch(numbered, { gamemode: 'creative', difficulty: 'hard' });
    expect(numbered.serialize()).toBe('gamemode=1\ndifficulty=3\n');
    const named = PropertiesDocument.parse('gamemode=survival\ndifficulty=easy\n');
    applyPatch(named, { gamemode: 'spectator', difficulty: 'peaceful' });
    expect(named.serialize()).toBe('gamemode=spectator\ndifficulty=peaceful\n');
    const absent = PropertiesDocument.parse('motd=x\n');
    applyPatch(absent, { gamemode: 'adventure' }, true);
    expect(absent.serialize()).toBe('motd=x\ngamemode=2\n');
    applyPatch(absent, { difficulty: 'normal' });
    expect(absent.get('difficulty')).toBe('normal');
  });
});

describe('properties files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await scratchDir('props-');
  });

  it('creates an absent file and replaces atomically without leftovers', async () => {
    const { doc, exists } = await loadProperties(dir);
    expect(exists).toBe(false);
    doc.set('server-port', '25570');
    await saveProperties(dir, doc);
    expect(await readFile(path.join(dir, 'server.properties'), 'utf8')).toBe('server-port=25570\n');
    doc.set('motd', 'Grüße');
    await saveProperties(dir, doc);
    expect(await readFile(path.join(dir, 'server.properties'), 'utf8')).toBe('server-port=25570\nmotd=Gr\\u00FC\\u00DFe\n');
    expect(await readdir(dir)).toEqual(['server.properties']);
  });
});

describe('properties API', () => {
  let env: ServerEnv;
  beforeEach(async () => {
    env = await ServerEnv.create();
  });
  afterEach(async () => {
    await env.close();
  });

  it('returns defaults with the database port when the file is absent, and creates it on PATCH', async () => {
    const server = await env.addServer({ port: 25570 });
    const read = await env.call<{ exists: boolean; properties: Record<string, unknown> }>('GET', `/api/servers/${server.id}/properties`);
    expect(read.body.exists).toBe(false);
    expect(read.body.properties['server-port']).toBe(25570);

    const patched = await env.call<{ restartRequired: boolean; properties: Record<string, unknown> }>('PATCH', `/api/servers/${server.id}/properties`, {
      motd: 'Hello World',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.restartRequired).toBe(false);
    const text = await readFile(path.join(env.serverDir(server.id), 'server.properties'), 'utf8');
    expect(text).toBe('server-port=25570\nmotd=Hello World\n');
  });

  it('keeps unknown keys and comments, and syncs the database port after the file write', async () => {
    const server = await env.addServer({ port: 25570 });
    const file = path.join(env.serverDir(server.id), 'server.properties');
    await writeFile(file, '# comment\r\nspawn-protection=16\r\nserver-port=25570\r\n');
    const res = await env.call<{ extra: Record<string, string> }>('PATCH', `/api/servers/${server.id}/properties`, { 'server-port': 25599, difficulty: 'hard' });
    expect(res.status).toBe(200);
    expect(res.body.extra).toEqual({ 'spawn-protection': '16' });
    expect(await readFile(file, 'utf8')).toBe('# comment\r\nspawn-protection=16\r\nserver-port=25599\r\ndifficulty=hard\r\n');
    expect((await env.row(server.id))?.port).toBe(25599);
  });

  it('writes numeric gamemode and difficulty for Minecraft 1.12.2, which ignores names', async () => {
    const legacy = await env.addServer({ mcVersion: '1.12.2', loader: 'forge', port: 25571 });
    const res = await env.call('PATCH', `/api/servers/${legacy.id}/properties`, { gamemode: 'creative', difficulty: 'hard' });
    expect(res.status).toBe(200);
    expect(await readFile(path.join(env.serverDir(legacy.id), 'server.properties'), 'utf8')).toBe('server-port=25571\ngamemode=1\ndifficulty=3\n');
    const read = await env.call<{ properties: Record<string, unknown> }>('GET', `/api/servers/${legacy.id}/properties`);
    expect(read.body.properties).toMatchObject({ gamemode: 'creative', difficulty: 'hard' });
    const modern = await env.addServer({ port: 25572 });
    await env.call('PATCH', `/api/servers/${modern.id}/properties`, { gamemode: 'creative', difficulty: 'hard' });
    expect(await readFile(path.join(env.serverDir(modern.id), 'server.properties'), 'utf8')).toBe('server-port=25572\ngamemode=creative\ndifficulty=hard\n');
  });

  it('rejects invalid values with 400 and leaves file and database untouched', async () => {
    const server = await env.addServer({ port: 25570 });
    const res = await env.call<{ error: { code: string } }>('PATCH', `/api/servers/${server.id}/properties`, { 'server-port': 70000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    await expect(readdir(env.serverDir(server.id))).resolves.not.toContain('server.properties');
    expect((await env.row(server.id))?.port).toBe(25570);
  });

  it('returns 404 for unknown servers', async () => {
    const res = await env.call<{ error: { code: string } }>('GET', '/api/servers/nope/properties');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SERVER_NOT_FOUND');
  });

  it('answers restartRequired while the server runs', async () => {
    const server = await env.addServer();
    expect((await env.call('POST', `/api/servers/${server.id}/start`)).status).toBe(200);
    await env.waitState(server.id, 'online');
    const res = await env.call<{ restartRequired: boolean }>('PATCH', `/api/servers/${server.id}/properties`, { motd: 'live' });
    expect(res.status).toBe(200);
    expect(res.body.restartRequired).toBe(true);
    await mkdir(env.serverDir(server.id), { recursive: true });
  });
});
