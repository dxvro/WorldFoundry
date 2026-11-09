import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '../src/events/bus.js';
import { FakeAdoptium, managedKit, type ManagedKit } from './fake-adoptium.js';
import { ServerEnv, wait, waitFor } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string };
}
interface StartBody {
  status: { state: string; message: string | null; messageRef: { key: string; params?: Record<string, unknown> } | null };
  warnings: string[];
}

let env: ServerEnv;
let kit: ManagedKit;
let events: AppEvent[];

async function setup(autoInstall = true, adoptium = new FakeAdoptium(), seed = true): Promise<void> {
  env = await ServerEnv.create({
    javaService: (dataDir) => {
      kit = managedKit(dataDir, { platform: 'win32', arch: 'x64', autoInstall, adoptium });
      return kit.java;
    },
  });
  events = [];
  env.services.bus.subscribe((event) => events.push(event));
  if (seed) for (const major of [8, 17, 21, 25]) kit.adoptium.add({ major, os: 'windows', arch: 'x64', image: 'jre' });
}

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await env.close();
});

const start = (id: string) => env.call<StartBody & ErrorBody>('POST', `/api/servers/${id}/start`);
const lines = (id: string): string[] => env.services.manager.history(id).map((line) => line.text);
const runtimes = async (): Promise<string[]> => (await readdir(kit.dir).catch(() => [])).sort();

