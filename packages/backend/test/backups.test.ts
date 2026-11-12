import { and, eq } from 'drizzle-orm';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTarGz } from '../src/archive/tar.js';
import type { BackupDto, BackupListResponse, RestoreResponse } from '../src/contract.js';
import { backups, servers, type Server } from '../src/db/schema.js';
import type { AppEvent } from '../src/events/bus.js';
import { buildTarGz } from './archive-builders.js';
import { ServerEnv, scratchDir, wait, waitFor } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string; details?: { count?: number } };
}

let env: ServerEnv;
let events: AppEvent[];
let eventsFile: string;

const SMALL_TIMINGS = { saveOffMs: 400, flushMs: 1500, saveOnMs: 400 };

async function setup(options: Parameters<typeof ServerEnv.create>[0] = {}): Promise<void> {
  env = await ServerEnv.create({ saveTimings: SMALL_TIMINGS, ...options });
  events = [];
  env.services.bus.subscribe((event) => events.push(event));
  eventsFile = path.join(await scratchDir('events-'), 'fake-events.log');
  env.spawner.extraEnv['FAKE_EVENTS_FILE'] = eventsFile;
}

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await env.close();
});

const backupsDir = (serverId: string): string => path.join(env.config.dataDir, 'backups', serverId);
const list = (serverId: string) => env.call<BackupListResponse>('GET', `/api/servers/${serverId}/backups`);
const create = (serverId: string, body: Record<string, unknown> = {}) => env.call<{ backup: BackupDto } & ErrorBody>('POST', `/api/servers/${serverId}/backups`, body);
const write = async (serverId: string, relative: string, content: string | Buffer): Promise<void> => {
  const file = path.join(env.serverDir(serverId), ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};
const read = (serverId: string, relative: string): Promise<string> => readFile(path.join(env.serverDir(serverId), ...relative.split('/')), 'utf8');
const exists = (serverId: string, relative: string): Promise<boolean> =>
  stat(path.join(env.serverDir(serverId), ...relative.split('/'))).then(
    () => true,
    () => false,
  );

async function seedWorld(serverId: string, level = 'world'): Promise<void> {
  await write(serverId, 'server.properties', `#Minecraft server properties\nlevel-name=${level}\nserver-port=25599\n`);
  await write(serverId, `${level}/level.dat`, 'level-1');
  await write(serverId, `${level}/region/r.0.0.mca`, Buffer.alloc(30_000, 5));
  await write(serverId, `${level}/session.lock`, 'locked');
  await write(serverId, `${level}_nether/DIM-1/region/r.0.0.mca`, 'nether-1');
  await write(serverId, `${level}_the_end/DIM1/region/r.0.0.mca`, 'end-1');
}

async function finished(serverId: string): Promise<BackupDto> {
  await env.services.backups.idle();
  const dto = (await list(serverId)).body.backups[0];
  if (dto === undefined) throw new Error('no backup');
  return dto;
}

async function backupNow(serverId: string, body: Record<string, unknown> = {}): Promise<BackupDto> {
  const res = await create(serverId, body);
  expect(res.status).toBe(202);
  await env.services.backups.idle();
  return (await list(serverId)).body.backups.find((entry) => entry.id === res.body.backup.id) as BackupDto;
}

async function unpack(dto: BackupDto, name = 'unpacked'): Promise<string> {
  const target = path.join(await scratchDir('unpack-'), name);
  await extractTarGz(path.join(backupsDir(dto.serverId), dto.fileName), target, { maxBytes: 1e9, maxEntries: 100_000 });
  return target;
}

const fakeEvents = async (): Promise<string[]> =>
  (await readFile(eventsFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(' ') + 1));

const online = async (serverId: string): Promise<void> => {
  expect((await env.call('POST', `/api/servers/${serverId}/start`)).status).toBe(200);
  await env.waitState(serverId, 'online');
};

describe('creating a backup of a stopped server', () => {
  it('archives the world with Nether and End, skips session.lock and describes itself in a manifest', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const res = await create(server.id);
    expect(res.status).toBe(202);
    expect(res.body.backup).toMatchObject({ kind: 'manual', status: 'running', levelName: 'world', includesConfig: false });
    const dto = await finished(server.id);
    expect(dto).toMatchObject({ status: 'ok', kind: 'manual', worlds: ['world', 'world_nether', 'world_the_end'], error: null });
    expect(dto.sizeBytes).toBeGreaterThan(0);
    expect(dto.rawBytes).toBe(7 + 30_000 + 'nether-1'.length + 'end-1'.length);
    expect(dto.fileName).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-manual-[0-9a-f]{8}\.tar\.gz$/);

    const dir = await unpack(dto);
    expect(await readFile(path.join(dir, 'world', 'level.dat'), 'utf8')).toBe('level-1');
    expect(await readFile(path.join(dir, 'world_nether', 'DIM-1', 'region', 'r.0.0.mca'), 'utf8')).toBe('nether-1');
    expect(await readFile(path.join(dir, 'world_the_end', 'DIM1', 'region', 'r.0.0.mca'), 'utf8')).toBe('end-1');
    expect(await readdir(path.join(dir, 'world'))).not.toContain('session.lock');
    expect(JSON.parse(await readFile(path.join(dir, 'worldfoundry-backup.json'), 'utf8'))).toMatchObject({ format: 1, levelName: 'world', configItems: [] });
    expect(await readdir(dir)).not.toContain('server.properties');
    expect(await readdir(backupsDir(server.id))).toEqual([dto.fileName]);
  });

  it('follows level-name from server.properties, including unicode and spaces', async () => {
    const server = await env.addServer();
    await seedWorld(server.id, 'My World Ä');
    const dto = await backupNow(server.id);
    expect(dto).toMatchObject({ status: 'ok', levelName: 'My World Ä', worlds: ['My World Ä', 'My World Ä_nether', 'My World Ä_the_end'] });
    expect(await readFile(path.join(await unpack(dto), 'My World Ä', 'level.dat'), 'utf8')).toBe('level-1');
  });

  it('uses "world" when server.properties does not name a level, and tolerates a missing Nether', async () => {
    const server = await env.addServer();
    await write(server.id, 'world/level.dat', 'overworld-only');
    const dto = await backupNow(server.id);
    expect(dto).toMatchObject({ status: 'ok', levelName: 'world', worlds: ['world'] });
  });

  it('includes the configuration files only when asked', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    await write(server.id, 'ops.json', '[]');
    await write(server.id, 'config/mod.toml', 'a=1');
    await write(server.id, 'eula.txt', 'eula=true');
    await write(server.id, 'mods/secret.jar', 'jar');
    const dto = await backupNow(server.id, { includeConfig: true });
    expect(dto.includesConfig).toBe(true);
    const dir = await unpack(dto);
    expect((await readdir(dir)).sort()).toEqual(['config', 'ops.json', 'server.properties', 'world', 'world_nether', 'world_the_end', 'worldfoundry-backup.json']);
    expect(await readFile(path.join(dir, 'config', 'mod.toml'), 'utf8')).toBe('a=1');
  });

  it('uses the server-wide default for the config option when none is given', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    await env.call('PATCH', `/api/servers/${server.id}/backups/schedule`, { includeConfig: true });
    expect((await backupNow(server.id)).includesConfig).toBe(true);
  });

  it('refuses a level name that could leave the server folder', async () => {
    const server = await env.addServer();
    await write(server.id, 'server.properties', 'level-name=../outside\n');
    const res = await create(server.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BACKUP_LEVEL_INVALID');
    expect((await list(server.id)).body.backups).toEqual([]);
  });

  it('answers 409 at once when there is nothing to back up yet', async () => {
    const server = await env.addServer();
    const res = await create(server.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BACKUP_NOTHING_TO_SAVE');
    expect((await list(server.id)).body.backups).toEqual([]);
  });

  it('allows only one backup at a time per server and answers 404 for unknown servers', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const first = await create(server.id);
    const second = await create(server.id);
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('BACKUP_IN_PROGRESS');
    await env.services.backups.idle();
    expect((await create('00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('reports free space and totals and emits events for the lifecycle', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    await backupNow(server.id);
    const res = await list(server.id);
    expect(res.body.totalBytes).toBe(res.body.backups[0]?.sizeBytes);
    expect(res.body.running).toBe(false);
    expect(res.body.schedule).toMatchObject({ mode: 'off', intervalHours: null, times: [], everyDays: 1, keepLast: 7, includeConfig: false, nextRunAt: null });
    expect(typeof res.body.freeBytes === 'number' || res.body.freeBytes === null).toBe(true);
    const states = events.filter((e) => e.type === 'backup.changed').map((e) => (e.type === 'backup.changed' ? e.status : ''));
    expect(states).toEqual(['running', 'ok']);
  });

  it('checks the free disk space and records a clear error', async () => {
    await env.close();
    await setup({ freeSpace: async () => 1024 });
    const server = await env.addServer();
    await seedWorld(server.id);
    await create(server.id);
    const dto = await finished(server.id);
    expect(dto.status).toBe('failed');
    expect(dto.error).toContain('Not enough free disk space');
    expect(dto.errorRef).toMatchObject({ key: 'DISK_FULL', params: { purpose: 'backup' } });
    expect(await readdir(backupsDir(server.id)).catch(() => [])).toEqual([]);
    expect(events.some((e) => e.type === 'backup.changed' && e.status === 'failed' && (e.error ?? '').includes('disk space'))).toBe(true);
    expect(events.some((e) => e.type === 'backup.changed' && e.status === 'failed' && e.errorRef?.key === 'DISK_FULL')).toBe(true);
  });

  it('skips symlinks inside the world and says so', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    try {
      await symlink(path.join(env.serverDir(server.id), 'world', 'level.dat'), path.join(env.serverDir(server.id), 'world', 'link.dat'));
    } catch {
      return;
    }
    const dto = await backupNow(server.id);
    expect(dto.note).toContain('symlink');
    expect(dto.noteRef).toEqual({ key: 'BACKUP_NOTE_SYMLINKS', params: { count: 1 } });
    expect(await readdir(path.join(await unpack(dto), 'world'))).not.toContain('link.dat');
  });
});

describe('creating a backup of a running server', () => {
  it('sends save-off, save-all flush, archives, then always save-on, in that order', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    await online(server.id);
    const dto = await backupNow(server.id);
    expect(dto.status).toBe('ok');
    expect(await fakeEvents()).toEqual(expect.arrayContaining(['save-off', 'save-all flush (saving off)', 'save-on']));
    const order = (await fakeEvents()).filter((line) => line.startsWith('save'));
    expect(order).toEqual(['save-off', 'save-all flush (saving off)', 'save-on']);
    const texts = env.services.manager.history(server.id).map((line) => line.text);
    expect(texts).toContain('save-off');
    expect(texts.some((text) => text.includes('World backup finished'))).toBe(true);
    expect((await env.status(server.id)).state).toBe('online');
    expect(await readFile(path.join(await unpack(dto), 'world', 'level.dat'), 'utf8')).toBe('level-1');
  });

  it('understands the 1.12 wording of the confirmations', async () => {
    env.spawner.extraEnv['FAKE_SAVE'] = 'old';
    const server = await env.addServer();
    await seedWorld(server.id);
    await online(server.id);
    expect((await backupNow(server.id)).status).toBe('ok');
  });

  it('falls back to a plain save-all for servers that know no flush argument', async () => {
    env.spawner.extraEnv['FAKE_SAVE'] = 'no-flush-arg';
    const server = await env.addServer();
    await seedWorld(server.id);
    await online(server.id);
    expect((await backupNow(server.id)).status).toBe('ok');
    const order = (await fakeEvents()).filter((line) => line.startsWith('save'));
    expect(order).toEqual(['save-off', 'save-all flush (saving off)', 'save-all (saving off)', 'save-on']);
  });

  it('sends save-on and keeps the server running when the flush fails', async () => {
    env.spawner.extraEnv['FAKE_SAVE'] = 'flush-fail';
    const server = await env.addServer();
    await seedWorld(server.id);
    await online(server.id);
    const dto = await backupNow(server.id);
    expect(dto).toMatchObject({ status: 'failed' });
    expect(dto.error).toContain('save-all');
    expect((await fakeEvents()).filter((line) => line.startsWith('save')).at(-1)).toBe('save-on');
    expect((await env.status(server.id)).state).toBe('online');
    expect(await readdir(backupsDir(server.id))).toEqual([]);
  });

  it('sends save-on after a timeout waiting for save-off and after one waiting for the flush', async () => {
    env.spawner.extraEnv['FAKE_SAVE'] = 'no-off';
    const server = await env.addServer();
    await seedWorld(server.id);
    await online(server.id);
    const first = await backupNow(server.id);
    expect(first.status).toBe('failed');
    expect(first.error).toContain('save-off');
    expect((await fakeEvents()).filter((line) => line.startsWith('save')).at(-1)).toBe('save-on');
    expect((await env.status(server.id)).state).toBe('online');

    await env.call('POST', `/api/servers/${server.id}/stop`);
    await env.waitState(server.id, 'offline');
    env.spawner.extraEnv['FAKE_SAVE'] = 'flush-silent';
    await online(server.id);
    const second = await backupNow(server.id);
    expect(second.status).toBe('failed');
    expect(second.error).toContain('in time');
    const saves = (await fakeEvents()).filter((line) => line.startsWith('save'));
    expect(saves.at(-1)).toBe('save-on');
    expect(await readdir(backupsDir(server.id))).toEqual([]);
  });

  it('records a note when the server does not confirm save-on, but keeps the backup', async () => {
    env.spawner.extraEnv['FAKE_SAVE'] = 'no-on';
    const server = await env.addServer();
    await seedWorld(server.id);
    await online(server.id);
    const dto = await backupNow(server.id);
    expect(dto.status).toBe('ok');
    expect(dto.note).toContain('save-on');
  });

  it('discards the backup when the server is stopped while it waits for the flush', async () => {
    env.spawner.extraEnv['FAKE_SAVE'] = 'flush-slow';
    const server = await env.addServer();
    await seedWorld(server.id);
    await online(server.id);
    await create(server.id);
    await waitFor(async () => (await fakeEvents()).some((line) => line.startsWith('save-all')), 3000, 'save-all');
    await env.call('POST', `/api/servers/${server.id}/stop`);
    const dto = await finished(server.id);
    expect(dto.status).toBe('failed');
    expect(dto.error).toContain('stopped');
    expect(await readdir(backupsDir(server.id))).toEqual([]);
    await env.waitState(server.id, 'offline');
  });

  it('refuses to back up a server that is starting', async () => {
    env.spawner.startDelay = 800;
    const server = await env.addServer();
    await seedWorld(server.id);
    await env.call('POST', `/api/servers/${server.id}/start`);
    const res = await create(server.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BACKUP_SERVER_BUSY');
    await env.waitState(server.id, 'online');
  });

  it('a failed backup is logged, announced in the console and emitted as an event', async () => {
    env.spawner.extraEnv['FAKE_SAVE'] = 'flush-fail';
    const server = await env.addServer();
    await seedWorld(server.id);
    await online(server.id);
    await backupNow(server.id);
    const failed = events.find((e) => e.type === 'backup.changed' && e.status === 'failed');
    expect(failed).toMatchObject({ type: 'backup.changed', serverId: server.id, kind: 'manual' });
    expect(env.services.manager.history(server.id).some((line) => line.stream === 'system' && line.text.startsWith('Backup failed'))).toBe(true);
  });
});

describe('restoring', () => {
  it('replaces the world, creates a safety backup of the current state and leaves the config alone', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    await write(server.id, 'ops.json', 'ops-old');
    const original = await backupNow(server.id);

    await write(server.id, 'world/level.dat', 'level-2');
    await write(server.id, 'world/new.txt', 'only in the new state');
    await rm(path.join(env.serverDir(server.id), 'world', 'region', 'r.0.0.mca'));
    await write(server.id, 'world_nether/DIM-1/extra.txt', 'x');
    await write(server.id, 'ops.json', 'ops-new');

    const res = await env.call<RestoreResponse & ErrorBody>('POST', `/api/servers/${server.id}/backups/${original.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.warningRefs).toEqual([]);
    expect(res.body.safety).toMatchObject({ kind: 'safety', status: 'ok', noteRef: { key: 'BACKUP_NOTE_BEFORE_RESTORE', params: { fileName: original.fileName } } });
    expect(await read(server.id, 'world/level.dat')).toBe('level-1');
    expect(await exists(server.id, 'world/new.txt')).toBe(false);
    expect((await readFile(path.join(env.serverDir(server.id), 'world', 'region', 'r.0.0.mca'))).length).toBe(30_000);
    expect(await exists(server.id, 'world_nether/DIM-1/extra.txt')).toBe(false);
    expect(await read(server.id, 'ops.json')).toBe('ops-new');
    expect(await readdir(env.serverDir(server.id))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.restore-/)]));

    const safety = await unpack(res.body.safety as BackupDto);
    expect(await readFile(path.join(safety, 'world', 'level.dat'), 'utf8')).toBe('level-2');
    expect(await readFile(path.join(safety, 'world', 'new.txt'), 'utf8')).toBe('only in the new state');
    const kinds = (await list(server.id)).body.backups.map((entry) => entry.kind).sort();
    expect(kinds).toEqual(['manual', 'safety']);
  });

  it('restores the configuration too when the backup contains it', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    await write(server.id, 'config/mod.toml', 'a=1');
    const dto = await backupNow(server.id, { includeConfig: true });
    await write(server.id, 'config/mod.toml', 'a=2');
    await write(server.id, 'server.properties', 'level-name=world\nserver-port=25000\n');
    const res = await env.call<RestoreResponse>('POST', `/api/servers/${server.id}/backups/${dto.id}/restore`);
    expect(res.status).toBe(200);
    expect(await read(server.id, 'config/mod.toml')).toBe('a=1');
    expect(await read(server.id, 'server.properties')).toContain('server-port=25599');
  });

  it('is refused while the server runs', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    await online(server.id);
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/backups/${dto.id}/restore`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SERVER_RUNNING');
    expect(await read(server.id, 'world/level.dat')).toBe('level-1');
  });

  it('warns when the restored world has another name than the server uses', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    await write(server.id, 'server.properties', 'level-name=other\n');
    const res = await env.call<RestoreResponse>('POST', `/api/servers/${server.id}/backups/${dto.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.warnings[0]).toContain('"world"');
    expect(res.body.warningRefs).toEqual([{ key: 'RESTORE_LEVEL_MISMATCH', params: { restored: 'world', current: 'other' } }]);
    expect(res.body.warnings[0]).toContain('"other"');
    expect(await read(server.id, 'world/level.dat')).toBe('level-1');
  });

  it('leaves the old world intact and creates no safety backup when the archive is corrupt', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    await write(server.id, 'world/level.dat', 'current');
    const file = path.join(backupsDir(server.id), dto.fileName);
    const bytes = await readFile(file);
    await writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/backups/${dto.id}/restore`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ARCHIVE_CORRUPT');
    expect(await read(server.id, 'world/level.dat')).toBe('current');
    expect((await readdir(env.serverDir(server.id))).filter((name) => name.startsWith('.restore'))).toEqual([]);
    expect((await list(server.id)).body.backups.filter((entry) => entry.kind === 'safety')).toEqual([]);
  });

  it('refuses archives with paths that leave the server folder and writes nothing outside', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    await write(server.id, 'world/level.dat', 'current');
    const manifest = JSON.stringify({ format: 1, levelName: 'world', worlds: ['world'], configItems: [] });
    const evil = buildTarGz([
      { name: 'worldfoundry-backup.json', content: manifest },
      { name: 'world/level.dat', content: 'evil' },
      { name: '../outside.txt', content: 'evil' },
    ]);
    await writeFile(path.join(backupsDir(server.id), dto.fileName), evil);
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/backups/${dto.id}/restore`);
    expect(res.body.error.code).toBe('ARCHIVE_UNSAFE');
    expect(await exists(server.id, 'world/level.dat')).toBe(true);
    expect(await read(server.id, 'world/level.dat')).toBe('current');
    expect(await exists(server.id, '../outside.txt')).toBe(false);
    expect(await readdir(path.dirname(env.serverDir(server.id)))).not.toContain('outside.txt');
  });

  it('refuses archives with content the manifest does not declare (e.g. a smuggled mod)', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    const manifest = JSON.stringify({ format: 1, levelName: 'world', worlds: ['world'], configItems: [] });
    const sneaky = buildTarGz([
      { name: 'worldfoundry-backup.json', content: manifest },
      { name: 'world/level.dat', content: 'world' },
      { name: 'mods/evil.jar', content: 'jar' },
    ]);
    await writeFile(path.join(backupsDir(server.id), dto.fileName), sneaky);
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/backups/${dto.id}/restore`);
    expect(res.body.error.code).toBe('BACKUP_INVALID');
    expect(await exists(server.id, 'mods/evil.jar')).toBe(false);
    expect(await read(server.id, 'world/level.dat')).toBe('level-1');
  });

  it('refuses a manifest that names folders outside the world set or config allowlist', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    const manifest = JSON.stringify({ format: 1, levelName: 'world', worlds: ['mods'], configItems: [] });
    await writeFile(path.join(backupsDir(server.id), dto.fileName), buildTarGz([{ name: 'worldfoundry-backup.json', content: manifest }, { name: 'mods/x.jar', content: 'jar' }]));
    const res = await env.call<ErrorBody>('POST', `/api/servers/${server.id}/backups/${dto.id}/restore`);
    expect(res.body.error.code).toBe('BACKUP_INVALID');
  });

  it('answers clearly for missing files, unfinished and unknown backups', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    await rm(path.join(backupsDir(server.id), dto.fileName));
    expect((await env.call<ErrorBody>('POST', `/api/servers/${server.id}/backups/${dto.id}/restore`)).body.error.code).toBe('BACKUP_FILE_MISSING');
    expect((await env.call<ErrorBody>('POST', `/api/servers/${server.id}/backups/unknown/restore`)).body.error.code).toBe('BACKUP_NOT_FOUND');
    await env.t.db.update(backups).set({ status: 'running' }).where(eq(backups.id, dto.id));
    expect((await env.call<ErrorBody>('POST', `/api/servers/${server.id}/backups/${dto.id}/restore`)).body.error.code).toBe('BACKUP_NOT_READY');
  });

  it('checks the free space before extracting', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    await env.close();
    // same database cannot be reused, so only the guard is checked through a fresh environment
    await setup({ freeSpace: async () => 10 });
    const other = await env.addServer();
    await seedWorld(other.id);
    const row = { ...dto, noteRef: null, errorRef: null, id: 'b-1', serverId: other.id, worlds: JSON.stringify(dto.worlds), createdAt: new Date(), finishedAt: new Date() };
    await env.t.db.insert(backups).values(row);
    await mkdir(backupsDir(other.id), { recursive: true });
    await writeFile(path.join(backupsDir(other.id), row.fileName), 'x');
    const res = await env.call<ErrorBody>('POST', `/api/servers/${other.id}/backups/b-1/restore`);
    expect(res.body.error.code).toBe('DISK_FULL');
  });
});

