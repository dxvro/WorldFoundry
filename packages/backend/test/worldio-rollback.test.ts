import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const blocked = vi.hoisted(() => ({ toPattern: null as RegExp | null, code: 'EBUSY' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (blocked.toPattern?.test(to) === true) {
        // one failure only, so the rollback that follows can move things back
        if (!blocked.toPattern.source.includes('import-old')) blocked.toPattern = null;
        throw Object.assign(new Error(`${blocked.code}: locked`), { code: blocked.code, path: to });
      }
      return actual.rename(from, to);
    },
  };
});

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImportJobDto } from '../src/contract.js';
import { buildZip } from './archive-builders.js';
import { ServerEnv, waitFor } from './server-env.js';
import { worldEntries } from './world-fixtures.js';

let env: ServerEnv;
beforeEach(async () => {
  env = await ServerEnv.create();
});
afterEach(async () => {
  blocked.toPattern = null;
  blocked.code = 'EBUSY';
  await env.services.imports.idle();
  await env.close();
});

const write = async (serverId: string, relative: string, content: string): Promise<void> => {
  const file = path.join(env.serverDir(serverId), ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};
const read = (serverId: string, relative: string): Promise<string> => readFile(path.join(env.serverDir(serverId), ...relative.split('/')), 'utf8');

async function attempt(): Promise<{ serverId: string; job: ImportJobDto }> {
  const server = await env.addServer();
  await write(server.id, 'server.properties', 'level-name=world\n');
  await write(server.id, 'world/level.dat', 'old');
  await write(server.id, 'world/region/r.0.0.mca', 'old-world');
  await write(server.id, 'world_nether/DIM-1/region/r.0.0.mca', 'altes-nether');
  await write(server.id, 'world_the_end/DIM1/region/r.0.0.mca', 'altes-end');
  const response = await env.app.inject({
    method: 'POST',
    url: `/api/imports?serverId=${server.id}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: buildZip(worldEntries('x', { versionName: '1.21.1', dims: 'split' })),
  });
  const id = (JSON.parse(response.body) as { import: ImportJobDto }).import.id;
  await waitFor(async () => (await env.call<{ import: ImportJobDto }>('GET', `/api/imports/${id}`)).body.import.status === 'staged' || undefined);
  const started = await env.call('POST', `/api/servers/${server.id}/world/replace`, { importId: id, acknowledged: [] });
  expect(started.status).toBe(202);
  const job = await waitFor(async () => {
    const current = (await env.call<{ import: ImportJobDto }>('GET', `/api/imports/${id}`)).body.import;
    return current.status === 'failed' || current.status === 'done' ? current : undefined;
  });
  return { serverId: server.id, job };
}

describe('replacing a world fails half way', () => {
  it('puts every folder back when one cannot be moved into place', async () => {
    // all three old folders are moved aside first; moving the new world into place is the step that fails
    blocked.code = 'EIO';
    blocked.toPattern = /[\\/]servers[\\/][^\\/]+[\\/]world$/;
    const { serverId, job } = await attempt();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('unexpected reason');
    expect(await read(serverId, 'world/region/r.0.0.mca')).toBe('old-world');
    expect(await read(serverId, 'world_nether/DIM-1/region/r.0.0.mca')).toBe('altes-nether');
    expect(await read(serverId, 'world_the_end/DIM1/region/r.0.0.mca')).toBe('altes-end');
    expect((await readdir(env.serverDir(serverId))).filter((name) => name.startsWith('.import'))).toEqual([]);
    // the safety backup was made first and stays
    const list = await env.call<{ backups: Array<{ kind: string; status: string }> }>('GET', `/api/servers/${serverId}/backups`);
    expect(list.body.backups).toEqual([expect.objectContaining({ kind: 'safety', status: 'ok' })]);
    expect(await readdir(path.join(env.config.dataDir, 'tmp', 'imports')).catch(() => [])).toEqual([]);
  });

  it('keeps the old world when it cannot be moved aside', async () => {
    blocked.toPattern = /\.import-old-[^\\/]+[\\/]world$/;
    const { serverId, job } = await attempt();
    expect(job.status).toBe('failed');
    expect(await read(serverId, 'world/region/r.0.0.mca')).toBe('old-world');
    expect(await read(serverId, 'world_the_end/DIM1/region/r.0.0.mca')).toBe('altes-end');
    expect((await readdir(env.serverDir(serverId))).filter((name) => name.startsWith('.import'))).toEqual([]);
  });
});