describe('start with a missing Java runtime', () => {
  it('answers at once with the new "preparing" state, installs in the background, then starts', async () => {
    kit.adoptium.downloadDelayMs = 300;
    const server = await env.addServer();
    // answering with 'preparing' while nothing has been spawned yet proves the call did not wait for the download
    const res = await start(server.id);
    expect(res.status).toBe(200);
    expect(res.body.status.state).toBe('preparing');
    expect(res.body.status.message).toContain('Installing Java 21');
    expect(res.body.status.messageRef).toEqual({ key: 'JAVA_INSTALLING', params: { major: 21 } });
    expect(env.spawner.calls).toHaveLength(0);
    expect(env.services.manager.isRunning(server.id)).toBe(true);

    const online = await env.waitState(server.id, 'online', 15_000);
    expect(online.pid).not.toBeNull();
    const texts = lines(server.id);
    expect(texts.some((text) => text.includes('Java 21 is not installed and will now be installed automatically'))).toBe(true);
    expect(texts.some((text) => text.includes('Downloading Java 21'))).toBe(true);
    expect(texts.some((text) => text.includes('Java 21 is installed. Starting the server'))).toBe(true);
    expect(texts.some((text) => text.startsWith('Starting the server (Java 21'))).toBe(true);
    // the system lines carry their keys, so a client can show them in its own language
    const refs = env.services.manager.history(server.id).flatMap((line) => (line.textRef === undefined ? [] : [line.textRef]));
    expect(refs.map((ref) => ref.key)).toEqual(expect.arrayContaining(['JAVA_AUTO_INSTALL_NOTICE', 'JAVA_STEP_DOWNLOAD', 'JAVA_INSTALLED_STARTING', 'SERVER_STARTING']));
    expect(refs.find((ref) => ref.key === 'JAVA_AUTO_INSTALL_NOTICE')?.params).toEqual({ major: 21 });
    expect(env.services.manager.history(server.id).find((line) => line.stream === 'stdout')?.textRef).toBeUndefined();

    const states = events.filter((e) => e.type === 'server.status').map((e) => (e.type === 'server.status' ? e.status.state : ''));
    expect(states.indexOf('preparing')).toBeGreaterThanOrEqual(0);
    expect(states.indexOf('preparing')).toBeLessThan(states.indexOf('starting'));
    expect(states.indexOf('starting')).toBeLessThan(states.indexOf('online'));
    const install = events.filter((e) => e.type === 'java.install');
    expect(install.some((e) => e.type === 'java.install' && e.state === 'running' && e.phase === 'download')).toBe(true);
    expect(install.at(-1)).toMatchObject({ type: 'java.install', major: 21, state: 'done' });

    const managed = (await kit.managed.list())[0];
    expect(env.spawner.calls[0]?.command).toBe(managed?.javaPath);
  });

  it('shows download progress in the server status while preparing', async () => {
    kit.adoptium.downloadDelayMs = 400;
    const server = await env.addServer();
    await start(server.id);
    const status = await waitFor(() => {
      const current = env.services.manager.status(server.id);
      return /\(\d+ %\)/.test(current.message ?? '') ? current : undefined;
    }, 5000, 'progress in the message');
    expect(status.state).toBe('preparing');
    await env.waitState(server.id, 'online', 15_000);
  });

  it('refuses a second start, mod changes and deletion while the server prepares', async () => {
    kit.adoptium.hang = true;
    const server = await env.addServer({ loader: 'fabric' });
    await start(server.id);
    expect((await start(server.id)).body.error.code).toBe('SERVER_ALREADY_RUNNING');
    expect((await env.call<ErrorBody>('DELETE', `/api/servers/${server.id}?confirm=true`)).body.error.code).toBe('SERVER_RUNNING');
    expect((await env.call<ErrorBody>('POST', `/api/servers/${server.id}/mods`, { projectId: 'x' })).body.error.code).toBe('SERVER_RUNNING');
    expect((await env.call<ErrorBody>('POST', `/api/servers/${server.id}/command`, { command: 'list' })).body.error.code).toBe('SERVER_NOT_RUNNING');
  });

  it('stop during the installation cancels it: no process, no runtime, state offline', async () => {
    kit.adoptium.hang = true;
    const server = await env.addServer();
    await start(server.id);
    await wait(80);
    const res = await env.call<{ status: { state: string } }>('POST', `/api/servers/${server.id}/stop`);
    expect(res.status).toBe(200);
    expect((await env.status(server.id)).state).toBe('offline');
    expect((await env.status(server.id)).message).toBeNull();
    expect(lines(server.id).some((text) => text.includes('Start cancelled'))).toBe(true);
    await waitFor(() => !kit.managed.isInstalling(21), 3000, 'cancellation of the installation');
    expect(await runtimes()).toEqual([]);
    expect(env.spawner.calls).toHaveLength(0);
    // the server can be started again afterwards
    kit.adoptium.hang = false;
    expect((await start(server.id)).body.status.state).toBe('preparing');
    await env.waitState(server.id, 'online', 15_000);
  });

  it('kill during the installation behaves like stop', async () => {
    kit.adoptium.hang = true;
    const server = await env.addServer();
    await start(server.id);
    await wait(50);
    expect((await env.call('POST', `/api/servers/${server.id}/kill`)).status).toBe(200);
    expect((await env.status(server.id)).state).toBe('offline');
    await waitFor(() => !kit.managed.isInstalling(21), 3000, 'cancellation of the installation');
    expect(env.spawner.calls).toHaveLength(0);
  });

  it('keeps the download for another server when one of two cancels', async () => {
    kit.adoptium.downloadDelayMs = 400;
    const a = await env.addServer({ name: 'A' });
    const b = await env.addServer({ name: 'B' });
    await start(a.id);
    await start(b.id);
    await wait(60);
    await env.call('POST', `/api/servers/${a.id}/stop`);
    expect((await env.status(a.id)).state).toBe('offline');
    await env.waitState(b.id, 'online', 15_000);
    expect(kit.adoptium.requests.filter((request) => request.includes('release-assets'))).toHaveLength(1);
    expect(env.spawner.calls).toHaveLength(1);
  });

  it('two servers needing the same major share one download and both start', async () => {
    kit.adoptium.downloadDelayMs = 200;
    const a = await env.addServer({ name: 'A' });
    const b = await env.addServer({ name: 'B' });
    await Promise.all([start(a.id), start(b.id)]);
    await Promise.all([env.waitState(a.id, 'online', 15_000), env.waitState(b.id, 'online', 15_000)]);
    expect(kit.adoptium.requests.filter((request) => request.includes('release-assets'))).toHaveLength(1);
    expect(kit.adoptium.requests.filter((request) => request.includes('api.adoptium.net'))).toHaveLength(1);
  });

  it('restart while preparing cancels and prepares again', async () => {
    kit.adoptium.hang = true;
    const server = await env.addServer();
    await start(server.id);
    await wait(50);
    kit.adoptium.hang = false;
    const res = await env.call<StartBody>('POST', `/api/servers/${server.id}/restart`);
    expect(res.status).toBe(200);
    await env.waitState(server.id, 'online', 15_000);
  });

  it('application shutdown during the installation aborts it and removes staging files', async () => {
    kit.adoptium.hang = true;
    const server = await env.addServer();
    await start(server.id);
    await wait(80);
    await env.services.manager.shutdown(2000);
    expect((await env.status(server.id)).state).toBe('offline');
    await waitFor(() => !kit.managed.isInstalling(21), 3000, 'cancellation of the installation');
    expect(await runtimes()).toEqual([]);
  });

  it('shows a failed download as readable error and the crashed state, and recovers on retry', async () => {
    kit.adoptium.tamper = true;
    const server = await env.addServer();
    await start(server.id);
    const status = await env.waitState(server.id, 'crashed', 15_000);
    expect(status.message).toContain('checksum');
    expect(lines(server.id).some((text) => text.startsWith('The server could not be started: '))).toBe(true);
    expect(env.spawner.calls).toHaveLength(0);
    expect(await runtimes()).toEqual([]);
    expect(env.services.manager.isRunning(server.id)).toBe(false);

    kit.adoptium.tamper = false;
    await start(server.id);
    await env.waitState(server.id, 'online', 15_000);
  });

  it('reports a start problem that appears after the installation (port in use) as the failure message', async () => {
    const first = await env.addServer({ name: 'First' });
    await start(first.id);
    await env.waitState(first.id, 'online', 15_000);
    // needs Java 8 (old Forge), which is still missing, and wants the port the first server holds
    const clash = await env.addServer({ name: 'Clash', loader: 'forge', mcVersion: '1.12.2', requiredJavaMajor: 8, port: first.port });
    expect((await start(clash.id)).body.status.state).toBe('preparing');
    const status = await env.waitState(clash.id, 'crashed', 15_000);
    expect(status.message).toContain('Port');
    expect(status.message).toContain('First');
    expect(env.services.manager.isRunning(clash.id)).toBe(false);
  });

  it('reports a missing build for this platform as the failure message', async () => {
    await env.close();
    await setup(true, new FakeAdoptium(), false);
    const server = await env.addServer();
    await start(server.id);
    const status = await env.waitState(server.id, 'crashed', 10_000);
    expect(status.message).toContain('does not offer Java 21');
  });
});