describe('deleting and downloading', () => {
  it('deletes the archive and the record', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    const res = await env.call('DELETE', `/api/servers/${server.id}/backups/${dto.id}`);
    expect(res.status).toBe(200);
    expect(await readdir(backupsDir(server.id))).toEqual([]);
    expect((await list(server.id)).body.backups).toEqual([]);
    expect((await env.call<ErrorBody>('DELETE', `/api/servers/${server.id}/backups/${dto.id}`)).body.error.code).toBe('BACKUP_NOT_FOUND');
    expect(events.some((e) => e.type === 'backup.changed' && e.status === 'deleted')).toBe(true);
  });

  it('does not delete a backup of another server', async () => {
    const a = await env.addServer();
    const b = await env.addServer();
    await seedWorld(a.id);
    const dto = await backupNow(a.id);
    expect((await env.call<ErrorBody>('DELETE', `/api/servers/${b.id}/backups/${dto.id}`)).status).toBe(404);
    expect((await env.call<ErrorBody>('GET', `/api/servers/${b.id}/backups/${dto.id}/download`)).status).toBe(404);
    expect((await list(a.id)).body.backups).toHaveLength(1);
  });

  it('streams the archive with a safe attachment header', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    const res = await env.app.inject({ method: 'GET', url: `/api/servers/${server.id}/backups/${dto.id}/download` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${dto.fileName}"`);
    expect(res.headers['content-length']).toBe(String(dto.sizeBytes));
    expect(res.rawPayload.equals(await readFile(path.join(backupsDir(server.id), dto.fileName)))).toBe(true);
  });

  it('refuses downloads of unfinished backups and of file names that are not plain archive names', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    await env.t.db.update(backups).set({ fileName: '../../worldfoundry.db' }).where(eq(backups.id, dto.id));
    const unsafe = await env.call<ErrorBody>('GET', `/api/servers/${server.id}/backups/${dto.id}/download`);
    expect(unsafe.status).toBe(409);
    expect(unsafe.body.error.code).toBe('BACKUP_PATH_UNSAFE');
    expect((await env.call<ErrorBody>('DELETE', `/api/servers/${server.id}/backups/${dto.id}`)).body.error.code).toBe('BACKUP_PATH_UNSAFE');
    await env.t.db.update(backups).set({ fileName: dto.fileName, status: 'running' }).where(eq(backups.id, dto.id));
    expect((await env.call<ErrorBody>('GET', `/api/servers/${server.id}/backups/${dto.id}/download`)).body.error.code).toBe('BACKUP_NOT_READY');
    expect((await env.call<ErrorBody>('DELETE', `/api/servers/${server.id}/backups/${dto.id}`)).body.error.code).toBe('BACKUP_IN_PROGRESS');
  });

  it('requires the login when a token is set', async () => {
    await env.close();
    await setup({ authToken: 'a-long-secret' });
    const server = await env.addServer();
    await seedWorld(server.id);
    const auth = { authorization: 'Bearer a-long-secret' };
    const created = await env.call<{ backup: BackupDto }>('POST', `/api/servers/${server.id}/backups`, {}, auth);
    await env.services.backups.idle();
    const id = created.body.backup.id;
    const anonymous = await env.app.inject({ method: 'GET', url: `/api/servers/${server.id}/backups/${id}/download` });
    expect(anonymous.statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: `/api/servers/${server.id}/backups` })).statusCode).toBe(401);
    const allowed = await env.app.inject({ method: 'GET', url: `/api/servers/${server.id}/backups/${id}/download`, headers: auth });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.rawPayload.length).toBeGreaterThan(100);
  });
});

