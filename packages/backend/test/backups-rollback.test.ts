import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const blocked = vi.hoisted(() => ({ renameTo: new Set<string>(), fromPattern: null as RegExp | null, code: 'EBUSY' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if ([...blocked.renameTo].some((fragment) => to.includes(fragment)) || blocked.fromPattern?.test(from) === true) {
        throw Object.assign(new Error(`${blocked.code}: locked`), { code: blocked.code, path: to });
      }
      return actual.rename(from, to);
    },
  };
});

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BackupDto, BackupListResponse } from '../src/contract.js';
import { ServerEnv } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string };
}

let env: ServerEnv;
beforeEach(async () => {
  env = await ServerEnv.create();
});
afterEach(async () => {
  blocked.renameTo.clear();
  blocked.fromPattern = null;
  blocked.code = 'EBUSY';
  await env.close();
});

const write = async (serverId: string, relative: string, content: string): Promise<void> => {
  const file = path.join(env.serverDir(serverId), ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};
const read = (serverId: string, relative: string): Promise<string> => readFile(path.join(env.serverDir(serverId), ...relative.split('/')), 'utf8');

async function prepared(): Promise<{ serverId: string; backup: BackupDto }> {
  const server = await env.addServer();
  await write(server.id, 'world/level.dat', 'safe');
  await write(server.id, 'world_nether/DIM-1/r.mca', 'nether-safe');
  await write(server.id, 'world_the_end/DIM1/r.mca', 'end-safe');
  const created = await env.call<{ backup: BackupDto }>('POST', `/api/servers/${server.id}/backups`);
  await env.services.backups.idle();
  await write(server.id, 'world/level.dat', 'current');
  await write(server.id, 'world_nether/DIM-1/r.mca', 'nether-current');
  await write(server.id, 'world_the_end/DIM1/r.mca', 'end-current');
  return { serverId: server.id, backup: created.body.backup };
}

describe('restore failing half way through the swap', () => {
  it('puts every folder back when one cannot be moved into place', async () => {
    const { serverId, backup } = await prepared();
    // the Nether is the second folder placed; the first (world) is already in its new place by then
    blocked.fromPattern = /\.restore-new-[^\\/]+[\\/]world_nether$/;
    const res = await env.call<ErrorBody>('POST', `/api/servers/${serverId}/backups/${backup.id}/restore`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FILE_LOCKED');
    expect(await read(serverId, 'world/level.dat')).toBe('current');
    expect(await read(serverId, 'world_nether/DIM-1/r.mca')).toBe('nether-current');
    expect(await read(serverId, 'world_the_end/DIM1/r.mca')).toBe('end-current');
    expect((await readdir(env.serverDir(serverId))).filter((name) => name.startsWith('.restore'))).toEqual([]);
    // the safety backup was made before anything was touched and stays available
    const list = await env.call<BackupListResponse>('GET', `/api/servers/${serverId}/backups`);
    const safety = list.body.backups.find((entry) => entry.kind === 'safety');
    expect(safety?.status).toBe('ok');
  });

  it('keeps the old data when it cannot even be moved aside', async () => {
    const { serverId, backup } = await prepared();
    blocked.renameTo.add('.restore-old-');
    const res = await env.call<ErrorBody>('POST', `/api/servers/${serverId}/backups/${backup.id}/restore`);
    expect(res.status).toBe(409);
    expect(await read(serverId, 'world/level.dat')).toBe('current');
    expect(await read(serverId, 'world_nether/DIM-1/r.mca')).toBe('nether-current');
    expect((await readdir(env.serverDir(serverId))).filter((name) => name.startsWith('.restore'))).toEqual([]);
  });

  it('reports an unexpected file system error and still restores nothing', async () => {
    const { serverId, backup } = await prepared();
    blocked.code = 'EIO';
    blocked.fromPattern = /\.restore-new-[^\\/]+[\\/]world_the_end$/;
    const res = await env.call<ErrorBody>('POST', `/api/servers/${serverId}/backups/${backup.id}/restore`);
    expect(res.status).toBe(500);
    expect(await read(serverId, 'world/level.dat')).toBe('current');
    expect(await read(serverId, 'world_the_end/DIM1/r.mca')).toBe('end-current');
  });
});
