import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { JavaInstallResponse, SystemInfo } from '../src/contract.js';
import { FakeAdoptium, fakeProbe, managedKit, type ManagedKit } from './fake-adoptium.js';
import { FakeModrinth } from './fake-modrinth.js';
import { createTestDb, testConfig } from './helpers.js';
import { ServerEnv, waitFor } from './server-env.js';

interface ErrorBody {
  error: { code: string; message: string; details?: { servers?: Array<{ id: string; name: string }> } };
}
interface RuntimesBody {
  runtimes: Array<{ major: number; source: string; origin: string | null }>;
  managed: Array<{ major: number; image: string; inUseBy: string[]; origin: string }>;
  installs: unknown[];
  autoInstall: boolean;
}

let env: ServerEnv;
let kit: ManagedKit;

beforeEach(async () => {
  env = await ServerEnv.create({
    javaService: (dataDir) => {
      kit = managedKit(dataDir, { platform: 'win32', arch: 'x64' });
      return kit.java;
    },
  });
  for (const major of [17, 21]) kit.adoptium.add({ major, os: 'windows', arch: 'x64', image: 'jre' });
});
afterEach(async () => {
  await env.close();
});

describe('GET /api/system', () => {
  it('explains the origin of managed runtimes and reports the automatic installation', async () => {
    await kit.java.ensureManaged(21);
    const res = await env.call<SystemInfo>('GET', '/api/system?rescan=true');
    expect(res.status).toBe(200);
    expect(res.body.javaAutoInstall).toBe(true);
    expect(res.body.javaInstalls).toEqual([]);
    const runtime = res.body.javaRuntimes.find((entry) => entry.source === 'managed');
    expect(runtime?.origin).toContain('by WorldFoundry');
    expect(runtime?.origin).toContain('Eclipse Temurin');
    expect(res.body.managedJava).toHaveLength(1);
    expect(res.body.managedJava[0]).toMatchObject({ major: 21, image: 'jre', inUseBy: [] });
    expect(res.body.managedJava[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lists installations that are in progress', async () => {
    kit.adoptium.hang = true;
    const pending = kit.java.ensureManaged(21).catch((error: unknown) => error);
    const info = await waitFor(async () => {
      const res = await env.call<SystemInfo>('GET', '/api/system');
      return res.body.javaInstalls.length > 0 ? res.body : undefined;
    }, 3000, 'running installation');
    expect(info.javaInstalls[0]).toMatchObject({ major: 21 });
    kit.managed.shutdown();
    await pending;
  });
});

describe('/api/java/runtimes', () => {
  it('lists, installs (idempotently) and removes managed runtimes', async () => {
    const empty = await env.call<RuntimesBody>('GET', '/api/java/runtimes');
    expect(empty.body).toMatchObject({ runtimes: [], managed: [], autoInstall: true });

    const first = await env.call<JavaInstallResponse>('POST', '/api/java/runtimes/21/install');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ alreadyInstalled: false, runtime: { major: 21, source: 'managed' } });
    const again = await env.call<JavaInstallResponse>('POST', '/api/java/runtimes/21/install');
    expect(again.body.alreadyInstalled).toBe(true);
    expect(kit.adoptium.requests.filter((request) => request.includes('release-assets'))).toHaveLength(1);

    const list = await env.call<RuntimesBody>('GET', '/api/java/runtimes?rescan=true');
    expect(list.body.managed.map((entry) => entry.major)).toEqual([21]);
    expect(list.body.runtimes.map((entry) => entry.source)).toEqual(['managed']);

    const removed = await env.call('DELETE', '/api/java/runtimes/21');
    expect(removed.status).toBe(200);
    expect((await env.call<RuntimesBody>('GET', '/api/java/runtimes')).body.managed).toEqual([]);
    expect((await env.call<ErrorBody>('DELETE', '/api/java/runtimes/21')).body.error.code).toBe('JAVA_RUNTIME_NOT_FOUND');
  });

  it('refuses to remove a runtime a running server uses and allows it afterwards', async () => {
    const server = await env.addServer({ name: 'Survival' });
    await env.call('POST', `/api/servers/${server.id}/start`);
    await env.waitState(server.id, 'online', 15_000);
    const refused = await env.call<ErrorBody>('DELETE', '/api/java/runtimes/21');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('JAVA_IN_USE');
    expect(refused.body.error.message).toContain('Survival');
    expect(refused.body.error.details?.servers?.[0]?.id).toBe(server.id);
    const listed = await env.call<RuntimesBody>('GET', '/api/java/runtimes');
    expect(listed.body.managed[0]?.inUseBy).toEqual([server.id]);

    await env.call('POST', `/api/servers/${server.id}/stop`);
    await env.waitState(server.id, 'offline', 15_000);
    expect((await env.call('DELETE', '/api/java/runtimes/21')).status).toBe(200);
  });

  it('validates the major and reports failures with a message', async () => {
    expect((await env.call<ErrorBody>('POST', '/api/java/runtimes/3/install')).body.error.code).toBe('VALIDATION_ERROR');
    expect((await env.call<ErrorBody>('POST', '/api/java/runtimes/abc/install')).status).toBe(400);
    const missing = await env.call<ErrorBody>('POST', '/api/java/runtimes/40/install');
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('JAVA_NOT_AVAILABLE');
    expect(missing.body.error.message).toContain('does not offer Java 40');
  });

  it('shares one install between two requests', async () => {
    kit.adoptium.downloadDelayMs = 150;
    const [a, b] = await Promise.all([env.call<JavaInstallResponse>('POST', '/api/java/runtimes/21/install'), env.call<JavaInstallResponse>('POST', '/api/java/runtimes/21/install')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(kit.adoptium.requests.filter((request) => request.includes('release-assets'))).toHaveLength(1);
  });
});

describe('without a managed-runtime installer', () => {
  it('rejects install requests', async () => {
    await env.close();
    env = await ServerEnv.create();
    const res = await env.call<ErrorBody>('POST', '/api/java/runtimes/21/install');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('JAVA_INSTALL_UNAVAILABLE');
    const system = await env.call<SystemInfo>('GET', '/api/system');
    expect(system.body.javaAutoInstall).toBe(false);
    expect(system.body.managedJava).toEqual([]);
  });
});

describe('default wiring of the application', () => {
  it('builds the managed-runtime installer from DATA_DIR and JAVA_AUTO_INSTALL', async () => {
    const t = await createTestDb();
    const adoptium = new FakeAdoptium();
    adoptium.add({ major: 21, os: 'windows', arch: 'x64', image: 'jre' });
    const app = buildApp({
      db: t.db,
      config: { ...testConfig(t.dir), javaAutoInstall: true },
      modrinth: new FakeModrinth().api(),
      fetch: adoptium.fetch,
      javaProbe: fakeProbe,
      javaStandardRoots: [],
      platform: 'win32',
    });
    await app.ready();
    try {
      const system = await app.inject({ method: 'GET', url: '/api/system' });
      expect((JSON.parse(system.body) as SystemInfo).javaAutoInstall).toBe(true);
      const installed = await app.inject({ method: 'POST', url: '/api/java/runtimes/21/install' });
      expect(installed.statusCode).toBe(200);
      const runtime = (JSON.parse(installed.body) as JavaInstallResponse).runtime;
      expect(runtime.path.startsWith(testConfig(t.dir).dataDir)).toBe(true);
      expect(runtime.path).toContain('runtimes');
    } finally {
      await app.close();
      await t.cleanup();
    }
  });

  it('JAVA_AUTO_INSTALL=false disables only the automatic part; the manual action stays', async () => {
    const t = await createTestDb();
    const adoptium = new FakeAdoptium();
    adoptium.add({ major: 21, os: 'windows', arch: 'x64', image: 'jre' });
    const app = buildApp({
      db: t.db,
      config: { ...testConfig(t.dir), javaAutoInstall: false },
      modrinth: new FakeModrinth().api(),
      fetch: adoptium.fetch,
      javaProbe: fakeProbe,
      javaStandardRoots: [],
      platform: 'win32',
    });
    await app.ready();
    try {
      expect((JSON.parse((await app.inject({ method: 'GET', url: '/api/system' })).body) as SystemInfo).javaAutoInstall).toBe(false);
      expect((await app.inject({ method: 'POST', url: '/api/java/runtimes/21/install' })).statusCode).toBe(200);
    } finally {
      await app.close();
      await t.cleanup();
      await rm(t.dir, { recursive: true, force: true });
    }
  });
});