describe('deleting a server with backups', () => {
  async function serverWithBackup(): Promise<Server> {
    const server = await env.addServer();
    await seedWorld(server.id);
    await backupNow(server.id);
    return server;
  }

  it('asks for a decision when backups exist', async () => {
    const server = await serverWithBackup();
    const res = await env.call<ErrorBody>('DELETE', `/api/servers/${server.id}?confirm=true`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BACKUPS_DECISION_REQUIRED');
    expect(res.body.error.details?.count).toBe(1);
    expect(await env.row(server.id)).toBeDefined();
    expect(await exists(server.id, 'world/level.dat')).toBe(true);
  });

  it('deletes the archives with the server when asked to', async () => {
    const server = await serverWithBackup();
    expect((await env.call('DELETE', `/api/servers/${server.id}?confirm=true&backups=delete`)).status).toBe(200);
    expect(await readdir(backupsDir(server.id)).catch(() => 'gone')).toBe('gone');
    expect(await env.row(server.id)).toBeUndefined();
    expect(await env.t.db.select().from(backups)).toEqual([]);
  });

  it('keeps the archives and leaves a note about whose they were', async () => {
    const server = await serverWithBackup();
    expect((await env.call('DELETE', `/api/servers/${server.id}?confirm=true&backups=keep`)).status).toBe(200);
    const files = await readdir(backupsDir(server.id));
    expect(files).toHaveLength(2);
    expect(files).toContain('server.json');
    expect(JSON.parse(await readFile(path.join(backupsDir(server.id), 'server.json'), 'utf8'))).toMatchObject({ id: server.id, name: server.name });
    expect(await env.row(server.id)).toBeUndefined();
  });

  it('needs no decision when there are no backups, and rejects unknown values', async () => {
    const server = await env.addServer();
    expect((await env.call<ErrorBody>('DELETE', `/api/servers/${server.id}?confirm=true&backups=maybe`)).status).toBe(400);
    expect((await env.call('DELETE', `/api/servers/${server.id}?confirm=true`)).status).toBe(200);
  });

  it('refuses while a backup of the server is being written', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    await create(server.id);
    const res = await env.call<ErrorBody>('DELETE', `/api/servers/${server.id}?confirm=true&backups=delete`);
    expect(res.body.error.code).toBe('BACKUP_IN_PROGRESS');
    await env.services.backups.idle();
  });
});