describe('switching automatic installation off', () => {
  beforeEach(async () => {
    await env.close();
    await setup(false);
  });

  it('keeps the classic error and installs nothing', async () => {
    const server = await env.addServer();
    const res = await start(server.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('JAVA_NOT_FOUND');
    expect(kit.adoptium.requests).toHaveLength(0);
    expect((await env.status(server.id)).state).toBe('offline');
  });

  it('keeps JAVA_VERSION_INCOMPATIBLE when only a smaller Java exists', async () => {
    await kit.managed.ensure(17);
    const server = await env.addServer();
    const res = await start(server.id);
    expect(res.body.error.code).toBe('JAVA_VERSION_INCOMPATIBLE');
  });
});

describe('choosing the major for different servers', () => {
  it('installs the version the server needs and respects the bound of old Forge', async () => {
    const old = await env.addServer({ loader: 'forge', mcVersion: '1.12.2', requiredJavaMajor: 8 });
    await start(old.id);
    await env.waitState(old.id, 'online', 15_000);
    expect(old.id).toBeDefined();
    expect((await kit.managed.list()).map((info) => info.major)).toEqual([8]);

    const sixteen = await env.addServer({ mcVersion: '1.17.1', requiredJavaMajor: 16 });
    await start(sixteen.id);
    await env.waitState(sixteen.id, 'online', 15_000);
    expect((await kit.managed.list()).map((info) => info.major)).toEqual([8, 17]);

    const modern = await env.addServer({ mcVersion: '26.1', requiredJavaMajor: 25 });
    await start(modern.id);
    await env.waitState(modern.id, 'online', 15_000);
    expect((await kit.managed.list()).map((info) => info.major)).toEqual([8, 17, 25]);
  });

  it('does not install when the server has its own Java path', async () => {
    const server = await env.addServer({ javaPath: path.join(env.config.dataDir, 'nowhere', 'java.exe') });
    const res = await start(server.id);
    expect(res.body.error.code).toBe('JAVA_NOT_FOUND');
    expect(kit.adoptium.requests).toHaveLength(0);
  });
});

describe('installer jobs (Forge/NeoForge) with a missing Java', () => {
  it('installs Java inside the install job, shows it in progress and log, and runs the installer with it', async () => {
    const res = await env.call<{ server: { id: string } }>('POST', '/api/servers', { name: 'Neo', loader: 'neoforge', mcVersion: '1.21.1' });
    expect(res.status).toBe(201);
    const id = res.body.server.id;
    await env.services.install.idle();
    const server = await env.row(id);
    expect(server?.installState).toBe('installed');
    const managed = (await kit.managed.list())[0];
    expect(env.installer.runs[0]?.javaPath).toBe(managed?.javaPath);
    expect(events.some((e) => e.type === 'install.progress' && e.phase === 'java')).toBe(true);
    const log = await readFile(path.join(env.serverDir(id), 'install.log'), 'utf8');
    expect(log).toContain('Querying Java 21 at Adoptium');
    expect(log).toContain('Using Java 21');
  });

  it('fails the install with a readable message when the runtime cannot be installed', async () => {
    kit.adoptium.tamper = true;
    const res = await env.call<{ server: { id: string } }>('POST', '/api/servers', { name: 'Neo', loader: 'neoforge', mcVersion: '1.21.1' });
    await env.services.install.idle();
    const server = await env.row(res.body.server.id);
    expect(server?.installState).toBe('failed');
    expect(server?.installError).toContain('checksum');
    expect(env.installer.runs).toHaveLength(0);
  });

  it('with automatic installation off, the install request is refused like before', async () => {
    await env.close();
    await setup(false);
    const created = await env.call<{ server: { id: string } }>('POST', '/api/servers', { name: 'Neo', loader: 'neoforge', mcVersion: '1.21.1' });
    await env.services.install.idle();
    expect((await env.row(created.body.server.id))?.installState).toBe('failed');
    const retry = await env.call<ErrorBody>('POST', `/api/servers/${created.body.server.id}/install`);
    expect(retry.status).toBe(422);
    expect(retry.body.error.code).toBe('JAVA_NOT_FOUND');
  });
});
