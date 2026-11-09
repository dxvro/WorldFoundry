import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_MAX_MB, IMPORT_MAX_MB_LIMIT, loadConfig } from '../src/config/env.js';
import type { ImportJobDto } from '../src/contract.js';
import { sameVolume, sizeText } from '../src/lib/disk.js';
import { buildZip } from './archive-builders.js';
import { ServerEnv, scratchDir, waitFor } from './server-env.js';
import { worldEntries } from './world-fixtures.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; params?: Record<string, unknown> };
}

describe('import size limit configuration', () => {
  it('defaults to 256 GB and still takes an override up to 1 TB', () => {
    expect(DEFAULT_IMPORT_MAX_MB).toBe(262_144);
    expect(loadConfig({}).importMaxMb).toBe(262_144);
    expect(loadConfig({ IMPORT_MAX_MB: '' }).importMaxMb).toBe(262_144);
    expect(loadConfig({ IMPORT_MAX_MB: '1024' }).importMaxMb).toBe(1024);
    expect(loadConfig({ IMPORT_MAX_MB: String(IMPORT_MAX_MB_LIMIT) }).importMaxMb).toBe(1_048_576);
    expect(() => loadConfig({ IMPORT_MAX_MB: String(IMPORT_MAX_MB_LIMIT + 1) })).toThrow(/IMPORT_MAX_MB/);
    expect(() => loadConfig({ IMPORT_MAX_MB: '8' })).toThrow(/IMPORT_MAX_MB/);
  });

  it('shows sizes in GB from one gigabyte on and counts 64-bit values exactly', () => {
    expect(sizeText(200 * MIB)).toBe('200 MB');
    expect(sizeText(50 * GIB)).toBe('50 GB');
    expect(sizeText(48.52 * GIB)).toBe('48.6 GB');
    expect(sizeText(256 * GIB + 1)).toBe('256.1 GB');
  });
});

describe('uploading a world of 50 GB and more', () => {
  let env: ServerEnv;
  let free = Number.MAX_SAFE_INTEGER;

  async function setup(options: Parameters<typeof ServerEnv.create>[0] = {}): Promise<void> {
    env = await ServerEnv.create({ freeSpace: async () => free, ...options });
  }
  beforeEach(async () => {
    free = Number.MAX_SAFE_INTEGER;
    await setup();
  });
  afterEach(async () => {
    await env.services.imports.idle();
    await env.close();
  });

  const post = (payload: Buffer | Readable, headers: Record<string, string> = {}, query = '') =>
    env.app.inject({ method: 'POST', url: `/api/imports${query}`, headers: { 'content-type': 'application/octet-stream', ...headers }, payload: payload as Buffer });
  const tmpEntries = (): Promise<string[]> => readdir(path.join(env.config.dataDir, 'tmp', 'imports')).catch(() => []);

  it('allows 256 GB by default and reports the limit as an exact number', async () => {
    const res = await env.call<{ maxUploadBytes: number }>('GET', '/api/imports/limits');
    expect(res.body.maxUploadBytes).toBe(256 * GIB);
    expect(res.body.maxUploadBytes).toBe(DEFAULT_IMPORT_MAX_MB * MIB);
    expect(env.services.imports.maxUploadBytes).toBeGreaterThan(2 ** 32);
  });

  it('does not time out long uploads: no request, socket or connection timeout on the server', () => {
    const server = env.app.server;
    expect(server.requestTimeout).toBe(0);
    expect(server.timeout).toBe(0);
    // only the time to receive the headers is limited
    expect(server.headersTimeout).toBeGreaterThan(0);
  });

  it('accepts an announced size of 60 GB through the body limit and the free-space check', async () => {
    // the announced length is only a header here; the body ends early and the check fails because it is no archive
    const res = await post(Buffer.from('not an archive'), { 'content-length': String(60 * GIB) });
    // the stream ends before the announced length: that is an aborted upload, not "too large"
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).not.toBe(507);
    await env.services.imports.idle();
    expect(await tmpEntries()).toEqual([]);
  });

  it('refuses an announced size above the limit at once, with the limit in the message', async () => {
    const res = await post(Buffer.from('x'), { 'content-length': String(300 * GIB) });
    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body) as ErrorBody;
    expect(body.error.code).toBe('IMPORT_TOO_LARGE');
    expect(body.error.message).toContain('256 GB');
    expect(body.error.message).toContain('IMPORT_MAX_MB');
  });

  it('refuses a 60 GB upload before receiving anything when the disk cannot hold upload and unpacked world', async () => {
    free = 100 * GIB;
    const res = await post(Buffer.from('x'), { 'content-length': String(60 * GIB) });
    expect(res.statusCode).toBe(507);
    const body = JSON.parse(res.body) as ErrorBody;
    expect(body.error.code).toBe('DISK_FULL');
    // twice the archive (upload plus unpacked world) and a reserve
    expect(body.error.details).toMatchObject({ neededBytes: 120 * GIB + 128 * MIB, freeBytes: 100 * GIB });
    expect(body.error.params).toMatchObject({ purpose: 'upload', neededMb: 120 * 1024 + 128, freeMb: 100 * 1024 });
    expect(body.error.message).toContain('120.2 GB needed');
    expect(body.error.message).toContain('100 GB free');
    expect(await tmpEntries()).toEqual([]);
  });

  it('checks the space for the safety backup and the move before replacing a world', async () => {
    const server = await env.addServer();
    const file = (relative: string): string => path.join(env.serverDir(server.id), ...relative.split('/'));
    await writeFile(file('server.properties'), 'level-name=world\n');
    await mkdir(file('world/region'), { recursive: true });
    await writeFile(file('world/level.dat'), 'old');
    await writeFile(file('world/region/r.0.0.mca'), Buffer.alloc(8 * MIB, 7));
    const uploaded = await post(buildZip(worldEntries('w', { versionName: '1.21.1' })), {}, `?serverId=${server.id}`);
    expect(uploaded.statusCode).toBe(202);
    const id = (JSON.parse(uploaded.body) as { import: ImportJobDto }).import.id;
    const job = await waitFor(async () => {
      const res = await env.call<{ import: ImportJobDto }>('GET', `/api/imports/${id}`);
      return res.body.import.status === 'staged' || res.body.import.status === 'failed' ? res.body.import : undefined;
    }, 15_000, 'staged');
    expect(job.status).toBe('staged');

    // the old world is 8 MB; its safety backup (barely compressible, so about 90 percent) shares the volume
    free = 64 * MIB + 6 * MIB;
    const replace = await env.call<{ import: ImportJobDto } & ErrorBody>('POST', `/api/servers/${server.id}/world/replace`, { importId: id, acknowledged: [] });
    expect(replace.status).toBe(202);
    const failed = await waitFor(async () => {
      const res = await env.call<{ import: ImportJobDto }>('GET', `/api/imports/${id}`);
      return res.body.import.status === 'failed' ? res.body.import : undefined;
    }, 15_000, 'failed');
    expect(failed.errorRef).toMatchObject({ key: 'DISK_FULL', params: { purpose: 'world-replace' } });
    expect(failed.error).toContain('needed');
    // nothing was touched
    expect((await readdir(env.serverDir(server.id))).filter((name) => name.startsWith('.import'))).toEqual([]);
  });

  it('knows which paths share a volume', async () => {
    const dir = await scratchDir('vol-');
    expect(await sameVolume(dir, path.join(dir, 'does', 'not', 'exist'))).toBe(true);
  });
});
