import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerEnv } from './server-env.js';

let env: ServerEnv;
beforeEach(async () => {
  env = await ServerEnv.create();
});
afterEach(async () => {
  await env.close();
});

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// a real, plain RGBA PNG of the given size
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const put = (id: string, body: Buffer, type = 'image/png') =>
  env.app.inject({ method: 'PUT', url: `/api/servers/${id}/icon`, payload: body, headers: { 'content-type': type } });

describe('server icon', () => {
  it('stores, serves and removes server-icon.png', async () => {
    const server = await env.addServer();
    expect((await env.app.inject({ method: 'GET', url: `/api/servers/${server.id}/icon` })).statusCode).toBe(404);

    const icon = png(64, 64);
    const res = await put(server.id, icon);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restartRequired: false });
    expect(await readFile(path.join(env.serverDir(server.id), 'server-icon.png'))).toEqual(icon);

    const got = await env.app.inject({ method: 'GET', url: `/api/servers/${server.id}/icon` });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.rawPayload).toEqual(icon);

    expect((await env.call('DELETE', `/api/servers/${server.id}/icon`)).status).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: `/api/servers/${server.id}/icon` })).statusCode).toBe(404);
  });

  it('refuses pictures of another size or format', async () => {
    const server = await env.addServer();
    const wrongSize = await put(server.id, png(128, 128));
    expect(wrongSize.statusCode).toBe(422);
    expect(wrongSize.json()).toMatchObject({ error: { code: 'SERVER_ICON_INVALID', params: { reason: 'size', width: 128, height: 128 } } });

    const notPng = await put(server.id, Buffer.from('GIF89a not a png at all......'));
    expect(notPng.statusCode).toBe(422);
    expect(notPng.json()).toMatchObject({ error: { code: 'SERVER_ICON_INVALID', params: { reason: 'not-png' } } });

    expect((await put(server.id, png(64, 64), 'image/jpeg')).statusCode).toBe(415);
    expect((await put(server.id, Buffer.alloc(300 * 1024))).statusCode).toBe(413);
  });

  it('is only available for Minecraft servers', async () => {
    const server = await env.addServer({ game: 'zomboid', loader: 'vanilla', mcVersion: '' });
    const res = await put(server.id, png(64, 64));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'GAME_FEATURE_UNSUPPORTED' } });
  });
});
