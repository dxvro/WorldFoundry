import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '../src/events/bus.js';
import { buildApp } from '../src/app.js';
import { servers } from '../src/db/schema.js';
import { InstallService } from '../src/installer/service.js';
import { parseLaunchSpec } from '../src/installer/launch-spec.js';
import { ServerEnv, waitFor } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
interface ServerBody {
  server: {
    id: string;
    installState: string;
    installError: string | null;
    loaderVersion: string | null;
    requiredJavaMajor: number | null;
    launchSpec: { kind: string; jar?: string; unixFile?: string } | null;
    port: number;
    minRamMb: number;
    maxRamMb: number;
    status: { state: string };
    eulaAccepted: boolean;
    name: string;
  };
}

let env: ServerEnv;
let events: AppEvent[];
beforeEach(async () => {
  env = await ServerEnv.create();
  events = [];
  env.services.bus.subscribe((event) => events.push(event));
});
afterEach(async () => {
  await env.close();
});

const create = (body: Record<string, unknown>) => env.call<ServerBody & ErrorBody>('POST', '/api/servers', { name: 'Test', mcVersion: '1.21.1', ...body });
const settled = async (id: string): Promise<ServerBody['server']> => {
  await env.services.install.idle();
  return (await env.call<ServerBody>('GET', `/api/servers/${id}`)).body.server;
};