describe('schedule and retention', () => {
  const HOUR = 3_600_000;

  async function scheduled(overrides: Record<string, unknown> = { intervalHours: 1, keepLast: 2 }): Promise<Server> {
    const server = await env.addServer();
    await seedWorld(server.id);
    const res = await env.call('PATCH', `/api/servers/${server.id}/backups/schedule`, overrides);
    expect(res.status).toBe(200);
    return server;
  }
  const autos = async (serverId: string) =>
    (await env.t.db.select().from(backups).where(and(eq(backups.serverId, serverId), eq(backups.kind, 'auto')))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  it('validates and stores the schedule on the server', async () => {
    const server = await env.addServer();
    expect((await env.call<ErrorBody>('PATCH', `/api/servers/${server.id}/backups/schedule`, {})).status).toBe(400);
    expect((await env.call<ErrorBody>('PATCH', `/api/servers/${server.id}/backups/schedule`, { intervalHours: 0 })).status).toBe(400);
    expect((await env.call<ErrorBody>('PATCH', `/api/servers/${server.id}/backups/schedule`, { keepLast: 0 })).status).toBe(400);
    expect((await env.call<ErrorBody>('PATCH', `/api/servers/${server.id}/backups/schedule`, { gibtEsNicht: 1 })).status).toBe(400);
    const ok = await env.call<{ schedule: unknown }>('PATCH', `/api/servers/${server.id}/backups/schedule`, { intervalHours: 6, keepLast: 4, includeConfig: true });
    expect(ok.body.schedule).toMatchObject({ mode: 'hours', intervalHours: 6, times: [], keepLast: 4, includeConfig: true });
    expect((await env.call<{ server: Server }>('GET', `/api/servers/${server.id}`)).body.server).toMatchObject({ backupIntervalHours: 6, backupKeepLast: 4, backupIncludeConfig: true });
    const off = await env.call<{ schedule: { intervalHours: number | null } }>('PATCH', `/api/servers/${server.id}/backups/schedule`, { intervalHours: null });
    expect(off.body.schedule.intervalHours).toBeNull();
  });

  it('runs a backup when the interval has passed, not before, and not when switched off', async () => {
    const server = await scheduled();
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    expect(await env.services.backupScheduler.tick(since + HOUR - 60_000)).toBe(0);
    expect(await autos(server.id)).toHaveLength(0);
    expect(await env.services.backupScheduler.tick(since + HOUR + 1000)).toBe(1);
    expect(await autos(server.id)).toHaveLength(1);
    // the interval now counts from that backup
    expect(await env.services.backupScheduler.tick(Date.now() + 1000)).toBe(0);
    expect(await autos(server.id)).toHaveLength(1);

    await env.call('PATCH', `/api/servers/${server.id}/backups/schedule`, { intervalHours: null });
    expect(await env.services.backupScheduler.tick(Date.now() + 100 * HOUR)).toBe(0);
  });

  it('prunes only automatic backups beyond keepLast; manual and safety backups stay', async () => {
    const server = await scheduled({ intervalHours: 1, keepLast: 2 });
    const manual = await backupNow(server.id);
    await env.t.db.insert(backups).values({ ...manual, noteRef: null, errorRef: null, id: 'safe-1', kind: 'safety', fileName: manual.fileName, worlds: '[]', createdAt: new Date(0), finishedAt: new Date(0) });
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    for (let index = 0; index < 4; index++) {
      // a stopped server is only backed up again after its world changed
      await wait(20);
      await write(server.id, 'world/level.dat', `state-${index}`);
      expect(await env.services.backupScheduler.tick(since + (index + 1) * 2 * HOUR)).toBe(1);
      await wait(20);
    }
    const remaining = await autos(server.id);
    expect(remaining).toHaveLength(2);
    expect(remaining.every((row) => row.status === 'ok')).toBe(true);
    const all = (await list(server.id)).body.backups;
    expect(all.filter((entry) => entry.kind === 'manual')).toHaveLength(1);
    expect(all.filter((entry) => entry.kind === 'safety')).toHaveLength(1);
    // files of pruned backups are gone, the others exist
    const files = await readdir(backupsDir(server.id));
    expect(files.filter((name) => name.includes('-auto-'))).toHaveLength(2);
    expect(files).toContain(manual.fileName);
  });

  it('survives a restart because the schedule lives in the database', async () => {
    const server = await scheduled({ intervalHours: 2, keepLast: 3 });
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    const { BackupService } = await import('../src/backups/service.js');
    const { BackupScheduler } = await import('../src/backups/scheduler.js');
    const fresh = new BackupService({
      db: env.t.db,
      serversDir: env.config.serversDir,
      backupsDir: path.join(env.config.dataDir, 'backups'),
      lock: env.services.lock,
      bus: env.services.bus,
      manager: env.services.manager,
    });
    const scheduler = new BackupScheduler(fresh, 0);
    expect(await scheduler.tick(since + HOUR)).toBe(0);
    expect(await scheduler.tick(since + 2 * HOUR + 1000)).toBe(1);
    await fresh.idle();
    expect(await autos(server.id)).toHaveLength(1);
  });

  it('backs up a running server on schedule, with the save commands', async () => {
    const server = await scheduled({ intervalHours: 1, keepLast: 2 });
    await online(server.id);
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    expect(await env.services.backupScheduler.tick(since + HOUR + 1000)).toBe(1);
    expect((await autos(server.id))[0]?.status).toBe('ok');
    expect((await fakeEvents()).filter((line) => line.startsWith('save'))).toEqual(['save-off', 'save-all flush (saving off)', 'save-on']);
  });

  it('skips a stopped server whose world did not change since the last backup, and moves the schedule on', async () => {
    const server = await scheduled({ intervalHours: 1, keepLast: 2 });
    await backupNow(server.id);
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    expect(await env.services.backupScheduler.tick(since + HOUR + 1000)).toBe(0);
    expect(await autos(server.id)).toHaveLength(0);
    expect((await env.row(server.id))?.backupScheduleSince?.getTime()).toBe(since + HOUR + 1000);
    // after a change the next run backs it up
    await wait(20);
    await write(server.id, 'world/level.dat', 'changed');
    expect(await env.services.backupScheduler.tick(since + 2 * HOUR + 5000)).toBe(1);
  });

  it('skips servers that are starting or stopping and servers that are not installed', async () => {
    const server = await scheduled({ intervalHours: 1, keepLast: 2 });
    env.spawner.startDelay = 600;
    await env.call('POST', `/api/servers/${server.id}/start`);
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    expect(await env.services.backupScheduler.tick(since + HOUR + 1000)).toBe(0);
    await env.waitState(server.id, 'online');
    const pending = await env.addServer({ installState: 'pending' });
    await env.call('PATCH', `/api/servers/${pending.id}/backups/schedule`, { intervalHours: 1 });
    expect(await autos(pending.id)).toHaveLength(0);
  });

  it('records a failed scheduled backup and tries again after the next interval', async () => {
    env.spawner.extraEnv['FAKE_SAVE'] = 'flush-fail';
    const server = await scheduled({ intervalHours: 1, keepLast: 2 });
    await online(server.id);
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    await env.services.backupScheduler.tick(since + HOUR + 1000);
    const rows = await autos(server.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', kind: 'auto' });
    expect(events.some((e) => e.type === 'backup.changed' && e.kind === 'auto' && e.status === 'failed')).toBe(true);
    expect(await env.services.backupScheduler.tick(Date.now() + 1000)).toBe(0);
  });

  // the first moment at HH:MM UTC after `from`
  const nextUtc = (from: number, time: string): number => {
    const [hour, minute] = time.split(':').map(Number) as [number, number];
    const date = new Date(from);
    let at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
    if (at <= from) at += 24 * HOUR;
    return at;
  };

  it('validates times of day, every n days and the time zone', async () => {
    const server = await env.addServer();
    const patch = (body: Record<string, unknown>) => env.call<ErrorBody>('PATCH', `/api/servers/${server.id}/backups/schedule`, body);
    expect((await patch({ mode: 'times', times: ['25:00'] })).status).toBe(400);
    expect((await patch({ mode: 'times', times: ['3:00'] })).status).toBe(400);
    expect((await patch({ mode: 'times', times: [] })).status).toBe(400);
    expect((await patch({ mode: 'times', times: ['03:00'], everyDays: 0 })).status).toBe(400);
    expect((await patch({ mode: 'times', times: ['03:00'], everyDays: 31 })).status).toBe(400);
    expect((await patch({ mode: 'times', times: ['03:00'], timeZone: 'Mars/Olympus' })).status).toBe(400);
    expect((await patch({ mode: 'times' })).status).toBe(422);
    expect((await patch({ mode: 'hours' })).status).toBe(422);
    const ok = await env.call<{ schedule: Record<string, unknown> }>('PATCH', `/api/servers/${server.id}/backups/schedule`, {
      mode: 'times',
      times: ['18:00', '06:00', '06:00'],
      everyDays: 2,
      timeZone: 'Europe/Berlin',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.schedule).toMatchObject({ mode: 'times', intervalHours: null, times: ['06:00', '18:00'], everyDays: 2, timeZone: 'Europe/Berlin' });
    expect(typeof ok.body.schedule['nextRunAt']).toBe('string');
    // switching to hours forgets the times, off forgets both
    const hours = await env.call<{ schedule: Record<string, unknown> }>('PATCH', `/api/servers/${server.id}/backups/schedule`, { mode: 'hours', intervalHours: 4 });
    expect(hours.body.schedule).toMatchObject({ mode: 'hours', intervalHours: 4, times: [] });
    const off = await env.call<{ schedule: Record<string, unknown> }>('PATCH', `/api/servers/${server.id}/backups/schedule`, { mode: 'off' });
    expect(off.body.schedule).toMatchObject({ mode: 'off', intervalHours: null, times: [], nextRunAt: null });
  });

  it('runs at the set times of day', async () => {
    const server = await scheduled({ mode: 'times', times: ['06:00', '18:00'], timeZone: 'UTC', keepLast: 5 });
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    const first = Math.min(nextUtc(since, '06:00'), nextUtc(since, '18:00'));
    const listed = (await list(server.id)).body.schedule;
    expect(listed.nextRunAt).toBe(new Date(first).toISOString());
    expect(await env.services.backupScheduler.tick(first - 60_000)).toBe(0);
    expect(await env.services.backupScheduler.tick(first + 1000)).toBe(1);
    expect(await autos(server.id)).toHaveLength(1);
  });

  it('runs only every n days', async () => {
    const server = await scheduled({ mode: 'times', times: ['04:00'], everyDays: 3, timeZone: 'UTC', keepLast: 5 });
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    const today = Date.UTC(new Date(since).getUTCFullYear(), new Date(since).getUTCMonth(), new Date(since).getUTCDate(), 4, 0);
    // the cycle starts on the day the schedule was set: today 04:00 if still ahead, otherwise three days later
    const first = today > since ? today : today + 72 * HOUR;
    const listed = (await list(server.id)).body.schedule;
    expect(listed.nextRunAt).toBe(new Date(first).toISOString());
    expect(await env.services.backupScheduler.tick(first - 24 * HOUR + 1000)).toBe(0);
    expect(await env.services.backupScheduler.tick(first + 1000)).toBe(1);
  });

  it('deletes the oldest automatic backups at once when fewer copies are kept', async () => {
    const server = await scheduled({ intervalHours: 1, keepLast: 3 });
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    for (let index = 0; index < 3; index++) {
      await wait(20);
      await write(server.id, 'world/level.dat', `state-${index}`);
      expect(await env.services.backupScheduler.tick(since + (index + 1) * 2 * HOUR)).toBe(1);
      await wait(20);
    }
    const before = await autos(server.id);
    expect(before).toHaveLength(3);
    const manual = await backupNow(server.id);
    await env.call('PATCH', `/api/servers/${server.id}/backups/schedule`, { keepLast: 2 });
    const after = await autos(server.id);
    expect(after.map((row) => row.id)).toEqual(before.slice(1).map((row) => row.id));
    expect((await list(server.id)).body.backups.some((entry) => entry.id === manual.id)).toBe(true);
    // raising the number deletes nothing
    await env.call('PATCH', `/api/servers/${server.id}/backups/schedule`, { keepLast: 5 });
    expect(await autos(server.id)).toHaveLength(2);
  });

  it('with one copy, deletes the old automatic backup first when the disk has no room for two', async () => {
    await env.close();
    let serverId = '';
    // room for exactly one archive: full as soon as an automatic backup exists
    await setup({
      freeSpace: async () => {
        const names = await readdir(backupsDir(serverId)).catch(() => [] as string[]);
        return names.some((name) => name.includes('-auto-')) ? 1024 : 1024 ** 4;
      },
    });
    const server = await scheduled({ intervalHours: 1, keepLast: 1 });
    serverId = server.id;
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    expect(await env.services.backupScheduler.tick(since + HOUR + 1000)).toBe(1);
    const first = await autos(server.id);
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe('ok');
    await wait(20);
    await write(server.id, 'world/level.dat', 'changed');
    expect(await env.services.backupScheduler.tick(since + 3 * HOUR)).toBe(1);
    const second = await autos(server.id);
    expect(second).toHaveLength(1);
    expect(second[0]?.status).toBe('ok');
    expect(second[0]?.id).not.toBe(first[0]?.id);
  });

  it('with more copies, keeps them and lets the backup fail cleanly when the disk is full', async () => {
    await env.close();
    let serverId = '';
    await setup({
      freeSpace: async () => {
        const names = await readdir(backupsDir(serverId)).catch(() => [] as string[]);
        return names.some((name) => name.includes('-auto-')) ? 1024 : 1024 ** 4;
      },
    });
    const server = await scheduled({ intervalHours: 1, keepLast: 2 });
    serverId = server.id;
    const since = (await env.row(server.id))?.backupScheduleSince?.getTime() as number;
    expect(await env.services.backupScheduler.tick(since + HOUR + 1000)).toBe(1);
    await wait(20);
    await write(server.id, 'world/level.dat', 'changed');
    await env.services.backupScheduler.tick(since + 3 * HOUR);
    const rows = await autos(server.id);
    expect(rows.filter((row) => row.status === 'ok')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'failed')).toHaveLength(1);
  });
});

describe('recovery after an interrupted run', () => {
  it('marks running backups failed, removes partial files and staging folders, but keeps old-data folders', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    const dto = await backupNow(server.id);
    await env.t.db.update(backups).set({ status: 'running', finishedAt: null }).where(eq(backups.id, dto.id));
    await writeFile(path.join(backupsDir(server.id), 'half.tar.gz.part'), 'half');
    await write(server.id, '.restore-new-abc/world/level.dat', 'x');
    await write(server.id, '.restore-old-abc/world/level.dat', 'old world');
    expect(await env.services.backups.recoverInterrupted()).toBe(1);
    const after = (await list(server.id)).body.backups[0];
    expect(after).toMatchObject({ status: 'failed' });
    expect(after?.error).toContain('interrupted');
    expect(await readdir(backupsDir(server.id))).toEqual([dto.fileName]);
    expect(await exists(server.id, '.restore-new-abc')).toBe(false);
    expect(await read(server.id, '.restore-old-abc/world/level.dat')).toBe('old world');
  });

  it('aborts a running backup on shutdown and removes the partial file', async () => {
    const server = await env.addServer();
    await seedWorld(server.id);
    await write(server.id, 'world/huge.bin', Buffer.alloc(2_000_000, 9));
    await create(server.id);
    await env.services.backups.shutdown(5000);
    const row = (await env.t.db.select().from(backups))[0];
    expect(['ok', 'failed']).toContain(row?.status);
    expect((await readdir(backupsDir(server.id))).filter((name) => name.endsWith('.part'))).toEqual([]);
  });
});