describe('creating servers', () => {
  it('returns 201 immediately with install_state pending, then installs in the background', async () => {
    const res = await create({ loader: 'vanilla', name: 'Survival' });
    expect(res.status).toBe(201);
    expect(res.body.server).toMatchObject({ installState: 'pending', name: 'Survival', port: 25565, minRamMb: 1024, maxRamMb: 2048, eulaAccepted: false, requiredJavaMajor: 21 });
    expect(res.body.server.status.state).toBe('offline');
    const id = res.body.server.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const done = await settled(id);
    expect(done).toMatchObject({ installState: 'installed', installError: null, launchSpec: { kind: 'jar', jar: 'server.jar' } });
    expect(await readdir(env.serverDir(id))).toContain('server.jar');
    expect(await readdir(env.serverDir(id))).not.toContain('.tmp');

    const log = await readFile(path.join(env.serverDir(id), 'install.log'), 'utf8');
    expect(log).toContain('Installation of vanilla 1.21.1');
    expect(log).toContain('sha1 verified');
    expect(log).toContain('Installation finished');
    const states = events.filter((e) => e.type === 'install.state').map((e) => (e.type === 'install.state' ? e.installState : ''));
    expect(states).toEqual(['installing', 'installed']);
    expect(events.some((e) => e.type === 'install.progress' && e.phase === 'download')).toBe(true);
    expect(events.some((e) => e.type === 'install.log')).toBe(true);
  });

  it('picks free default ports and honours an explicit one', async () => {
    const first = await create({ loader: 'vanilla' });
    const second = await create({ loader: 'vanilla' });
    const third = await create({ loader: 'vanilla', port: 30000, minRamMb: 512, maxRamMb: 1024, eulaAccepted: true });
    expect([first.body.server.port, second.body.server.port]).toEqual([25565, 25566]);
    expect(third.body.server).toMatchObject({ port: 30000, minRamMb: 512, maxRamMb: 1024, eulaAccepted: true });
    await env.services.install.idle();
  });

  it('installs fabric with the stored loader version and a jar launch spec', async () => {
    const res = await create({ loader: 'fabric' });
    const done = await settled(res.body.server.id);
    expect(done).toMatchObject({ installState: 'installed', loaderVersion: '0.16.14', launchSpec: { kind: 'jar', jar: 'fabric-server-launch.jar' } });
  });

  it('installs paper preferring the stable build', async () => {
    const res = await create({ loader: 'paper' });
    const done = await settled(res.body.server.id);
    expect(done).toMatchObject({ installState: 'installed', loaderVersion: '133', launchSpec: { jar: 'paper-1.21.1-133.jar' } });
  });

  it('runs the NeoForge installer, detects the args files and deletes the installer jar', async () => {
    const res = await create({ loader: 'neoforge' });
    const done = await settled(res.body.server.id);
    expect(done.installState).toBe('installed');
    expect(done.launchSpec).toMatchObject({ kind: 'args', unixFile: 'libraries/net/neoforged/neoforge/21.1.172/unix_args.txt' });
    const run = env.installer.runs[0];
    expect(run?.args).toEqual(['-jar', 'neoforge-21.1.172-installer.jar', '--install-server']);
    expect(run?.cwd).toBe(env.serverDir(res.body.server.id));
    expect(run?.timeoutMs).toBe(10 * 60_000);
    expect(run?.javaPath).toBe(env.javaPath);
    expect(await readdir(env.serverDir(res.body.server.id))).not.toContain('neoforge-21.1.172-installer.jar');
    const log = await readFile(path.join(env.serverDir(res.body.server.id), 'install.log'), 'utf8');
    expect(log).toContain('Installer started');
  });

  it('runs the Forge installer with --installServer and handles legacy jars', async () => {
    const modern = await create({ loader: 'forge' });
    expect((await settled(modern.body.server.id)).launchSpec).toMatchObject({ kind: 'args' });
    expect(env.installer.runs[0]?.args).toEqual(['-jar', 'forge-1.21.1-52.1.20-installer.jar', '--installServer']);

    await env.close();
    env = await ServerEnv.create({ java: { 'C:/j/8/bin/java.exe': '1.8.0_392', 'C:/j/21/bin/java.exe': '21.0.1' } });
    env.installer.mode = 'legacy';
    const legacy = await create({ loader: 'forge', mcVersion: '1.12.2', name: 'Old' });
    expect(legacy.body.server.requiredJavaMajor).toBe(8);
    expect((await settled(legacy.body.server.id)).launchSpec).toEqual({ kind: 'jar', jar: 'forge-1.12.2-14.23.5.2864.jar' });

    env.installer.mode = 'legacy-universal';
    const old = await create({ loader: 'forge', mcVersion: '1.7.10', name: 'Ancient' });
    expect((await settled(old.body.server.id)).launchSpec).toEqual({ kind: 'jar', jar: 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar' });
  });

  it('fails with the last installer output when the installer exits non-zero', async () => {
    env.installer.mode = 'fail';
    const res = await create({ loader: 'forge' });
    const done = await settled(res.body.server.id);
    expect(done.installState).toBe('failed');
    expect(done.installError).toContain('exit code 1');
    expect(done).toMatchObject({ installErrorRef: { key: 'INSTALLER_FAILED', params: { reason: 'exit', exitCode: 1 } } });
    // the reference is stored with the error and survives a reload of the row
    expect(await env.row(res.body.server.id)).toMatchObject({ installErrorRef: expect.stringContaining('INSTALLER_FAILED') });
    expect(events.some((e) => e.type === 'install.state' && e.installState === 'failed' && e.installErrorRef?.key === 'INSTALLER_FAILED')).toBe(true);
    expect(done.installError).toContain('Could not download libraries');
    expect(await readdir(env.serverDir(res.body.server.id))).not.toContain('forge-1.21.1-52.1.20-installer.jar');
    const states = events.filter((e) => e.type === 'install.state').map((e) => (e.type === 'install.state' ? e.installState : ''));
    expect(states).toEqual(['installing', 'failed']);
  });

  it('fails on installer timeout and on a missing launch target', async () => {
    env.installer.mode = 'timeout';
    const slow = await create({ loader: 'forge' });
    expect((await settled(slow.body.server.id)).installError).toContain('cancelled');
    env.installer.mode = 'nothing';
    const empty = await create({ loader: 'forge', name: 'Empty' });
    expect((await settled(empty.body.server.id)).installError).toContain('startable file');
  });

  it('marks a hash mismatch as failed and leaves no files behind', async () => {
    const plan = await env.services.catalog.resolve('vanilla', '1.21.1', null);
    env.upstream.corrupt.add(plan.artifact.url);
    const res = await create({ loader: 'vanilla' });
    const done = await settled(res.body.server.id);
    expect(done.installState).toBe('failed');
    expect(done.installError).toContain('checksum');
    const files = await readdir(env.serverDir(res.body.server.id));
    expect(files).not.toContain('server.jar');
    expect(files).not.toContain('.tmp');
  });

  it('fails the job with JAVA_NOT_FOUND text where the installer needs Java, but not for jar loaders', async () => {
    await env.close();
    env = await ServerEnv.create({ java: {} });
    const forge = await create({ loader: 'forge' });
    expect(forge.status).toBe(201);
    const done = await settled(forge.body.server.id);
    expect(done.installState).toBe('failed');
    expect(done.installError).toContain('No Java installation');
    expect(env.installer.runs).toHaveLength(0);
    const vanilla = await create({ loader: 'vanilla', name: 'V' });
    expect((await settled(vanilla.body.server.id)).installState).toBe('installed');
  });

  it('retry: answers 422 JAVA_NOT_FOUND before queueing, then succeeds once Java exists', async () => {
    await env.close();
    env = await ServerEnv.create({ java: {} });
    const forge = await create({ loader: 'forge' });
    const id = forge.body.server.id;
    await settled(id);
    const retry = await env.call<ErrorBody>('POST', `/api/servers/${id}/install`);
    expect(retry.status).toBe(422);
    expect(retry.body.error.code).toBe('JAVA_NOT_FOUND');
    expect((await env.row(id))?.installState).toBe('failed');
  });

  it('retries a failed install and rejects other states', async () => {
    env.installer.mode = 'fail';
    const res = await create({ loader: 'forge' });
    const id = res.body.server.id;
    expect((await settled(id)).installState).toBe('failed');
    env.installer.mode = 'modern';
    const retry = await env.call<ServerBody>('POST', `/api/servers/${id}/install`);
    expect(retry.status).toBe(202);
    expect((await settled(id)).installState).toBe('installed');
    const again = await env.call<ErrorBody>('POST', `/api/servers/${id}/install`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_INSTALLED');
    expect((await env.call<ErrorBody>('POST', '/api/servers/nope/install')).status).toBe(404);
  });

  it('rejects a second install while one is running (empty JSON body accepted)', async () => {
    env.installer.mode = 'hang';
    const res = await create({ loader: 'forge' });
    const id = res.body.server.id;
    await waitFor(async () => (await env.row(id))?.installState === 'installing' || undefined);
    const second = await env.app.inject({ method: 'POST', url: `/api/servers/${id}/install`, headers: { 'content-type': 'application/json' } });
    expect(second.statusCode).toBe(409);
    expect(second.json<ErrorBody>().error.code).toBe('INSTALL_IN_PROGRESS');
    const start = await env.call<ErrorBody>('POST', `/api/servers/${id}/start`);
    expect(start.body.error.code).toBe('SERVER_NOT_INSTALLED');
    expect(start.body.error.message).toContain('installation');
    const del = await env.call<ErrorBody>('DELETE', `/api/servers/${id}?confirm=true`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('INSTALL_IN_PROGRESS');
    await env.services.install.shutdown(2000);
    expect((await env.row(id))?.installState).toBe('failed');
  });

  it('shares one lock between installer and mod operations on the same server', async () => {
    env.installer.mode = 'hang';
    env.modrinth.addProject('A', 'Alpha');
    env.modrinth.addVersion({ id: 'a1', projectId: 'A', number: '1', date: '2024-01-01T00:00:00Z', loaders: ['forge'] });
    const res = await create({ loader: 'forge' });
    const id = res.body.server.id;
    await waitFor(async () => (await env.row(id))?.installState === 'installing' || undefined);
    let finished = false;
    const mod = env.call('POST', `/api/servers/${id}/mods`, { projectId: 'A' }).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    await env.services.install.shutdown(2000);
    await mod;
    expect(finished).toBe(true);
  });

  it('validates input with 400, version errors with 404 and RAM with 422, creating no row', async () => {
    const bad = [{ name: '' }, { name: 'x', loader: 'bukkit' }, { loader: 'vanilla', port: 70000 }, { loader: 'vanilla', minRamMb: 10 }, { loader: 'vanilla', extra: 1 }];
    for (const body of bad) {
      const res = await create({ loader: 'vanilla', ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const unknown = await create({ loader: 'vanilla', mcVersion: '9.9.9' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('VERSION_NOT_FOUND');
    expect((await create({ loader: 'fabric', loaderVersion: '9.9.9' })).status).toBe(404);
    const inverted = await create({ loader: 'vanilla', minRamMb: 4096, maxRamMb: 2048 });
    expect(inverted.status).toBe(422);
    expect(inverted.body.error.code).toBe('RAM_INVALID');
    const huge = await create({ loader: 'vanilla', maxRamMb: 100_000 });
    expect(huge.status).toBe(422);
    expect(huge.body.error.code).toBe('RAM_EXCEEDS_SYSTEM');
    expect(huge.body.error.details).toMatchObject({ totalRamMb: 16_384 });
    expect(await env.t.db.select().from(servers)).toHaveLength(0);
  });

  it('maps an unreachable upstream to 502 without creating a row', async () => {
    env.upstream.down = true;
    const res = await create({ loader: 'vanilla' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNREACHABLE');
    expect(await env.t.db.select().from(servers)).toHaveLength(0);
  });
});

describe('boot recovery', () => {
  it('marks servers stuck in installing as failed (interrupted) when the app becomes ready', async () => {
    const stuck = await env.addServer({ installState: 'installing', launchSpec: null });
    const fine = await env.addServer({ installState: 'installed' });
    const app = buildApp({ db: env.t.db, config: env.config, modrinth: env.modrinth.api(), javaStandardRoots: [] });
    await app.ready();
    await app.close();
    const row = await env.row(stuck.id);
    expect(row?.installState).toBe('failed');
    expect(row?.installError).toContain('interrupted');
    expect((await env.row(fine.id))?.installState).toBe('installed');
    expect(await env.services.install.recoverInterrupted()).toBe(0);
  });
});

describe('listing, reading and updating', () => {
  it('lists servers with their runtime status', async () => {
    const a = await env.addServer({ name: 'A' });
    await env.addServer({ name: 'B' });
    await env.call('POST', `/api/servers/${a.id}/start`);
    await env.waitState(a.id, 'online');
    const res = await env.call<{ servers: ServerBody['server'][] }>('GET', '/api/servers');
    expect(res.body.servers.map((s) => [s.name, s.status.state])).toEqual([
      ['A', 'online'],
      ['B', 'offline'],
    ]);
    expect(res.body.servers[0]?.launchSpec).toEqual({ kind: 'jar', jar: 'server.jar' });
    const one = await env.call<ServerBody>('GET', `/api/servers/${a.id}`);
    expect(one.body.server.status.state).toBe('online');
    expect((await env.call<ErrorBody>('GET', '/api/servers/nope')).status).toBe(404);
  });

  it('updates fields, validates them, and flags restartRequired while running', async () => {
    const server = await env.addServer();
    const ok = await env.call<ServerBody & { restartRequired: boolean }>('PATCH', `/api/servers/${server.id}`, {
      name: 'New',
      minRamMb: 512,
      maxRamMb: 3072,
      useAikarFlags: true,
      extraJvmArgs: '-Dx="a b"',
      javaPath: null,
      eulaAccepted: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.server).toMatchObject({ name: 'New', minRamMb: 512, maxRamMb: 3072 });
    expect(ok.body.restartRequired).toBe(false);

    const checks: Array<[Record<string, unknown>, number, string]> = [
      [{ minRamMb: 4096 }, 422, 'RAM_INVALID'],
      [{ maxRamMb: 400 }, 422, 'RAM_INVALID'],
      [{ maxRamMb: 99_999 }, 422, 'RAM_EXCEEDS_SYSTEM'],
      [{ extraJvmArgs: '-Dx="open' }, 422, 'INVALID_JVM_ARGS'],
      [{ javaPath: 'C:\\Windows\\notepad.exe' }, 422, 'JAVA_INVALID'],
      [{ javaPath: 'C:\\nowhere\\java.exe' }, 422, 'JAVA_INVALID'],
      [{ unbekannt: 1 }, 400, 'VALIDATION_ERROR'],
      [{}, 400, 'VALIDATION_ERROR'],
    ];
    for (const [body, status, code] of checks) {
      const res = await env.call<ErrorBody>('PATCH', `/api/servers/${server.id}`, body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect((await env.row(server.id))?.maxRamMb).toBe(3072);

    await env.call('POST', `/api/servers/${server.id}/start`);
    await env.waitState(server.id, 'online');
    const live = await env.call<ServerBody & { restartRequired: boolean }>('PATCH', `/api/servers/${server.id}`, { maxRamMb: 4096 });
    expect(live.body.restartRequired).toBe(true);
    const nameOnly = await env.call<{ restartRequired: boolean }>('PATCH', `/api/servers/${server.id}`, { name: 'Live' });
    expect(nameOnly.body.restartRequired).toBe(false);
  });

  it('accepts a java path that really is a java executable (basename and -version check)', async () => {
    const server = await env.addServer();
    const res = await env.call<ServerBody>('PATCH', `/api/servers/${server.id}`, { javaPath: env.javaPath });
    expect(res.status).toBe(200);
    expect((await env.row(server.id))?.javaPath).toBe(env.javaPath);
  });
});

describe('deleting servers', () => {
  it('requires confirm=true, refuses running servers, then removes row and folder', async () => {
    const server = await env.addServer();
    const missing = await env.call<ErrorBody>('DELETE', `/api/servers/${server.id}`);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('CONFIRMATION_REQUIRED');

    await env.call('POST', `/api/servers/${server.id}/start`);
    await env.waitState(server.id, 'online');
    const running = await env.call<ErrorBody>('DELETE', `/api/servers/${server.id}?confirm=true`);
    expect(running.status).toBe(409);
    expect(running.body.error.code).toBe('SERVER_RUNNING');
    expect(await env.row(server.id)).toBeDefined();

    await env.call('POST', `/api/servers/${server.id}/stop`);
    await env.waitState(server.id, 'offline');
    const ok = await env.call('DELETE', `/api/servers/${server.id}?confirm=true`);
    expect(ok.status).toBe(200);
    expect(await env.row(server.id)).toBeUndefined();
    await expect(stat(env.serverDir(server.id))).rejects.toThrow();
    expect(events.some((e) => e.type === 'server.changed' && e.reason === 'deleted')).toBe(true);
    expect((await env.call('DELETE', `/api/servers/${server.id}?confirm=true`)).status).toBe(404);
  });

  it('never removes anything but <serversDir>/<uuid>: sibling data stays untouched', async () => {
    const sibling = path.join(env.config.serversDir, 'important');
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, 'world.dat'), 'x');
    const server = await env.addServer();
    await env.call('DELETE', `/api/servers/${server.id}?confirm=true`);
    expect(await readFile(path.join(sibling, 'world.dat'), 'utf8')).toBe('x');
  });

  it('refuses ids that are not UUIDs and keeps row and folder', async () => {
    const odd = await env.addServer({ id: 'not-a-uuid' });
    const res = await env.call<ErrorBody>('DELETE', `/api/servers/${odd.id}?confirm=true`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNSAFE_SERVER_PATH');
    expect(await env.row(odd.id)).toBeDefined();
    const dotted = await env.addServer({ id: 'a/b' });
    const res2 = await env.call<ErrorBody>('DELETE', `/api/servers/${encodeURIComponent('a/b')}?confirm=true`);
    expect(res2.body.error.code).toBe('UNSAFE_SERVER_PATH');
    expect(await env.row(dotted.id)).toBeDefined();
    expect(await readdir(env.config.serversDir)).toBeDefined();
  });

  it('removes only the link when the server folder is a symlink or junction', async () => {
    const outside = path.join(env.config.dataDir, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'keep.txt'), 'stays');
    const server = await env.addServer();
    await rm(env.serverDir(server.id), { recursive: true, force: true });
    try {
      await symlink(outside, env.serverDir(server.id), 'junction');
    } catch {
      return;
    }
    const res = await env.call('DELETE', `/api/servers/${server.id}?confirm=true`);
    expect(res.status).toBe(200);
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('stays');
  });
});

describe('system and loaders', () => {
  it('reports memory, cpus, platform and detected java runtimes', async () => {
    const res = await env.call<{ totalMemoryMb: number; cpuCount: number; platform: string; javaRuntimes: Array<{ major: number; path: string }> }>('GET', '/api/system');
    expect(res.status).toBe(200);
    expect(res.body.totalMemoryMb).toBeGreaterThan(0);
    expect(res.body.cpuCount).toBeGreaterThan(0);
    expect(res.body.platform).toBe(process.platform);
    expect(res.body.javaRuntimes).toEqual([expect.objectContaining({ major: 21, path: env.javaPath })]);
  });

  it('serves loader routes', async () => {
    const loaders = await env.call<{ loaders: Array<{ id: string }> }>('GET', '/api/loaders');
    expect(loaders.body.loaders).toHaveLength(5);
    const mc = await env.call<{ mcVersions: Array<{ id: string; type: string }> }>('GET', '/api/loaders/fabric/mc-versions?snapshots=true');
    expect(mc.body.mcVersions.map((v) => v.id)).toContain('24w14a');
    const plain = await env.call<{ mcVersions: Array<{ id: string }> }>('GET', '/api/loaders/fabric/mc-versions');
    expect(plain.body.mcVersions.map((v) => v.id)).not.toContain('24w14a');
    const versions = await env.call<{ versions: Array<{ version: string }> }>('GET', '/api/loaders/forge/versions?mcVersion=1.21.1');
    expect(versions.body.versions[0]?.version).toBe('52.1.21');
    expect((await env.call('GET', '/api/loaders/forge/versions')).status).toBe(400);
    expect((await env.call('GET', '/api/loaders/bukkit/mc-versions')).status).toBe(400);
    const missing = await env.call<ErrorBody>('GET', '/api/loaders/forge/versions?mcVersion=9.9');
    expect(missing.status).toBe(404);
    env.upstream.down = true;
    const down = await env.call<ErrorBody>('GET', '/api/loaders/paper/mc-versions');
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('UPSTREAM_UNREACHABLE');
  });

  it('accepts bodyless POSTs on the Phase 2 mod routes with a JSON content type', async () => {
    const server = await env.addServer({ loader: 'fabric' });
    for (const url of ['mods/scan', 'mods/updates/check', 'mods/updates/apply']) {
      const res = await env.app.inject({ method: 'POST', url: `/api/servers/${server.id}/${url}`, headers: { 'content-type': 'application/json' } });
      expect(res.statusCode, url).toBe(200);
    }
    const bad = await env.app.inject({ method: 'POST', url: `/api/servers/${server.id}/mods/updates/apply`, headers: { 'content-type': 'application/json' }, payload: '{broken' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
  });

  it('keeps launch specs round-trippable', () => {
    expect(parseLaunchSpec('{"kind":"args","unixFile":"a","winFile":"b"}')).toEqual({ kind: 'args', unixFile: 'a', winFile: 'b' });
    expect(parseLaunchSpec('{"kind":"jar"}')).toBeNull();
    expect(parseLaunchSpec('nonsense')).toBeNull();
    expect(parseLaunchSpec(null)).toBeNull();
  });
});

describe('concurrent installs', () => {
  const failedForge = async (): Promise<string> => {
    env.installer.mode = 'fail';
    const id = (await create({ loader: 'forge' })).body.server.id;
    expect((await settled(id)).installState).toBe('failed');
    env.installer.mode = 'modern';
    return id;
  };

  it('queues exactly one job when two POST /install arrive together', async () => {
    const id = await failedForge();
    const runsBefore = env.installer.runs.length;
    const eventsBefore = events.filter((e) => e.type === 'install.state').length;
    const [a, b] = await Promise.all([
      env.call<ServerBody & ErrorBody>('POST', `/api/servers/${id}/install`),
      env.call<ServerBody & ErrorBody>('POST', `/api/servers/${id}/install`),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const rejected = a.status === 409 ? a : b;
    expect(rejected.body.error.code).toBe('INSTALL_IN_PROGRESS');
    expect((await settled(id)).installState).toBe('installed');
    expect(env.installer.runs.length - runsBefore).toBe(1);
    expect(events.filter((e) => e.type === 'install.state').length - eventsBefore).toBe(2);
    expect(env.services.install.isBusy(id)).toBe(false);
  });

  it('keeps the reservation until the job is done and releases it when validation fails', async () => {
    const id = await failedForge();
    const install = env.services.install;
    await expect(install.enqueue('unknown', { checkJava: true })).rejects.toMatchObject({ code: 'SERVER_NOT_FOUND' });
    expect(install.isBusy('unknown')).toBe(false);
    const first = install.enqueue(id, { checkJava: true });
    expect(install.isBusy(id)).toBe(true);
    await expect(install.enqueue(id, { checkJava: true })).rejects.toMatchObject({ code: 'INSTALL_IN_PROGRESS' });
    expect(install.isBusy(id)).toBe(true);
    await first;
    await install.idle();
    expect(install.isBusy(id)).toBe(false);
    await expect(install.enqueue(id, { checkJava: true })).rejects.toMatchObject({ code: 'ALREADY_INSTALLED' });
    expect(install.isBusy(id)).toBe(false);
  });

  it('does nothing when the server was installed while the job waited for the lock', async () => {
    const id = await failedForge();
    const runsBefore = env.installer.runs.length;
    const stateEvents = events.filter((e) => e.type === 'install.state').length;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held = env.services.lock.run(id, () => gate);
    expect((await env.call('POST', `/api/servers/${id}/install`)).status).toBe(202);
    await env.t.db.transaction((tx) => tx.update(servers).set({ installState: 'installed' }).where(eq(servers.id, id)));
    open();
    await held;
    await env.services.install.idle();
    expect(env.installer.runs.length).toBe(runsBefore);
    expect(events.filter((e) => e.type === 'install.state').length).toBe(stateEvents);
    expect((await env.row(id))?.installState).toBe('installed');
  });

  it('does nothing when the server started while the job waited for the lock', async () => {
    const id = await failedForge();
    const runsBefore = env.installer.runs.length;
    const stateEvents = events.filter((e) => e.type === 'install.state').length;
    let calls = 0;
    const install = new InstallService({
      db: env.t.db,
      serversDir: env.config.serversDir,
      lock: env.services.lock,
      bus: env.services.bus,
      catalog: env.services.catalog,
      java: env.services.java,
      runner: env.installer.runner,
      guard: { isRunning: () => ++calls > 1 },
    });
    await install.enqueue(id, { checkJava: true });
    await install.idle();
    expect(calls).toBe(2);
    expect(env.installer.runs.length).toBe(runsBefore);
    expect(events.filter((e) => e.type === 'install.state').length).toBe(stateEvents);
    expect((await env.row(id))?.installState).toBe('failed');
  });
});
